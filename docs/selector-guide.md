# Gemini DOM Selector Guide

All selectors in `codebase/content/content.js` (`SEL` object at top of file) were confirmed against a live, logged-in `gemini.google.com/app` session on 2026-06-24. When Google updates the UI, update `SEL` — the script is designed so the `SEL` block is the only thing that needs to change.

---

## Confirmed Live Selectors (2026-06-24)

| Purpose | Selector | Notes |
|---|---|---|
| Text input | `div.ql-editor[aria-label="Enter a prompt for Gemini"]` | Inside `rich-textarea` custom element; Quill editor |
| Submit button | `button[aria-label="Send message"]` | Only appears in DOM **after text has been typed** |
| Stop button | `button[aria-label="Stop response"]` | Present while Gemini streams; disappears when done |
| Response wrapper | `response-container` | Custom Angular element wrapping each model turn |
| Generated image | `generated-image img.image.loaded` | `.loaded` class added when blob is fully decoded |
| Gemini download btn | `button[aria-label="Download full-sized image"]` | Inside `generated-image`; used as fallback |

**Image URLs are always blob URLs**: `blob:https://gemini.google.com/<uuid>`. They cannot be downloaded by the extension background directly — the content script fetches them (it runs in the same renderer process as the page).

**Image generation takes ~90-120 seconds.** The 5-minute timeout in the content script is intentional.

---

## How to Inspect the Live DOM

1. Open `https://gemini.google.com/app` and sign in
2. Press **F12** → DevTools → Console

### Find the input field
```js
document.querySelectorAll('[contenteditable]')
document.querySelector('rich-textarea')
document.querySelector('div.ql-editor')
```

### Find the submit button (type first so it renders)
```js
// Type something, then:
document.querySelectorAll('button[aria-label]')
// Look for one with aria-label containing "Send" or "Submit"
```

### Find the stop button (while generating)
```js
document.querySelector('button[aria-label="Stop response"]')
```

### Find response containers
```js
document.querySelectorAll('response-container')
```

### Find generated images (after generation completes)
```js
document.querySelectorAll('generated-image img')
// or:
document.querySelectorAll('img[alt*="AI generated"]')
```

---

## Updating Selectors

Add the new working selector at the **front** of the relevant array in `SEL` (highest priority). Do not remove old entries — they may work again in future Gemini versions.

```js
const SEL = {
  input: [
    'div.new-working-selector',   // ← add new one first
    'div.ql-editor[aria-label="Enter a prompt for Gemini"]',  // previous
    // ...
  ],
};
```

After updating, reload the extension at `chrome://extensions` and test.
