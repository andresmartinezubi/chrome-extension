const progressBar   = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');
const currentLabel  = document.getElementById('currentLabel');
const statusBadge   = document.getElementById('statusBadge');
const resultsList   = document.getElementById('resultsList');
const footerActions = document.getElementById('footerActions');
const summaryLabel  = document.getElementById('summaryLabel');
const folderInfo    = document.getElementById('folderInfo');
const showFolderBtn = document.getElementById('showFolderBtn');

// ── Poll session storage for progress updates ─────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.batchProgress) {
    applyProgress(changes.batchProgress.newValue);
  }
});

// Also read immediately in case the page loaded after first write
chrome.storage.session.get('batchProgress').then(({ batchProgress }) => {
  if (batchProgress) applyProgress(batchProgress);
});

// ── Apply progress state ──────────────────────────────────────────────────────

function applyProgress(data) {
  if (!data) return;
  const { total = 0, current = 0, currentLabel: cl = '', results = [], status, folderName } = data;

  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBar.style.width   = `${pct}%`;
  progressLabel.textContent = `${current} / ${total}`;
  currentLabel.textContent  = cl;

  renderResults(results, status === 'running' ? current : null);

  if (status === 'done' || status === 'error') {
    const ok  = results.filter(r => r.status === 'success').length;
    const err = results.filter(r => r.status === 'error').length;

    statusBadge.textContent  = status === 'done' ? 'Done' : 'Error';
    statusBadge.className    = `badge ${status === 'done' ? 'badge-done' : 'badge-error'}`;
    summaryLabel.textContent = `${ok} captured${err ? `, ${err} failed` : ''}`;

    if (folderName) folderInfo.textContent = `Saved to Downloads/${folderName}`;
    showFolderBtn.disabled = ok === 0;
    footerActions.classList.remove('hidden');
  }
}

// ── Render results ────────────────────────────────────────────────────────────

function renderResults(results, runningIndex) {
  resultsList.innerHTML = '';
  results.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = 'result-item';

    const thumbSlot = document.createElement('div');
    const thumbSrc  = r.thumb || (r.status === 'success' ? r.dataUrl : null);
    if (thumbSrc) {
      const img = document.createElement('img');
      img.src       = thumbSrc;
      img.className = 'result-thumb';
      img.alt       = r.product || r.url;
      thumbSlot.appendChild(img);
    } else {
      thumbSlot.className = 'result-thumb-placeholder';
      if (r.status === 'error') {
        thumbSlot.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
      }
    }

    const info = document.createElement('div');
    info.className = 'result-info';
    info.innerHTML = `
      <div class="result-product">${esc(r.product || r.category || `Item ${i + 1}`)}</div>
      <div class="result-url">${esc(r.url)}</div>
      ${r.status === 'error' ? `<div class="result-error">${esc(r.error || 'Failed')}</div>` : ''}
    `;

    const num = document.createElement('div');
    num.className   = 'result-num';
    num.textContent = r.number || (i + 1);

    const status = document.createElement('div');
    status.className = `result-status ${r.status === 'success' ? 'status-ok' : 'status-err'}`;
    status.textContent = r.status === 'success' ? '✓' : '✗';

    li.append(thumbSlot, info, num, status);
    resultsList.appendChild(li);
  });

  if (runningIndex !== null && runningIndex < (results.length + 1)) {
    resultsList.scrollTo({ top: resultsList.scrollHeight, behavior: 'smooth' });
  }
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Open Downloads folder ─────────────────────────────────────────────────────

showFolderBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'show-downloads-folder' });
});
