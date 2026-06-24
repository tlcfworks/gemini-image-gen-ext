'use strict';

// ─── SELECTORS (all confirmed against live gemini.google.com DOM) ─────────────
// Update this block when Google changes the UI. See docs/selector-guide.md.
// Each value is an array; the first matching candidate wins.
const SEL = {
  // Quill contenteditable div; aria-label confirmed live
  input: [
    'div.ql-editor[aria-label="Enter a prompt for Gemini"]',
    'rich-textarea div.ql-editor',
    'div.ql-editor.textarea',
    'div.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"][aria-label]',
  ],

  // Appears inside input-area-v2 only after text has been typed
  submit: [
    'button[aria-label="Send message"]',
    'input-area-v2 button[aria-label*="end"]',
    'fieldset.input-area-container button[aria-label*="end"]',
  ],

  // Present while Gemini is streaming a response; "Stop response" confirmed live
  stop: [
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop"]',
  ],

  // Wraps each model turn; "response-container" confirmed live as custom element
  response: [
    'response-container',
    '.response-container',
    'model-response',
  ],

  // <generated-image> custom element contains the img; ".loaded" added when ready
  generatedImage: [
    'generated-image img.image.loaded',
    'generated-image img.loaded',
    'generated-image img',
    'img[alt*="AI generated"]',
    '.image-container img[alt*="generated"]',
  ],

  // Gemini's own download button inside generated-image (confirmed live)
  geminiDownloadBtn: [
    'button[aria-label="Download full-sized image"]',
    'generated-image button[aria-label*="ownload"]',
  ],
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function find(candidates, root = document) {
  for (const sel of candidates) {
    try { const el = root.querySelector(sel); if (el) return el; } catch (_) {}
  }
  return null;
}

function findAll(candidates, root = document) {
  for (const sel of candidates) {
    try { const els = root.querySelectorAll(sel); if (els.length) return Array.from(els); } catch (_) {}
  }
  return [];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(candidates, timeoutMs = 20000, pollMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = find(candidates);
    if (el) return el;
    await sleep(pollMs);
  }
  throw new Error(`Selector not found after ${timeoutMs}ms: ${candidates[0]}`);
}

// ─── TEXT INPUT ───────────────────────────────────────────────────────────────
// Gemini uses Quill + Angular. We must use execCommand so Angular detects the change.
function typeIntoQuill(field, text) {
  field.focus();

  // Clear existing content
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);

  // Position caret
  const p = field.querySelector('p') || field;
  const range = document.createRange();
  range.setStart(p, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  // Insert text — triggers Quill's internal change detection
  document.execCommand('insertText', false, text);

  // Fire an InputEvent as belt-and-suspenders for Angular zone detection
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

// ─── CORE: PROCESS ONE PROMPT ────────────────────────────────────────────────

async function processPrompt(prompt) {
  log('Waiting for input field…');
  const inputField = await waitFor(SEL.input, 20000);

  // Baseline response count before we submit
  const beforeCount = findAll(SEL.response).length;

  log('Typing prompt…');
  typeIntoQuill(inputField, prompt);
  await sleep(600); // let Quill / Angular settle

  log('Submitting…');
  await clickSubmit(inputField);

  log('Waiting for image generation to complete…');
  await waitForComplete(beforeCount, 300_000); // 5-minute hard cap

  log('Extracting image URLs…');
  const images = await extractImages(300_000);
  log(`Found ${images.length} image(s)`);

  return { images };
}

async function clickSubmit(inputField) {
  // The send button only renders after text is in the input — poll briefly
  for (let i = 0; i < 10; i++) {
    const btn = find(SEL.submit);
    if (btn && !btn.disabled) { btn.click(); return; }
    await sleep(300);
  }
  // Fallback: Enter key
  log('Send button not found — falling back to Enter key');
  const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
  inputField.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
  inputField.dispatchEvent(new KeyboardEvent('keyup',  enterOpts));
}

async function waitForComplete(beforeCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  // Phase 1: wait for a new response-container to appear (usually < 5s)
  while (Date.now() < deadline) {
    if (findAll(SEL.response).length > beforeCount) break;
    await sleep(400);
  }

  // Phase 2: wait for the stop button to appear, then disappear
  let seenStop = false;
  while (Date.now() < deadline) {
    const stopBtn = find(SEL.stop);
    if (stopBtn) {
      seenStop = true;
    } else if (seenStop) {
      await sleep(800); // small buffer after streaming ends
      return;
    } else if (Date.now() > deadline - (timeoutMs - 20_000)) {
      // Stop button never appeared after 20s — assume already done
      return;
    }
    await sleep(400);
  }
}

// Wait for images with the "loaded" class (Gemini adds it when blob is ready)
async function extractImages(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const imgs = findAll(SEL.generatedImage);
    if (imgs.length > 0) return imgs.map(img => img.src).filter(Boolean);
    await sleep(500);
  }
  log('No images found within timeout');
  return [];
}

// ─── IMAGE DOWNLOAD ───────────────────────────────────────────────────────────
// Gemini images are served as blob:https://gemini.google.com/... URLs.
// Content scripts share the renderer with the page, so we can fetch them directly.
async function downloadImageInPage(blobUrl, filename) {
  try {
    const resp = await fetch(blobUrl); // works because we're in the gemini.google.com origin
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    const blob = await resp.blob();
    const localUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = localUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(localUrl); }, 500);
    return { ok: true };
  } catch (err) {
    log(`Blob download failed (${err.message}), trying Gemini's own download button`);
    // Fallback: click Gemini's own "Download full-sized image" button
    const dlBtn = find(SEL.geminiDownloadBtn);
    if (dlBtn) { dlBtn.click(); return { ok: true, usedGeminiBtn: true }; }
    return { ok: false, error: err.message };
  }
}

function log(msg) { console.log(`[GeminiImgGen] ${msg}`); }

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'ping') {
    reply({ pong: true });
    return true;
  }

  if (msg.action === 'processPrompt') {
    processPrompt(msg.prompt)
      .then(result => reply(result))
      .catch(err => { log(`Error: ${err.message}`); reply({ images: [], error: err.message }); });
    return true;
  }

  if (msg.action === 'downloadImage') {
    downloadImageInPage(msg.url, msg.filename)
      .then(result => reply(result))
      .catch(err => reply({ ok: false, error: err.message }));
    return true;
  }
});

log('Content script ready');
