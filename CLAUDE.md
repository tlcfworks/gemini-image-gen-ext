# gemini-image-gen-ext — Project Rules

Chrome extension that batch-generates and downloads images from gemini.google.com using a list of user-supplied prompts. No API key required — it drives the real Gemini web UI on behalf of the logged-in user.

---

## Project Context

- **Product:** Gemini Bulk Image Generator (Chrome Extension)
- **Purpose:** Accept a list of text prompts, submit each to Gemini's image generation UI one-by-one, auto-download all generated images
- **Tech stack:** Chrome Extension Manifest V3, Vanilla JS — no build step
- **Repository:** https://github.com/tlcfworks/gemini-image-gen-ext
- **Prerequisite:** User must be signed into gemini.google.com and have access to Gemini's image generation feature

---

## Folder Structure

| Folder/File | Purpose |
|---|---|
| `codebase/manifest.json` | Extension manifest (MV3) |
| `codebase/popup/` | Popup UI — `popup.html`, `popup.css`, `popup.js` |
| `codebase/content/content.js` | Content script injected into gemini.google.com — drives the DOM |
| `codebase/background/service-worker.js` | Service worker — orchestrates tabs, messaging, downloads |
| `codebase/icons/` | PNG extension icons (16, 48, 128 px) |
| `docs/` | Architecture notes, selector update guide, design decisions |

Root: only `CLAUDE.md`, `.gitignore`. No stray files at root.

---

## Rules

### No Build Step
Keep everything vanilla JS. Chrome loads files directly. No webpack, rollup, Babel, or TypeScript transpilation. If ES modules are needed, use native `import/export` with `"type": "module"` in the manifest.

### Selector Resilience — Critical
Gemini is a Google SPA; its DOM changes without notice. Every CSS selector that targets Gemini's DOM:
- Must live in the `SELECTORS` constant at the top of `content.js`
- Must have multiple fallback candidates in priority order (array)
- Must include a comment on the line explaining what it targets
- Must log a clear console error when all candidates fail so the user can report the broken selector

When selectors break, the fix belongs in `SELECTORS` only — not scattered through the script.

### Sequential Prompt Processing
Prompts are processed one at a time. Never submit multiple prompts in parallel — Gemini is a single chat window and concurrent submissions corrupt the flow.

### Download Naming Convention
Images are saved to the `gemini-images/` subfolder in the user's default downloads directory, named:
`{prompt-slug}-{prompt-index}-{image-index}.{ext}`
where `prompt-slug` is the first 40 characters of the prompt, lowercased, with non-alphanumeric runs replaced by `-`.

### No External Dependencies
No npm, no CDN script tags, no remote resources at runtime. Everything ships inside the extension package. All JS is inline in the extension files.

### Error Handling Philosophy
Every DOM interaction has a configurable timeout. On timeout or selector failure, log clearly and move to the next prompt — never hang indefinitely. Surface errors in the popup progress log so the user understands what happened.

---

## Loading the Extension (Development)

1. Navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `codebase/` folder (the one containing `manifest.json`)
5. Open gemini.google.com and sign in before running the extension

## Quick Reload After Code Changes

```
chrome://extensions → click the reload icon on the extension card
```

---

## Updating Broken Selectors

See `docs/selector-guide.md` for how to inspect the live Gemini DOM and update `SELECTORS` in `content.js`.
