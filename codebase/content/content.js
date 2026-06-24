'use strict';

// ─── SELECTORS (all confirmed against live gemini.google.com DOM, 2026-06-24) ──
// Update this block when Google changes the UI. See docs/selector-guide.md.
const SEL = {
  // Quill contenteditable div inside rich-textarea
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

  // Wraps each model turn
  response: [
    'response-container',
    '.response-container',
    'model-response',
  ],

  // Custom element that wraps a single generated image
  generatedImage: 'generated-image',

  // Download button — only injected into DOM after hovering the image (Angular *ngIf)
  downloadBtn: 'button[aria-label="Download full-sized image"]',
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function find(candidates, root = document) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const sel of list) {
    try { const el = root.querySelector(sel); if (el) return el; } catch (_) {}
  }
  return null;
}

function findAll(candidates, root = document) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const sel of list) {
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
  throw new Error(`Selector not found after ${timeoutMs}ms: ${[].concat(candidates)[0]}`);
}

// ─── TEXT INPUT ───────────────────────────────────────────────────────────────
// Gemini uses Quill + Angular; must use execCommand so Quill's change detection fires.
function typeIntoQuill(field, text) {
  field.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);

  const p = field.querySelector('p') || field;
  const range = document.createRange();
  range.setStart(p, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

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
  log('Send button not found — falling back to Enter key');
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
  inputField.dispatchEvent(new KeyboardEvent('keydown', opts));
  inputField.dispatchEvent(new KeyboardEvent('keyup', opts));
}

// ─── WAIT FOR generated-image TO APPEAR (MutationObserver) ───────────────────
// Much more reliable than polling — fires the instant Angular renders the element.
function waitForGeneratedImage(timeoutMs = 300_000) {
  return new Promise((resolve) => {
    // Already present (e.g. page wasn't fully reset)?
    if (document.querySelector(SEL.generatedImage)) {
      setTimeout(() => resolve(true), 500);
      return;
    }
    const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, timeoutMs);
    const observer = new MutationObserver(() => {
      if (document.querySelector(SEL.generatedImage)) {
        clearTimeout(timer);
        observer.disconnect();
        setTimeout(() => resolve(true), 800); // let Angular finish rendering the controls
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// ─── HOVER → DOWNLOAD ────────────────────────────────────────────────────────
// The download button is rendered via Angular *ngIf on hover state — it does NOT
// exist in the DOM until the image is hovered or clicked. We must trigger that
// hover event first, then wait for the button to be injected, then click it.
async function hoverAndDownload() {
  const genImgs = document.querySelectorAll(SEL.generatedImage);
  log(`Found ${genImgs.length} generated-image element(s)`);
  let clicked = 0;

  for (const genImg of genImgs) {
    const img = genImg.querySelector('img');
    if (!img) { log('No img inside generated-image — skipping'); continue; }

    // 1. Hover over the image to trigger Angular's hover state → injects controls into DOM
    for (const target of [img, genImg]) {
      target.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent('mousemove',  { bubbles: true, cancelable: true }));
    }
    await sleep(600); // wait for *ngIf to render the controls overlay

    // 2. Look for the download button (now injected by Angular)
    let dlBtn = genImg.querySelector(SEL.downloadBtn)
             || document.querySelector(SEL.downloadBtn);

    // 3. If still not visible, try clicking the image (user confirmed this also reveals it)
    if (!dlBtn) {
      log('Hover did not reveal button — trying image click');
      img.click();
      await sleep(600);
      dlBtn = genImg.querySelector(SEL.downloadBtn)
           || document.querySelector(SEL.downloadBtn);
    }

    if (dlBtn) {
      dlBtn.click();
      log('Clicked "Download full-sized image"');
      clicked++;
      await sleep(800); // let browser register the download before moving on
    } else {
      log('Download button still not found after hover + click — skipping image');
    }
  }

  return clicked;
}

// ─── CORE: PROCESS ONE PROMPT ────────────────────────────────────────────────

async function processPrompt(prompt) {
  log('Waiting for input field…');
  const inputField = await waitFor(SEL.input, 20000);

  log('Typing prompt…');
  typeIntoQuill(inputField, prompt);
  await sleep(600);

  log('Submitting…');
  await clickSubmit(inputField);

  log('Waiting for generated-image element (may take 1-2 min)…');
  const appeared = await waitForGeneratedImage(300_000); // 5-min hard cap

  if (!appeared) {
    log('No generated-image appeared — response was probably text-only');
    return { downloadCount: 0 };
  }

  log('Image appeared — hovering to reveal download button…');
  const downloadCount = await hoverAndDownload();
  log(`Triggered ${downloadCount} full-size download(s)`);
  return { downloadCount };
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
      .catch(err => { log(`Error: ${err.message}`); reply({ downloadCount: 0, error: err.message }); });
    return true;
  }
});

log('Content script ready');
