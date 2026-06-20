/**
 * Offrd API Gateway — Cloudflare Worker
 * 
 * Proxies all sensitive API calls so keys never reach the browser.
 * Deploy at: workers.cloudflare.com
 * 
 * Environment Variables to set in Cloudflare Dashboard:
 *   ANTHROPIC_KEY      — sk-ant-api03-...
 *   JSEARCH_KEY        — OpenWeb Ninja x-api-key
 *   ADZUNA_APP_ID      — from api.adzuna.com
 *   ADZUNA_APP_KEY     — from api.adzuna.com
 *   ALLOWED_ORIGIN     — https://offrd.net
 *   SUPABASE_URL       — https://pfxbuqiqwpryvmrvrgfp.supabase.co
 *   SUPABASE_SERVICE_KEY — service_role key (Supabase dashboard → Settings → API)
 *                          NOT the anon key — this one bypasses RLS so the
 *                          Worker can read/increment search counts server-side.
 */

// ────────────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  'https://offrd.net',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age':       '86400',
};

// ── Rate limiting store (per IP, resets per minute) ──────────────────
const rateLimitMap = new Map();

function checkRateLimit(ip, limit = 30) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const key = `${ip}`;
  
  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  
  const entry = rateLimitMap.get(key);
  if (now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

function corsResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function errorResponse(message, status = 400) {
  return corsResponse({ error: message }, status);
}

// ── Validate request origin ───────────────────────────────────────────
function validateOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || 'https://offrd.net';
  // Allow localhost for testing
  const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
  const isAllowed = origin === allowed || origin === `https://www.${allowed.replace('https://', '')}`;
  return isLocalhost || isAllowed;
}

// ════════════════════════════════════════════════════════════════════
// Search limit — backed by Supabase, keyed on the authenticated user
// ════════════════════════════════════════════════════════════════════

// Verify the Supabase access token sent by the frontend and return the
// user's id + email. Returns null if the token is missing or invalid —
// callers should treat that as "anonymous" and apply the strictest limit.
async function getAuthedUser(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;

  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': env.SUPABASE_SERVICE_KEY,
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user?.id || !user?.email) return null;
    return { id: user.id, email: user.email.toLowerCase() };
  } catch (err) {
    console.error('[auth] Supabase user lookup failed:', err);
    return null;
  }
}

// Reads the current lifetime search count for a user from Supabase.
// ════════════════════════════════════════════════════════════════════
// ROUTE: POST /api/parse — Resume parsing via Anthropic
// ════════════════════════════════════════════════════════════════════
async function handleParse(request, env, ip) {
  if (!checkRateLimit(`parse_${ip}`, 10)) {
    return errorResponse('Too many requests. Please try again in a minute.', 429);
  }

  const body = await request.json();
  const { messages, model = 'claude-sonnet-4-6', max_tokens = 2000 } = body;

  if (!messages || !Array.isArray(messages)) {
    return errorResponse('Invalid request — messages array required');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens, messages }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('[parse] Anthropic error:', data);
    return errorResponse(data.error?.message || 'AI parsing failed', response.status);
  }

  return corsResponse(data);
}

// ════════════════════════════════════════════════════════════════════
// ROUTE: POST /api/score — Job scoring via Anthropic Haiku
// ════════════════════════════════════════════════════════════════════
async function handleScore(request, env, ip) {
  if (!checkRateLimit(`score_${ip}`, 20)) {
    return errorResponse('Too many requests. Please try again in a minute.', 429);
  }

  const body = await request.json();
  const { messages, system, max_tokens = 8000 } = body;

  if (!messages) return errorResponse('Invalid request');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', // Cost-optimised for scoring
      max_tokens,
      system: system || 'Return ONLY valid JSON arrays. No markdown, no preamble.',
      messages,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('[score] Anthropic error:', data);
    return errorResponse(data.error?.message || 'AI scoring failed', response.status);
  }

  return corsResponse(data);
}

// ════════════════════════════════════════════════════════════════════
// ROUTE: POST /api/tailor — Resume tailoring via Anthropic Sonnet
// ════════════════════════════════════════════════════════════════════
async function handleTailor(request, env, ip) {
  if (!checkRateLimit(`tailor_${ip}`, 5)) {
    return errorResponse('Too many requests. Please try again in a minute.', 429);
  }

  const body = await request.json();
  const { messages, system, max_tokens = 8000 } = body;

  if (!messages) return errorResponse('Invalid request');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens,
      system: system || 'Return ONLY valid JSON. No markdown fences. No preamble.',
      messages,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('[tailor] Anthropic error:', data);
    return errorResponse(data.error?.message || 'AI tailoring failed', response.status);
  }

  return corsResponse(data);
}

// ════════════════════════════════════════════════════════════════════
// ROUTE: POST /api/cover — Cover letter via Anthropic Sonnet
// ════════════════════════════════════════════════════════════════════
async function handleCover(request, env, ip) {
  if (!checkRateLimit(`cover_${ip}`, 5)) {
    return errorResponse('Too many requests. Please try again in a minute.', 429);
  }

  const body = await request.json();
  const { messages, max_tokens = 1500 } = body;

  if (!messages) return errorResponse('Invalid request');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens,
      messages,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('[cover] Anthropic error:', data);
    return errorResponse(data.error?.message || 'Cover letter generation failed', response.status);
  }

  return corsResponse(data);
}

// ════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/search — Job search via JSearch + Adzuna
// ════════════════════════════════════════════════════════════════════
async function handleSearch(request, env, ip) {
  if (!checkRateLimit(`search_${ip}`, 15)) {
    return errorResponse('Too many requests. Please try again in a minute.', 429);
  }

  const url = new URL(request.url);
  const params = url.searchParams;

  const source   = params.get('source') || 'jsearch';
  const query    = params.get('query') || '';
  const num      = Math.min(parseInt(params.get('num') || '10'), 20);
  const page     = params.get('page') || '1';
  // Adzuna-specific
  const country  = params.get('country') || 'in';
  const where    = params.get('where') || '';

  if (!query) return errorResponse('query parameter required');

  if (source === 'jsearch') {
    const jsearchUrl = new URL('https://api.openwebninja.com/jsearch/search-v2');
    jsearchUrl.searchParams.set('query', query);
    jsearchUrl.searchParams.set('num_pages', '1');
    jsearchUrl.searchParams.set('page', page);
    jsearchUrl.searchParams.set('num', String(num));
    jsearchUrl.searchParams.set('date_posted', 'all');
    jsearchUrl.searchParams.set('employment_types', params.get('employment_types') || '');
    // JSearch's real filter is job_requirements (not experience_required,
    // which doesn't exist in their API) and it only accepts a small set
    // of fixed values: under_3_years_experience, more_than_3_years_experience,
    // no_experience, no_degree. There's no way to ask for a specific
    // seniority tier or year count directly — this is the coarsest
    // experience signal the API supports, so only set it when the
    // frontend sends one of those exact values.
    const jobRequirements = params.get('job_requirements') || '';
    if (jobRequirements) jsearchUrl.searchParams.set('job_requirements', jobRequirements);

    const response = await fetch(jsearchUrl.toString(), {
      headers: { 'x-api-key': env.JSEARCH_KEY },
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[search/jsearch] Error:', data);
      return errorResponse('Job search failed', response.status);
    }
    return corsResponse(data);
  }

  if (source === 'adzuna') {
    const adzunaUrl = new URL(
      `https://api.adzuna.com/v1/api/jobs/${country}/search/1`
    );
    adzunaUrl.searchParams.set('app_id',           env.ADZUNA_APP_ID);
    adzunaUrl.searchParams.set('app_key',          env.ADZUNA_APP_KEY);
    adzunaUrl.searchParams.set('what',             query);
    adzunaUrl.searchParams.set('where',            where);
    adzunaUrl.searchParams.set('results_per_page', String(num));
    adzunaUrl.searchParams.set('sort_by',          'date');

    const response = await fetch(adzunaUrl.toString());
    const data = await response.json();
    if (!response.ok) {
      console.error('[search/adzuna] Error:', data);
      return errorResponse('Adzuna search failed', response.status);
    }
    return corsResponse(data);
  }

  return errorResponse('Invalid source. Use jsearch or adzuna.');
}

// ════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/health — Health check
// ════════════════════════════════════════════════════════════════════
function handleHealth() {
  return corsResponse({
    status: 'ok',
    service: 'Offrd API Gateway',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
}

// ════════════════════════════════════════════════════════════════════
// MAIN ROUTER
// ════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

    // Validate origin for all non-health routes
    if (path !== '/api/health' && !validateOrigin(request, env)) {
      return errorResponse('Forbidden — invalid origin', 403);
    }

    try {
      // Route requests
      if (path === '/api/parse'  && request.method === 'POST') return handleParse(request, env, ip);
      if (path === '/api/score'  && request.method === 'POST') return handleScore(request, env, ip);
      if (path === '/api/tailor' && request.method === 'POST') return handleTailor(request, env, ip);
      if (path === '/api/cover'  && request.method === 'POST') return handleCover(request, env, ip);
      if (path === '/api/search' && request.method === 'GET')  return handleSearch(request, env, ip);
      if (path === '/api/health' && request.method === 'GET')  return handleHealth();

      return errorResponse('Not found', 404);

    } catch (err) {
      console.error('[worker] Unhandled error:', err);
      return errorResponse('Internal server error', 500);
    }
  },
};
