// ════════════════════════════════════════════════════════════════════
// offrd-app.js — shared logic across upload.html, search.html, results.html
//
// State (S) is handed off between pages via sessionStorage. Each page is
// responsible for calling persistState() before navigating away, and
// loadState() on its own init.
// ════════════════════════════════════════════════════════════════════

// ─── Supabase Client ─────────────────────────────────────────────────
// index.html and app.html create their own Supabase client (needed for
// the sign-in/sign-up flow itself). upload.html, search.html, and
// results.html only ever load offrd-app.js — they never created a
// client of their own, which meant window.sbClient was undefined on
// every page a signed-in user actually spends time on, and the
// sign-out-on-tab-close logic below was silently a no-op there.
// Creating the client here, once, fixes that for all three pages.
// Requires <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2">
// to be loaded BEFORE this file on any page that wants window.sbClient.
if (typeof window.sbClient === 'undefined' && typeof supabase !== 'undefined') {
  try {
    const SUPABASE_URL = 'https://pfxbuqiqwpryvmrvrgfp.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmeGJ1cWlxd3ByeXZtcnZyZ2ZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMDI0MzcsImV4cCI6MjA5NjU3ODQzN30.u2kAmTyvX4KWcYWmr5dMrH4KYNmuusC8N4TJ6KxuFkM';
    window.sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    console.warn('[Offrd] Could not initialise Supabase client:', e.message);
  }
}

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

// ─── Internal Navigation Helper ─────────────────────────────────────
// Use this for ANY same-app page change (upload.html -> search.html etc).
// It sets a short-lived flag so the beforeunload handler below knows
// this is in-app navigation, not the user actually closing the tab —
// otherwise every page change would wipe sessionStorage and log the
// user out / lose their parsed resume and search results.
function offrdNavigate(url) {
  try { sessionStorage.setItem('offrd_navigating', 'true'); } catch (e) {}
  window.location.href = url;
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

// ─── Auth Guard ──────────────────────────────────────────────────────
// Call at the very top of each protected page's init (upload/search/
// results). If there's no signed-in user in sessionStorage, redirect
// to the login page immediately — before the page renders any content
// or the person can interact with it. Returns true if authenticated,
// false if it just redirected (caller should stop initializing).
function requireAuth() {
  try {
    const user = JSON.parse(sessionStorage.getItem('offrd_user') || 'null');
    if (user && user.id) return true;
  } catch (e) {}
  window.location.replace('/index.html');
  return false;
}

// ─── Fix Native Browser Back Button ─────────────────────────────────
// app.html (the post-login router) sometimes skips a user straight to
// search.html or results.html if they already have a resume parsed /
// jobs found from earlier in the session — it never visits upload.html
// or search.html itself, so those pages never end up in browser
// history. Without this, pressing the browser's own Back button (not
// our in-app "← Back" links, which already navigate correctly) has
// nothing to go to except index.html, dropping the user out of the
// app entirely instead of one step back.
//
// Fix: each protected page pushes a synthetic history entry for
// itself right after it loads, and listens for popstate (back/forward)
// to redirect to its correct "previous step" instead of relying on
// whatever the browser actually has in its real history stack.
const OFFRD_PREV_STEP = {
  'upload.html': null,        // first step — nothing before it
  'search.html': 'upload.html',
  'results.html': 'search.html'
};

function setupBackButtonFix() {
  const page = window.location.pathname.split('/').pop() || 'upload.html';
  const prevStep = OFFRD_PREV_STEP[page];
  if (!prevStep) return; // upload.html has no "previous" step to fix

  // Make sure there's an entry to go "back" to that we control.
  history.pushState({ offrdStep: page }, '', window.location.pathname + window.location.search);

  window.addEventListener('popstate', () => {
    offrdNavigate(prevStep);
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupBackButtonFix);
} else {
  setupBackButtonFix();
}

// Pulls the current search-limit status from the Worker and updates the
// badge in the nav. Safe to call any time — does not consume a search.
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

// ─── Sign Out on Window Close ──────────────────────────────────────
// When user actually closes the tab/window (not just navigates between
// Offrd pages), sign them out and clear session data.
//
// Two things make this tricky and both are handled below:
// 1. beforeunload fires on EVERY navigation, including links to
//    search.html/upload.html/results.html within the app — not just
//    real tab closes. We check the offrd_navigating flag (set by
//    offrdNavigate()) to skip those and only act on a genuine close.
// 2. beforeunload cannot reliably await async work like a network
//    sign-out call — the page tears down before it finishes. We clear
//    local session data synchronously (which is what actually keeps
//    the user logged in/out on this device) and fire-and-forget the
//    Supabase sign-out without awaiting it.
window.addEventListener('beforeunload', () => {
  const isInternalNav = sessionStorage.getItem('offrd_navigating') === 'true';
  if (isInternalNav) {
    // Clear the flag for the next page load, but don't log out.
    try { sessionStorage.removeItem('offrd_navigating'); } catch (e) {}
    return;
  }

  // Genuine tab/window close (or external navigation) — log out.
  // signOut() itself is async and may not finish before the page tears
  // down, so don't rely on it alone. Supabase persists its session in
  // localStorage under keys prefixed sb-<project-ref>-auth-token — wipe
  // those synchronously so the session can't be picked back up next
  // time the app loads, regardless of whether signOut's network call
  // completed.
  try {
    if (window.sbClient) {
      window.sbClient.auth.signOut(); // best-effort, not awaited
    }
  } catch (e) {}

  try {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('sb-') || key.includes('supabase')) {
        localStorage.removeItem(key);
      }
    });
  } catch (e) {}

  try {
    sessionStorage.clear();
  } catch (e) {}
});

// ─── Inactivity Timeout (30 minutes) ────────────────────────────────
// Log user out if no activity for 30 minutes
const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
const WARNING_TIME = 25 * 60 * 1000; // Show warning at 25 minutes
let inactivityTimer = null;
let warningTimer = null;
let lastActivityTime = Date.now();

function resetInactivityTimer() {
  // Clear existing timers
  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (warningTimer) clearTimeout(warningTimer);
  
  lastActivityTime = Date.now();
  
  // Hide warning if shown
  const warningEl = document.getElementById('inactivityWarning');
  if (warningEl) warningEl.style.display = 'none';
  
  // Set warning timer (55 minutes)
  warningTimer = setTimeout(() => {
    showInactivityWarning();
  }, WARNING_TIME);
  
  // Set logout timer (1 hour)
  inactivityTimer = setTimeout(() => {
    logoutDueToInactivity();
  }, INACTIVITY_TIMEOUT);
}

function showInactivityWarning() {
  // Create warning modal if it doesn't exist
  if (!document.getElementById('inactivityWarning')) {
    const warning = document.createElement('div');
    warning.id = 'inactivityWarning';
    warning.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #1a1a24;
      border: 1px solid #6c63ff;
      border-radius: 16px;
      padding: 32px;
      max-width: 400px;
      z-index: 9999;
      text-align: center;
      color: #e8e8f0;
      box-shadow: 0 24px 80px rgba(0,0,0,0.5);
    `;
    warning.innerHTML = `
      <div style="font-size: 24px; font-weight: 800; margin-bottom: 12px;">Your session expires soon</div>
      <p style="color: #8888a0; margin-bottom: 24px;">You'll be logged out in 5 minutes due to inactivity. Click below to stay logged in.</p>
      <button onclick="resetInactivityTimer()" style="
        background: #6c63ff;
        color: white;
        border: none;
        padding: 10px 24px;
        border-radius: 8px;
        font-weight: 600;
        cursor: pointer;
        font-size: 14px;
      ">Stay Logged In</button>
    `;
    document.body.appendChild(warning);
  }
  
  const warningEl = document.getElementById('inactivityWarning');
  warningEl.style.display = 'block';
}

async function logoutDueToInactivity() {
  try {
    if (window.sbClient) {
      await window.sbClient.auth.signOut();
    }
  } catch(e) {
    console.warn('[Offrd] Inactivity logout failed:', e.message);
  }
  
  try {
    sessionStorage.removeItem('offrd_user');
    sessionStorage.removeItem('offrd_state');
  } catch(e) {}
  
  // Show message and redirect
  alert('Your session has expired due to inactivity. Please sign in again.');
  window.location.href = '/index.html';
}

// Track user activity
function setupActivityTrackers() {
  const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
  
  events.forEach(event => {
    document.addEventListener(event, resetInactivityTimer, { passive: true });
  });
  
  // Start the initial timer
  resetInactivityTimer();
}

// Initialize when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupActivityTrackers);
} else {
  setupActivityTrackers();
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
