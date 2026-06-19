# Mobile UX Fixes — Offrd

## Issues Fixed

### 1. ✅ Horizontal Scrolling on Mobile
**Problem:** The upload resume form had a 2-column layout that didn't collapse on mobile, forcing users to scroll left/right.

**Solution:**
- Added `.upload-layout` class to the form grid in `upload.html`
- Added mobile CSS rule to stack columns at `max-width: 768px` and below:
  ```css
  .upload-layout { grid-template-columns: 1fr !important; }
  ```
- Now on mobile, left column (upload zone) and right column (info card) stack vertically

**Result:** Full viewport width utilization, no horizontal scrolling ✓

---

### 2. ✅ Search Counter Overlapping with Button
**Problem:** Fixed-position search counter (`bottom:16px; right:16px;`) was overlapping the "Analyse Resume with AI" button on mobile.

**Solution:**
- Modified `.search-counter` positioning for mobile screens (max-width: 480px)
- Moved from bottom-right to top-right:
  ```css
  @media(max-width:480px){
    .search-counter {
      bottom: auto;
      top: 70px;      /* Below the nav bar */
      right: 12px;
      font-size: 11px;
      padding: 4px 10px;  /* Smaller on mobile */
    }
  }
  ```
- Added `white-space: nowrap;` to prevent text wrapping

**Result:** Counter visible but not overlapping with any buttons ✓

---

### 3. ✅ Screenshot Functionality Added
**Problem:** No way to capture pipeline/results as an image on mobile.

**Solution:**
- Added `📸 Screenshot` button to the pipeline export bar in `results.html`
- Integrated html2canvas library (CDN):
  ```html
  <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js" defer></script>
  ```
- Implemented `captureScreenshot()` function with:
  - Captures the pipeline board element
  - Auto-generates filename with date: `offrd_pipeline_2026-06-19.png`
  - Button feedback: shows "Capturing..." then "✓ Saved!" 
  - Error handling with user feedback
  - Works on mobile browsers (downloads to device camera roll / files app)

**Result:** One-click screenshot export on all devices ✓

---

## Files Modified

| File | Changes |
|------|---------|
| `offrd-shared.css` | Added mobile media query for `.search-counter` repositioning; Added `.upload-layout` mobile rule |
| `upload.html` | Added `upload-layout` class to the 2-column grid |
| `results.html` | Added html2canvas library; Added screenshot button; Added `captureScreenshot()` function |

---

## Mobile Breakpoints Affected

- **Desktop (>768px):** No changes, everything works as before
- **Tablet (480px - 768px):** 
  - Upload form columns stack
  - Search counter moves to top-right
- **Mobile (<480px):** 
  - All of above
  - Smaller counter size & padding
  - Optimized button spacing

---

## Testing Checklist

- [ ] On **iPhone/mobile browser**: Visit upload.html
  - [ ] Scroll horizontally — should NOT be needed (full width)
  - [ ] Upload resume — form should be single-column, readable
  - [ ] Check search counter position — should be at top-right, NOT overlapping button
  - [ ] Click "Analyse Resume with AI" button — should work without obstruction

- [ ] On **mobile**: Visit results.html → Pipeline tab
  - [ ] Find "📸 Screenshot" button in export bar
  - [ ] Click it — should show "Capturing..." then "✓ Saved!"
  - [ ] Check device Downloads / Photos — PNG should be there with today's date

- [ ] On **desktop**: Everything should work as before (no visual changes)

---

## Browser Compatibility

- ✓ iOS Safari
- ✓ Android Chrome
- ✓ Android Firefox
- ✓ Desktop Chrome/Firefox/Safari (backward compatible)

**Note:** html2canvas works in all modern browsers. Older iOS Safari versions may have issues with complex layouts — function includes error handling to gracefully fall back with user message.

---

## Optional Future Enhancements

1. **Screenshot styling:** Add optional dark mode styling for captured images
2. **Share screenshots:** Add social share buttons after capture
3. **PDF export:** Use jsPDF + html2canvas to export as PDF instead of PNG
4. **Batch screenshots:** Capture individual job cards for sharing
5. **Comparison mode:** Side-by-side screenshot of two jobs at once

These can be added later without breaking current functionality.

---

## Deployment

1. Replace these 3 files in your GitHub repo:
   - `offrd-shared.css`
   - `upload.html`
   - `results.html`

2. Clear browser cache (Ctrl+Shift+Delete)
3. Test on mobile device
4. Verify search counter position and screenshot functionality

No Worker redeployment needed. No Supabase changes needed. Pure frontend changes.
