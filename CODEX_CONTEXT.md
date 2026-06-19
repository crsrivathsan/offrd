# Offrd — Context for Codex

You're picking up work on **Offrd** (offrd.net), an AI-powered job search SaaS. Architecture:
static frontend on GitHub Pages (vanilla HTML/CSS/JS, no framework, no build step) + a
Cloudflare Worker as an API gateway (holds all API keys server-side) + Supabase for auth and
a search-limit counter. Frontend never touches API keys directly — everything proxies through
the Worker.

## Files in this repo / drop (14 total)
```
index.html                       — landing + Supabase auth (sign up / sign in)
app.html                         — auth gate; verifies session, redirects into the app
upload.html                      — step 1: resume upload + AI parsing
search.html                      — step 2: search configuration
results.html                     — step 3: results, AI tailoring, cover letters, pipeline, history
offrd-app.js                     — shared JS loaded by upload/search/results.html (state, nav, modals)
offrd-shared.css                 — shared styles loaded by upload/search/results.html
worker.js                        — Cloudflare Worker (API gateway + search-limit enforcement)
wrangler.toml                    — Worker config; lists required secrets in comments
supabase_search_limit_setup.sql  — one-time SQL migration — RUN THIS IN SUPABASE if not done yet
privacy.html, terms.html         — legal pages (recently updated, no longer describe paid plans)
_redirects                       — Netlify-style file, INERT on GitHub Pages, kept only as a note
offrd-logo.svg                   — logo asset
```

## How state flows across pages
There is no SPA router. Each of `upload.html` / `search.html` / `results.html` is a real,
separate page. State (parsed resume, jobs, weights, etc.) is hashed through
`sessionStorage.offrd_state` via `persistState()` / `loadState()` defined in `offrd-app.js`.
Each page's own inline `<script>` calls `loadState()` then `offrdSharedInit()` on page load,
and calls `persistState()` right before navigating to the next page. Pipeline and search
history persist separately and longer-term in `localStorage` (`offrd_pipeline`, `offrd_history`)
since those should survive across browser sessions, unlike the per-flow resume/search state.

Auth session (`offrd_user` in `sessionStorage`) holds `{id, email, name, accessToken}`. The
`accessToken` is a Supabase JWT, sent as `Authorization: Bearer <token>` on every Worker call
that needs to know who the user is (currently just the search-limit endpoints).

## Worker endpoints (api.offrd.net)
```
POST /api/parse         — Sonnet, resume parsing (accepts resume as text OR base64 PDF document)
POST /api/score         — Haiku, job match scoring
POST /api/tailor        — Sonnet, 5-variant resume tailoring
POST /api/cover         — Sonnet, cover letter generation
POST /api/search-start  — consumes ONE search credit (call once per user search, before any board fetch)
GET  /api/search-limit  — reads remaining searches WITHOUT consuming one
GET  /api/search        — actual per-board job fetch (jsearch or adzuna via ?source=), NOT separately limited
GET  /api/health        — health check
```
All `/api/*` calls except search-limit/search-start are unauthenticated pass-throughs to
Anthropic/JSearch/Adzuna — the Worker holds the keys, frontend never sees them.

## Search limit model (current, working)
10 lifetime searches per user, enforced server-side in Supabase (table `profiles`,
column `search_count`, incremented via the `increment_search_count(uid)` RPC — see the
`.sql` file). Two emails are unlimited, hardcoded as a `Set` at the top of `worker.js`:
`crsrivathsan@gmail.com`, `kalpooallu@gmail.com`. `runJobSearch()` in `search.html` calls
`POST /api/search-start` exactly once per user-initiated search — that's where the credit is
spent — then proceeds to fetch all boards via the unmetered `/api/search`.

## CRITICAL — must check/fix before anything else works
**`SUPABASE_ANON_KEY` is still the literal placeholder string `'YOUR_SUPABASE_ANON_KEY'`** in
both `index.html` and `app.html`. Sign-in will not work at all until this is replaced with the
real anon/public key from the Supabase dashboard (Settings → API). Search for
`YOUR_SUPABASE_ANON_KEY` to find both occurrences. Unknown whether this was already fixed in
whatever is currently live at offrd.net — verify against the live site or Supabase dashboard
before assuming it's broken.

**Also required before the search-limit feature works at all:**
1. Run `supabase_search_limit_setup.sql` once in the Supabase SQL Editor (creates `profiles`
   table + RPC function). Verify with `select * from public.profiles;` afterward.
2. Set two new Worker secrets (in addition to the four that already exist):
   `wrangler secret put SUPABASE_URL` (the project URL, e.g. `https://pfxbuqiqwpryvmrvrgfp.supabase.co`)
   `wrangler secret put SUPABASE_SERVICE_KEY` (the **service_role** key, NOT anon — bypasses RLS
   so the Worker can read/increment search_count for any user)
3. Redeploy the Worker after adding those secrets.

## What was just done in the prior session (for context, not re-work)
Starting point was a single 212KB `main.html` (a one-page app) plus `index.html`/`app.html`,
with 8 specific feature requests from the user:
1. Remove all monetization (was: Free/Starter/Pro/Power tiers with Stripe/Razorpay mentions)
   → replaced with the 10-search/allowlist model described above
2. Hide "Add API keys" from onboarding (app no longer uses client-supplied keys)
3. Move logout to the main app only, remove from the landing page
4. Hide vendor names (Claude, Anthropic, JSearch, OpenWeb Ninja, Apify) from all user-facing
   text — replace with generic "Offrd is doing X" language
5. Split the single-page app into 3 separate real HTML files (one per step)
6. Fix the search keyword pre-fill to use one clean job title, not a joined keyword phrase
7. Fix resume "hallucination" (AI inventing companies not in the real resume)
8. Resume upload and search config needed to be on separate pages

**While doing this, several pre-existing bugs were found and fixed** (these were not requested
but blocked the app from actually working):
- The original `main.html` had ~49KB of dead code after its real closing `</html>` tag
- A structural bug meant roughly two-thirds of the app's JS sat outside any `<script>` tag and
  never executed in the browser at all (a `</script>` closed too early, mid-file)
- `fetchJSearchPage` was truncated mid-function and ran straight into orphaned code from a
  different function — would have thrown on every search
- `generateCoverLetter()`, `renderResults()`, `sortAndRender()`, `closePanel()`, `openApply()`,
  `renderLocTags()`, `VARIANT_DEFS`, and `getCompanyBrandColor()` were all referenced/called but
  **never defined anywhere** — meaning job results, cover letters, and the resume-tailoring
  variant cards never actually rendered. All were rebuilt from scratch based on their call sites.
- `S.apiBase` (used in every single Worker fetch call) was never set, so every API call was
  hitting `undefined/api/...`. Now set in `offrd-app.js`.
- The resume-hallucination root cause: when a file (not pasted text) was uploaded,
  `S.resumeText` got set to the literal string `'[file uploaded]'`. The AI then fabricated
  content because it had nothing real to work from. Fixed by always sending the real file
  (PDF as a `document` content block) or real extracted text (DOCX via mammoth.js client-side,
  since Anthropic's API doesn't accept DOCX as a document type) — never a placeholder.
- `app.html` pointed to `fetch('/main.html')` which no longer exists post-split — now redirects
  to upload/search/results.html based on how far the user's saved progress goes.
- `/app` links (no `.html`) don't resolve on GitHub Pages since `_redirects` is Netlify-only —
  changed to `/app.html` everywhere.

## Known remaining gaps (not fixed, flagged only)
- No salary-range filter UI exists, but `setCurrency()`/`getSalaryString()` in `search.html`
  reference DOM elements (`#salaryMin`, `#salaryMax`) that were never built. Harmless
  (safe via optional chaining) but the feature itself doesn't exist. Out of scope so far.
- EmailJS-based failure alerting (`reportAPIFailure` in `offrd-app.js`) still has placeholder
  `EMAILJS_SERVICE_ID` / `EMAILJS_TEMPLATE_ID` / `EMAILJS_PUBLIC_KEY` — never configured. Fails
  silently (wrapped in try/catch), no user-facing impact.
- No live end-to-end browser test has been run yet — only static `node --check` syntax
  validation on every extracted `<script>` block, plus cross-file checks that every
  `onclick`/`onchange` handler resolves to a defined function across all three pages + the
  shared JS file. **Recommend testing the full flow for real**: sign in → upload resume
  (try both PDF and DOCX) → search → open a job → tailor resume → generate cover letter →
  save to pipeline → check history → sign out.

## Your task
Pick up from here. Start by confirming the Supabase anon key and the search-limit migration/
secrets are sorted (see CRITICAL section above), then do a real end-to-end test of the app to
catch anything the static checks couldn't (e.g. CSS layout issues, the exact shape of
JSearch/Adzuna API responses, whether the Anthropic model name `claude-sonnet-4-6` used in
`upload.html`'s parse call is correct for the account's available models).
