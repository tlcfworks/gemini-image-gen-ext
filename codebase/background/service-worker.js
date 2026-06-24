'use strict';

let cancelled = false;

// Filenames we want to force onto the next download(s), in order. Gemini's
// full-size image URL returns a Content-Disposition header (e.g.
// "watermarked_img_123.png") that otherwise overrides the `filename` we pass to
// chrome.downloads.download — including our gemini-images/ subfolder. The
// onDeterminingFilename listener below is the only reliable way to override it.
const renameQueue = [];

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const name = renameQueue.shift();
  if (name) suggest({ filename: name, conflictAction: 'uniquify' });
  else suggest();
});

// ─── MESSAGE ROUTER ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'startGeneration') {
    cancelled = false;
    runGeneration(msg.prompts, msg.options)
      .then(() => reply({ success: true }))
      .catch(err => reply({ error: err.message }));
    return true;
  }
  if (msg.action === 'cancel') {
    cancelled = true;
    reply({ success: true });
  }
});

// ─── MAIN WORLD: CAPTURE FULL-SIZE IMAGE URLs ────────────────────────────────
// Runs in the page's MAIN world (top frame). Clicking Gemini's "Download
// full-sized image" button makes Gemini fetch() the image from
// googleusercontent.com. We can't use Gemini's own download — it fires from a
// sandboxed null-origin iframe and needs a real user gesture (which an injected
// click lacks). Instead we intercept the fetch in the top frame and report the
// URL of the full-size image; the background downloads it via chrome.downloads
// (which sends the session cookies). We return URLs, NOT image bytes — a
// multi-MB base64 string cannot be serialized back through executeScript.
//
// On one download click Gemini fetches several resources that all share the
// `=s0-d-I` style suffix:
//   • analytics pings  — content-type text/plain      (ignore)
//   • a 1024px preview — image/jpeg, URL has `-rj`     (small, ignore)
//   • the original     — image/png,  URL has `=s0`/`-d` (what we want)
// So we must check the response content-type, not just the URL. Confirmed from
// a real-browser HAR capture (docs/AsHAR.txt, docs/AsFetch.txt).
async function mainWorldCaptureImages() {
  const caps = [];   // { url, ct, size } for every image/* response
  let pending = 0;   // image responses still being inspected

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = (typeof input === 'string') ? input : ((input && input.url) || '');
    const promise = origFetch.apply(this, arguments);

    if (/googleusercontent\.com|lh\d+\.google/.test(url)) {
      pending++;
      promise.then((resp) => {
        const ct = resp.headers.get('content-type') || '';
        if (/^image\//i.test(ct)) {
          // content-length avoids reading the body; fall back to 0 if absent.
          const len = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
          caps.push({ url, ct, size: len });
        }
      }).catch(() => {}).finally(() => { pending--; });
    }
    return promise;
  };

  const dlBtns = document.querySelectorAll('button[aria-label="Download full-sized image"]');
  if (dlBtns.length === 0) { window.fetch = origFetch; return []; }

  // A URL is the original full-size image when it carries an `=s0` / `-d` /
  // `=d` download marker AND is not a `-rj` resized preview.
  const isFullSize = (u) => /(=s0\b|[-=]d(-I)?\b)/.test(u) && !/-rj\b/.test(u);

  // Right after generation the button may not yet fetch the full-size image
  // (Gemini is still finalizing it). So re-click periodically until a full-size
  // image actually shows up, for up to ~40s.
  for (let i = 0; i < 200; i++) {
    if (i % 15 === 0) dlBtns.forEach((btn) => btn.click());  // (re)click every ~3s
    await new Promise((r) => setTimeout(r, 200));
    const fullCount = caps.filter((c) => isFullSize(c.url)).length;
    if (fullCount >= dlBtns.length && pending === 0) break;
  }

  window.fetch = origFetch;

  // Prefer full-size image URLs; fall back to any image URLs we saw.
  let chosen = caps.filter((c) => isFullSize(c.url));
  if (chosen.length === 0) chosen = caps;

  // De-duplicate by URL.
  const seen = new Set();
  const out = [];
  for (const c of chosen) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c.url);
  }
  return out;
}

// ─── ORCHESTRATOR ────────────────────────────────────────────────────────────

async function runGeneration(prompts, options) {
  const tabId = await ensureGeminiTab();

  for (let i = 0; i < prompts.length; i++) {
    if (cancelled) break;

    const prompt = prompts[i];
    broadcast({ status: 'processing', current: i + 1, total: prompts.length, prompt });

    try {
      await navigateAndWait(tabId, 'https://gemini.google.com/app');
      await sleep(2500);

      // Content script types, submits, and waits for image to appear
      const result = await callContentScript(tabId, { action: 'processPrompt', prompt }, 360_000);

      if (result.error) {
        broadcast({ status: 'error', error: result.error });
        continue;
      }

      if (!result.imageCount || result.imageCount === 0) {
        broadcast({ status: 'noImages' });
        continue;
      }

      broadcast({ status: 'downloading', imageCount: result.imageCount });

      // MAIN world: click the download button(s) and capture the full-size
      // image bytes from Gemini's fetch response.
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: mainWorldCaptureImages,
      });

      const imageUrls = injected?.[0]?.result ?? [];

      if (imageUrls.length === 0) {
        broadcast({ status: 'noImages' });
        continue;
      }

      // Save each full-size image URL via chrome.downloads (uses session cookies).
      const promptSlug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-+$/, '');
      let downloadCount = 0;
      for (let imgIdx = 0; imgIdx < imageUrls.length; imgIdx++) {
        const filename = `gemini-images/${promptSlug}-${i + 1}-${imgIdx + 1}.png`;
        try {
          await tryDownload(imageUrls[imgIdx], filename);
          downloadCount++;
        } catch (e) {
          broadcast({ status: 'error', error: `Download failed: ${e.message}` });
        }
      }

      if (downloadCount === 0) {
        broadcast({ status: 'noImages' });
      } else {
        broadcast({ status: 'downloaded', count: downloadCount });
      }

    } catch (err) {
      broadcast({ status: 'error', error: err.message });
    }

    if (i < prompts.length - 1 && !cancelled) {
      await sleep(options.delayMs ?? 4000);
    }
  }

  if (!cancelled) {
    broadcast({ status: 'complete', total: prompts.length });
  }
}

// ─── TAB MANAGEMENT ──────────────────────────────────────────────────────────

async function ensureGeminiTab() {
  const [existing] = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: true });
  await sleep(3000);
  return tab.id;
}

function navigateAndWait(tabId, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Navigation timed out')), 30_000);
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) { clearTimeout(timer); return reject(new Error(chrome.runtime.lastError.message)); }
      function onUpdated(id, info) {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          clearTimeout(timer);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

// ─── CONTENT SCRIPT COMMS ────────────────────────────────────────────────────

function callContentScript(tabId, message, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Content script timed out')), timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response ?? {});
    });
  });
}

// ─── BROADCAST TO POPUP ──────────────────────────────────────────────────────

function broadcast(data) {
  chrome.runtime.sendMessage({ action: 'progress', ...data }).catch(() => {});
}

// ─── DOWNLOAD ─────────────────────────────────────────────────────────────────

function tryDownload(url, filename) {
  return new Promise((resolve, reject) => {
    // Queue the target name; onDeterminingFilename applies it (and overrides the
    // server's Content-Disposition). Downloads are awaited one at a time, so the
    // FIFO queue stays in sync with the determination order.
    renameQueue.push(filename);
    chrome.downloads.download({ url }, (downloadId) => {
      if (chrome.runtime.lastError) {
        const idx = renameQueue.indexOf(filename);
        if (idx >= 0) renameQueue.splice(idx, 1);
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(downloadId);
      }
    });
  });
}

// ─── UTILS ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
