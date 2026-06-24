'use strict';

const $ = id => document.getElementById(id);

const inputSection   = $('input-section');
const progressSection = $('progress-section');
const startBtn       = $('start-btn');
const resetBtn       = $('reset-btn');
const promptsArea    = $('prompts');
const delayInput     = $('delay');
const prefixCheck    = $('prefix');
const progressText   = $('progress-text');
const progressBar    = $('progress-bar');
const log            = $('log');

// Receive live progress updates from the background service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'progress') onProgress(msg);
});

startBtn.addEventListener('click', async () => {
  const raw = promptsArea.value.trim();
  if (!raw) {
    alert('Enter at least one prompt.');
    return;
  }

  const prompts = raw
    .split('\n')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => prefixCheck.checked ? `Draw a picture of ${p}` : p);

  const options = {
    delayMs: Math.max(1, parseInt(delayInput.value, 10) || 4) * 1000,
  };

  showProgress(prompts.length);

  const resp = await chrome.runtime.sendMessage({ action: 'startGeneration', prompts, options });
  if (resp?.error) addLog(`Fatal: ${resp.error}`, 'error');
});

resetBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'cancel' });
  showInput();
});

function showProgress(total) {
  inputSection.classList.add('hidden');
  progressSection.classList.remove('hidden');
  log.innerHTML = '';
  progressBar.style.width = '0%';
  progressText.textContent = `0 / ${total} prompts`;
}

function showInput() {
  progressSection.classList.add('hidden');
  inputSection.classList.remove('hidden');
}

function onProgress(data) {
  switch (data.status) {
    case 'processing':
      progressText.textContent = `${data.current} / ${data.total} — generating…`;
      progressBar.style.width = `${((data.current - 1) / data.total) * 100}%`;
      addLog(`[${data.current}/${data.total}] "${truncate(data.prompt, 55)}"`);
      break;

    case 'downloading':
      addLog(`  ↳ ${data.imageCount} image(s) found, downloading…`, 'success');
      break;

    case 'downloaded':
      addLog(`  ✓ ${data.count ? data.count + ' full-size image(s) downloaded' : data.filename}`, 'success');
      break;

    case 'noImages':
      addLog(`  ⚠ No images detected in response`, 'error');
      break;

    case 'error':
      addLog(`  ✗ ${data.error}`, 'error');
      break;

    case 'complete':
      progressBar.style.width = '100%';
      progressText.textContent = `Done — ${data.total} prompt(s) processed`;
      addLog('All done!', 'info');
      resetBtn.textContent = 'Start Over';
      break;
  }
}

function addLog(text, type = '') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}
