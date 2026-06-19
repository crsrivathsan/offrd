// ════════════════════════════════════════════════════════════════════
// offrd-app.js — shared logic across upload.html, search.html, results.html
//
// State (S) is handed off between pages via sessionStorage. Each page is
// responsible for calling persistState() before navigating away, and
// loadState() on its own init.
// ════════════════════════════════════════════════════════════════════

const S = {
  apiBase: 'https://api.offrd.net',
  alertEmail: 'crsrivathsan@gmail.com',
  appVersion: '1.0.0',
  resumeText: '',
  resumeBase64: null,
  resumeMime: null,
  resumeFileName: '',
  parsedProfile: null,
  jobs: [],
  selectedJob: null,
  weights: { relevancy: 0, seniority: 0, competition: 0, salary: 0 },
  searchLimit: { remaining: null, limit: 10, unlimited: false },
  pipeline: { saved: [], applied: [], interview: [], offer: [] },
  searchHistory: [],
  isLiveData: false,
  tailoredResumes: {},
  selectedLocations: []
};

// Fields that are safe and useful to hand off between pages. Resume
// base64 can be large, but it's needed on results.html for tailoring —
// sessionStorage has a few MB of headroom which is enough for resumes.
const HANDOFF_KEYS = [
  'resumeText', 'resumeBase64', 'resumeMime', 'resumeFileName',
  'parsedProfile', 'jobs', 'weights', 'isLiveData', 'tailoredResumes'
];

function persistState() {
  try {
    const payload = {};
    HANDOFF_KEYS.forEach(k => { payload[k] = S[k]; });
    sessionStorage.setItem('offrd_state', JSON.stringify(payload));
  } catch (e) {
    console.warn('[Offrd] Could not persist state:', e.message);
  }
}

function loadState() {
  try {
    const raw = sessionStorage.getItem('offrd_state');
    if (!raw) return false;
    const payload = JSON.parse(raw);
    HANDOFF_KEYS.forEach(k => { if (payload[k] !== undefined) S[k] = payload[k]; });
    return true;
  } catch (e) {
    console.warn('[Offrd] Could not load state:', e.message);
    return false;
  }
}

// ─── Shared Init ────────────────────────────────────────────────────────
// Call this once from each page's own inline script, after the page's
// own DOM-specific setup. Safe to call even if some elements (nav user
// name, logout button, onboarding widget) aren't present on every page.
function offrdSharedInit() {
  try {
    const userData = sessionStorage.getItem('offrd_user');
    if (userData) {
      const user = JSON.parse(userData);
      const nameEl = document.getElementById('nav-user-name');
      const logoutBtn = document.getElementById('logoutBtn');
      if (nameEl) {
        const displayName = user.name?.split(' ')[0] || user.email?.split('@')[0] || '';
        nameEl.textContent = '👤 ' + displayName;
        nameEl.style.display = 'inline';
      }
      if (logoutBtn) logoutBtn.style.display = 'inline-flex';
    }
  } catch (e) {}

  refreshSearchLimit();

  const pipe = localStorage.getItem('offrd_pipeline');
  if (pipe) { try { S.pipeline = JSON.parse(pipe); } catch(e) {} }
  const hist = localStorage.getItem('offrd_history');
  if (hist) { try { S.searchHistory = JSON.parse(hist); } catch(e) {} }
  const theme = localStorage.getItem('offrd_theme');
  if (theme === 'light') document.body.classList.add('light');

  updateApiStatus();
  updateOnboarding();
  if (typeof updatePipelineBadge === 'function') updatePipelineBadge();
}

// Returns the Supabase access token stored at sign-in, or '' if missing.
// Sent as a Bearer token so the Worker can verify who's calling.
function getAccessToken() {
  try {
    return JSON.parse(sessionStorage.getItem('offrd_user') || '{}').accessToken || '';
  } catch(e) { return ''; }
}

// Pulls the current search-limit status from the Worker and updates the
// badge in the nav. Safe to call any time — does not consume a search.
async function refreshSearchLimit() {
  try {
    const res = await fetch(S.apiBase + '/api/search-limit', {
      headers: { 'Authorization': 'Bearer ' + getAccessToken() }
    });
    if (!res.ok) throw new Error('limit check failed');
    const data = await res.json();
    S.searchLimit = { remaining: data.remaining, limit: data.limit, unlimited: data.unlimited };
  } catch(e) {
    S.searchLimit = { remaining: null, limit: 10, unlimited: false };
  }
  updateSearchCounter();
}

function updateSearchCounter() {
  const badge = document.getElementById('searchCounter');
  if (!badge) return;
  if (S.searchLimit.unlimited) {
    badge.innerHTML = '<span style="color:var(--green);">Unlimited searches</span>';
    return;
  }
  const remaining = S.searchLimit.remaining;
  if (remaining === null) {
    badge.innerHTML = `${S.searchLimit.limit} searches available`;
    return;
  }
  const col = remaining === 0 ? 'var(--red,#f87171)' : remaining <= 3 ? 'var(--amber,#f59e0b)' : 'var(--purple2)';
  badge.innerHTML = `<span style="color:${col}">${remaining} of ${S.searchLimit.limit} searches left</span>`;
}

function showSearchLimitReached() {
  const titleEl = document.getElementById('upgradeTitle');
  const msgEl = document.getElementById('upgradeMsg');
  const iconEl = document.getElementById('upgradeIcon');
  if (titleEl) titleEl.textContent = "You've used all your searches";
  if (msgEl) msgEl.textContent = `You've used all ${S.searchLimit.limit} of your searches on Offrd. Thanks for trying it out!`;
  if (iconEl) iconEl.textContent = '🔍';
  const banner = document.getElementById('limitBanner');
  if (banner) banner.style.display = 'flex';
  offrdTrack('search_limit_reached', {});
}

function updateApiStatus() {
  const el = document.getElementById('apiStatus');
  if (el) el.innerHTML = '<span class="status-dot green"></span>Ready';
}

function updateOnboarding() {
  const hasResume = !!S.parsedProfile;
  const hasSearch = S.searchHistory.length > 0;
  const hasApplied = ((S.pipeline.applied?.length || 0) + (S.pipeline.interview?.length || 0) + (S.pipeline.offer?.length || 0)) > 0;
  const items = [
    { id: 'ob1', done: hasResume },
    { id: 'ob2', done: hasSearch },
    { id: 'ob3', done: hasApplied }
  ];
  let allDone = true;
  items.forEach(item => {
    const el = document.getElementById(item.id);
    if (!el) return;
    if (item.done) { el.classList.add('done'); const c = el.querySelector('.onboard-check'); if (c) c.textContent = '✓'; }
    else { allDone = false; if (!el.classList.contains('done')) el.classList.add('active'); }
  });
  const wrap = document.getElementById('onboardWrap');
  if (wrap && allDone) wrap.style.display = 'none';
}

// ─── Modals (Help / About) ───────────────────────────────────────────
function openHelp() { document.getElementById('helpModal')?.classList.add('open'); }
function closeHelp() { document.getElementById('helpModal')?.classList.remove('open'); }
function openAbout() { document.getElementById('aboutModal')?.classList.add('open'); }
function closeAbout() { document.getElementById('aboutModal')?.classList.remove('open'); }

document.addEventListener('click', e => {
  if (e.target.id === 'helpModal') closeHelp();
  if (e.target.id === 'aboutModal') closeAbout();
});

function toggleTheme() {
  document.body.classList.toggle('light');
  localStorage.setItem('offrd_theme', document.body.classList.contains('light') ? 'light' : 'dark');
}

async function logoutUser() {
  if (!confirm('Sign out of Offrd?')) return;
  offrdTrack('sign_out', {});
  
  // Set flag to prevent auto-redirects during logout
  localStorage.setItem('offrd_logging_out', 'true');
  
  try {
    // Sign out from Supabase explicitly
    if (window.sbClient) {
      await window.sbClient.auth.signOut();
    }
  } catch(e) {
    console.warn('[Offrd] Supabase signOut failed:', e.message);
  }
  
  // Clear all Supabase-related storage
  try {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.includes('sb-') || key.includes('supabase') || key.includes('auth')) {
        localStorage.removeItem(key);
      }
    });
  } catch(e) {}
  
  // Clear app-specific storage
  try {
    sessionStorage.removeItem('offrd_user');
    sessionStorage.removeItem('offrd_state');
    localStorage.removeItem('offrd_user');
    localStorage.removeItem('offrd_pipeline');
    localStorage.removeItem('offrd_history');
    localStorage.removeItem('offrd_theme');
    localStorage.removeItem('offrd_consent');
  } catch(e) {}
  
  // Small delay to ensure storage is cleared before redirect
  setTimeout(() => {
    localStorage.removeItem('offrd_logging_out');
    window.location.href = '/index.html';
  }, 100);
}

// ─── Progress Bar ────────────────────────────────────────────────────
let progressTimers = {};

function showProgress(containerId, stages, activeIdx) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.style.display = 'block';
  const stage = stages[activeIdx] || stages[stages.length - 1];
  const pct = stage.pct;

  if (!progressTimers[containerId]) progressTimers[containerId] = { current: 0 };
  progressTimers[containerId].target = pct;

  const stepsHtml = stages.map((s, i) => {
    const cls = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
    return `<div class="progress-step ${cls}"><div class="ps-dot"></div><span>${s.label}</span></div>`;
  }).join('');

  el.innerHTML = `
    <div class="progress-wrap">
      <div class="progress-header">
        <span class="progress-stage">${stage.label}</span>
        <span class="progress-pct" id="${containerId}-pct">${pct}%</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" id="${containerId}-fill" style="width:${pct}%"></div>
      </div>
      <div class="progress-steps">${stepsHtml}</div>
    </div>`;
}

function hideProgress(containerId) {
  const el = document.getElementById(containerId);
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  delete progressTimers[containerId];
}

// ─── API Failure Alert System ─────────────────────────────────────────
const _apiErrors = {};

async function reportAPIFailure(service, errorCode, errorMsg, context = {}) {
  const key = `${service}_${errorCode}`;
  const now = Date.now();

  if (_apiErrors[key] && (now - _apiErrors[key]) < 30 * 60 * 1000) return;
  _apiErrors[key] = now;

  offrdTrack('api_failure', {
    service,
    error_code: String(errorCode),
    error_msg: errorMsg.slice(0, 100)
  });

  const statusEl = document.getElementById('jobStatus');
  if (statusEl && service !== 'anthropic_score' && typeof updateJobStatus === 'function') {
    updateJobStatus(
      `⚠ ${getServiceLabel(service)} is experiencing issues. Results may be limited. We've been notified.`,
      'warn'
    );
  }

  try {
    const payload = {
      service_id:  'EMAILJS_SERVICE_ID',
      template_id: 'EMAILJS_TEMPLATE_ID',
      user_id:     'EMAILJS_PUBLIC_KEY',
      template_params: {
        to_email:    S.alertEmail,
        subject:     `🚨 Offrd API Alert — ${getServiceLabel(service)} failure`,
        service:     getServiceLabel(service),
        error_code:  String(errorCode),
        error_msg:   errorMsg,
        context:     JSON.stringify(context),
        timestamp:   new Date().toISOString(),
        app_url:     window.location.href
      }
    };
    await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch(e) {
    console.warn('[Offrd Alert] Could not send alert email:', e.message);
  }
}

function getServiceLabel(service) {
  const labels = {
    anthropic_parse:  'Resume Parsing',
    anthropic_score:  'Job Scoring',
    anthropic_tailor: 'Resume Tailoring',
    anthropic_cover:  'Cover Letter Generation',
    jsearch:          'Job Search',
    adzuna:           'Job Search',
    supabase:         'Sign-in'
  };
  return labels[service] || 'Offrd';
}

function updatePipelineBadge() {
  const total = Object.values(S.pipeline).reduce((s,c) => s + c.length, 0);
  const badge = document.getElementById('pipelineBadge');
  if (badge) { badge.style.display = total > 0 ? 'inline' : 'none'; badge.textContent = total; }
}

function persistPipeline() {
  localStorage.setItem('offrd_pipeline', JSON.stringify(S.pipeline));
}
