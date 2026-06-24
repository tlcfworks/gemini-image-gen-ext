'use strict';

// ─── SELECTORS ───────────────────────────────────────────────────────────────
// All Gemini DOM selectors live here. Update this block when Google changes the UI.
// Each entry is an array of candidates tried in order; the first match wins.
// See docs/selector-guide.md for how to find updated selectors.
const SEL = {
  // The main text input (contenteditable div inside Quill / rich-textarea)
  input: [
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea .ql-editor',
    'div[contenteditable="true"][data-placeholder]',
    '.input-area-container div[contenteditable="true"]',
    'div[contenteditable="true"]',                         // last resort
  ],

  // Submit / send button
  submit: [
    'button[aria-label="Send message"]',
    'button[data-test-id="send-button"]',
    'button.send-button',
    'button[aria-label="Submit"]',
    'button[aria-label="Run"]',
    '.trailing-actions button[type="submit"]',
    '.submit-button',
  ],

  // "Stop generating" button — present while Gemini is streaming a response
  stop: [
    'button[aria-label="Stop generating"]',
    'button[data-test-id="stop-button"]',
    '.stop-button',
    'button[aria-label="Stop"]',
  ],

  // Container for a single model response turn
  response: [
    'model-response',
    '.model-response',
    'message-content.model-response',
    '[data-test-id="response"]',
    '.response-container',
    'chat-message:last-of-type',
  ],

  // "New chat" / reset conversation button
  newChat: [
    'a[aria-label="New chat"]',
    'button[aria-label="New chat"]',
    '[data-test-id="new-chat-button"]',
    '.new-chat-button',
    'a[href="/app"]',
  ],
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function find(candidates, root = document) {
  for (const sel of candidates) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch (_) {}
  }
  return null;
}

function findAll(candidates, root = document) {
  for (const sel of candidates) {
    try {
      const els = root.querySelectorAll(sel);
      if (els.length) return Array.from(els);
    } catch (_) {}
  }
  return [];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor(candidates, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = find(candidates);
    if (el) return el;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for element. Tried: ${candidates[0]}`);
}

// Simulate real user typing into a contenteditable element.
// Angular/LitElement track native DOM events, so we can't just set .textContent.
function typeText(field, text) {
  field.focus();

  // Clear existing text
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);

  // Insert new text via execCommand (works with Quill / contenteditable)
  const inserted = document.execCommand('insertText', false, text);

  // Fallback if execCommand didn't work
  if (!inserted || !field.textContent.trim()) {
    field.textContent = text;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

// ─── CORE LOGIC ──────────────────────────────────────────────────────────────

async function processPrompt(prompt) {
  log(`Looking for input field…`);
  const inputField = await waitFor(SEL.input, 20000);

  // Snapshot how many model responses exist before we submit
  const beforeCount = findAll(SEL.response).length;

  log(`Typing prompt…`);
  typeText(inputField, prompt);
  await sleep(600);

  log(`Submitting…`);
  await submit(inputField);

  log(`Waiting for response…`);
  const images = await waitForImages(beforeCount, 150_000);

  log(`Found ${images.length} image(s)`);
  return { images };
}

async function submit(inputField) {
  const btn = find(SEL.submit);
  if (btn && !btn.disabled) {
    btn.click();
    return;
  }
  // Fallback: send Enter key
  inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  inputField.dispatchEvent(new KeyboardEvent('keyup',  { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
}

async function waitForImages(beforeCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  // Phase 1 — wait for a new response container to appear
  while (Date.now() < deadline) {
    if (findAll(SEL.response).length > beforeCount) break;
    await sleep(300);
  }

  // Phase 2 — wait for the stop button to appear then vanish
  //   (appears when streaming starts, disappears when done)
  let seenStop = false;
  while (Date.now() < deadline) {
    const stopBtn = find(SEL.stop);
    if (stopBtn) {
      seenStop = true;
    } else if (seenStop) {
      await sleep(800); // small buffer after streaming ends
      break;
    } else if (Date.now() > deadline - (timeoutMs - 15_000)) {
      // If stop button never appeared after 15s, assume already done
      break;
    }
    await sleep(400);
  }

  return extractImages();
}

function extractImages() {
  const responses = findAll(SEL.response);
  const searchRoot = responses.length ? responses[responses.length - 1] : document;

  const imgs = Array.from(searchRoot.querySelectorAll('img'));
  const urls = imgs
    .map(img => img.src)
    .filter(src => src && src.startsWith('http') && isGeneratedImage(src));

  if (urls.length) return urls;

  // Broader fallback — look for Google-hosted images anywhere on the page
  return Array.from(document.querySelectorAll('img'))
    .map(img => img.src)
    .filter(src => src && isGeneratedImage(src) && isGoogleImageHost(src));
}

function isGeneratedImage(src) {
  const lower = src.toLowerCase();
  const SKIP = ['favicon', '/icon', 'logo', 'avatar', 'profile', '.svg', 'gstatic.com/images', 'accounts.google'];
  return !SKIP.some(s => lower.includes(s));
}

function isGoogleImageHost(src) {
  return src.includes('googleusercontent.com') || src.includes('generativelanguage.googleapis.com');
}

// ─── IMAGE DOWNLOAD (from content script context, preserves auth cookies) ───

async function downloadImageInPage(url, filename) {
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 500);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function log(msg) {
  console.log(`[GeminiImgGen] ${msg}`);
}

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
    return true; // keep channel open for async reply
  }

  if (msg.action === 'downloadImage') {
    downloadImageInPage(msg.url, msg.filename)
      .then(result => reply(result))
      .catch(err => reply({ ok: false, error: err.message }));
    return true;
  }
});

log('Content script ready');
