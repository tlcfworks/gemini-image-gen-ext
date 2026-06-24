'use strict';

let cancelled = false;

// ─── MESSAGE ROUTER ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'startGeneration') {
    cancelled = false;
    runGeneration(msg.prompts, msg.options)
      .then(() => reply({ success: true }))
      .catch(err => reply({ error: err.message }));
    return true; // async reply
  }
  if (msg.action === 'cancel') {
    cancelled = true;
    reply({ success: true });
  }
});

// ─── ORCHESTRATOR ────────────────────────────────────────────────────────────

async function runGeneration(prompts, options) {
  const tabId = await ensureGeminiTab();

  for (let i = 0; i < prompts.length; i++) {
    if (cancelled) break;

    const prompt = prompts[i];
    broadcast({ status: 'processing', current: i + 1, total: prompts.length, prompt });

    try {
      // Navigate to a fresh Gemini conversation for each prompt
      await navigateAndWait(tabId, 'https://gemini.google.com/app');
      await sleep(2500); // let Angular finish bootstrapping

      // Ask content script to type, submit, and wait for images.
      // Image generation on Gemini takes ~90-120s; allow 6 min hard cap.
      const result = await callContentScript(tabId, { action: 'processPrompt', prompt }, 360_000);

      if (result.error) {
        broadcast({ status: 'error', error: result.error });
        continue;
      }

      // Content script clicks Gemini's own "Download full-sized image" button,
      // which is the only way to get the full-resolution file (the blob shown in
      // the chat is a downscaled preview). Downloads go to the browser's default folder.
      const downloadCount = result.downloadCount ?? 0;
      if (downloadCount === 0) {
        broadcast({ status: 'noImages' });
        continue;
      }

      broadcast({ status: 'downloaded', count: downloadCount,
        filename: `${downloadCount} image(s) via Gemini download` });
    } catch (err) {
      broadcast({ status: 'error', error: err.message });
    }

    // Delay between prompts (skip after last one)
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
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        return reject(new Error(chrome.runtime.lastError.message));
      }

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
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve(response ?? {});
    });
  });
}

// ─── DOWNLOAD ────────────────────────────────────────────────────────────────

async function tryDownload(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

// ─── BROADCAST TO POPUP ──────────────────────────────────────────────────────

function broadcast(data) {
  chrome.runtime.sendMessage({ action: 'progress', ...data }).catch(() => {
    // Popup may be closed — safe to ignore
  });
}

// ─── UTILS ───────────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extFromUrl(url) {
  const m = url.match(/\.(png|jpg|jpeg|webp|gif)(\?|$)/i);
  return m ? m[1].toLowerCase() : 'jpg';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
