'use strict';

// ─── SELECTORS (confirmed against live gemini.google.com DOM, 2026-06-24) ───
const SEL = {
  input: [
    'div.ql-editor[aria-label="Enter a prompt for Gemini"]',
    'rich-textarea div.ql-editor',
    'div.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"][aria-label]',
  ],
  submit: [
    'button[aria-label="Send message"]',
    'input-area-v2 button[aria-label*="end"]',
    'fieldset.input-area-container button[aria-label*="end"]',
  ],
  generatedImage: 'generated-image',
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function find(candidates, root = document) {
  for (const sel of [].concat(candidates)) {
    try { const el = root.querySelector(sel); if (el) return el; } catch (_) {}
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(candidates, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = find(candidates);
    if (el) return el;
    await sleep(300);
  }
  throw new Error(`Timeout waiting for: ${[].concat(candidates)[0]}`);
}

// ─── TEXT INPUT ───────────────────────────────────────────────────────────────
function typeIntoQuill(field, text) {
  field.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  const p = field.querySelector('p') || field;
  const range = document.createRange();
  range.setStart(p, 0);
  range.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  document.execCommand('insertText', false, text);
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

// ─── SUBMIT ───────────────────────────────────────────────────────────────────
async function clickSubmit(inputField) {
  for (let i = 0; i < 10; i++) {
    const btn = find(SEL.submit);
    if (btn && !btn.disabled) { btn.click(); return; }
    await sleep(300);
  }
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
  inputField.dispatchEvent(new KeyboardEvent('keydown', opts));
  inputField.dispatchEvent(new KeyboardEvent('keyup', opts));
}

// ─── WAIT FOR generated-image (MutationObserver) ─────────────────────────────
function waitForGeneratedImage(timeoutMs = 300_000) {
  return new Promise((resolve) => {
    if (document.querySelector(SEL.generatedImage)) {
      setTimeout(() => resolve(document.querySelectorAll(SEL.generatedImage).length), 2000);
      return;
    }
    const timer = setTimeout(() => { observer.disconnect(); resolve(0); }, timeoutMs);
    const observer = new MutationObserver(() => {
      if (document.querySelector(SEL.generatedImage)) {
        clearTimeout(timer);
        observer.disconnect();
        // Give Angular 2s to finish rendering all images in the response
        setTimeout(() => resolve(document.querySelectorAll(SEL.generatedImage).length), 2000);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// ─── CORE ────────────────────────────────────────────────────────────────────
// Content script only handles: type → submit → wait for image.
// Downloading is done by the background in the MAIN world via scripting.executeScript.

async function processPrompt(prompt) {
  log('Waiting for input field…');
  const inputField = await waitFor(SEL.input, 20000);

  log('Typing prompt…');
  typeIntoQuill(inputField, prompt);
  await sleep(600);

  log('Submitting…');
  await clickSubmit(inputField);

  log('Waiting for generated-image (may take 1–2 min)…');
  const imageCount = await waitForGeneratedImage(300_000);

  if (imageCount === 0) {
    log('No generated-image appeared — text-only response');
    return { imageCount: 0 };
  }

  log(`${imageCount} image(s) detected — background will handle download`);
  return { imageCount };
}

function log(msg) { console.log(`[GeminiImgGen] ${msg}`); }

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'ping') { reply({ pong: true }); return true; }
  if (msg.action === 'processPrompt') {
    processPrompt(msg.prompt)
      .then(reply)
      .catch(err => { log(`Error: ${err.message}`); reply({ imageCount: 0, error: err.message }); });
    return true;
  }
});

log('Content script ready');
