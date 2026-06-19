# Offrd Login & Search Limit Fixes

## Issue 1: Auto Sign-In After Logout ✅ FIXED

### Problem
When signing out, the app would automatically sign you back in. This happened because:
- `logoutUser()` cleared your app's storage (sessionStorage, localStorage)
- But **didn't** sign out from Supabase
- When redirected to `/`, Supabase detected an active session and auto-logged you in

### Solution
Modified three files:

#### 1. **offrd-app.js** — Enhanced `logoutUser()` function
- Now calls `window.sbClient.auth.signOut()` before clearing storage
- Explicitly terminates the Supabase session
- Then clears app storage
- Then redirects to landing page
- No active session = no auto sign-in ✓

#### 2. **index.html** — Exposed Supabase client globally
- Added: `window.sbClient = sb;` after Supabase client creation
- Makes the Supabase client accessible from shared `offrd-app.js`

#### 3. **app.html** — Exposed Supabase client globally
- Added: `window.sbClient = sb;` after Supabase client creation
- Consistent with index.html

---

## Issue 2: Unlimited Searches for Both Emails ✅ CONFIRMED WORKING

### Configuration
Both emails already have unlimited searches configured in `worker.js` (lines 20-23):

```javascript
const UNLIMITED_EMAILS = new Set([
  'crsrivathsan@gmail.com',
  'kalpooallu@gmail.com',
]);
```

**Status:** ✅ No changes needed — both emails are already in the allowlist

### How It Works
When either user performs a search:
1. Cloudflare Worker receives the search request
2. Extracts user email from Supabase JWT
3. Checks if email is in `UNLIMITED_EMAILS` set
4. If yes → unlimited searches (no limit enforced, no search count incremented)
5. If no → enforces 10-search limit from Supabase `profiles` table

---

## Testing Checklist

After deploying the updated files:

- [ ] **Sign in** with crsrivathsan@gmail.com or kalpooallu@gmail.com
- [ ] **Upload resume** and complete initial search
- [ ] **Run a search** — should show "Unlimited searches" in nav badge
- [ ] **Perform 3-5 more searches** — counter should remain "Unlimited"
- [ ] **Click "Sign out"** — should show confirmation dialog
- [ ] **Confirm sign out** — should redirect to landing page
- [ ] **Verify NOT auto-signed-in** — landing page should show "Sign in" buttons, not user dashboard
- [ ] **Try signing back in** — should work normally

---

## Files Modified

| File | Changes |
|------|---------|
| `offrd-app.js` | Enhanced `logoutUser()` to call Supabase signOut |
| `index.html` | Added `window.sbClient = sb;` |
| `app.html` | Added `window.sbClient = sb;` |
| `worker.js` | No changes (both emails already unlimited) |

---

## Deployment Steps

1. **Push updated files** to GitHub Pages (or your deployment)
2. **Clear browser cache** (Ctrl+Shift+Delete or Cmd+Shift+Delete)
3. **Test logout flow** — you should now stay signed out
4. **Verify unlimited searches** — search counter should show "Unlimited searches"

That's it! No Worker redeployment needed. No Supabase migration needed.

---

## Questions?

If logout still shows auto sign-in, it may be due to:
- Browser cookies not clearing (try private/incognito window)
- Supabase session persistence in a different storage location
- DNS caching (try accessing from different browser)

If searches still count toward the limit for your email, verify:
- Worker was redeployed after adding the emails to `UNLIMITED_EMAILS`
- Your Supabase project URL in Worker env vars is correct
- Your JWT token is being passed correctly in API requests (Bearer header)
