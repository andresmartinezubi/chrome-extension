const progressBar   = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');
const currentLabel  = document.getElementById('currentLabel');
const statusBadge   = document.getElementById('statusBadge');
const resultsList   = document.getElementById('resultsList');
const footerActions = document.getElementById('footerActions');
const summaryLabel  = document.getElementById('summaryLabel');
const zipBtn        = document.getElementById('zipBtn');

let lastResults = [];

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
  const { total = 0, current = 0, currentLabel: cl = '', results = [], status } = data;

  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBar.style.width  = `${pct}%`;
  progressLabel.textContent = `${current} / ${total}`;
  currentLabel.textContent  = cl;

  lastResults = results;
  renderResults(results, status === 'running' ? current : null);

  if (status === 'done' || status === 'error') {
    const ok  = results.filter(r => r.status === 'success').length;
    const err = results.filter(r => r.status === 'error').length;

    statusBadge.textContent = status === 'done' ? 'Done' : 'Error';
    statusBadge.className   = `badge ${status === 'done' ? 'badge-done' : 'badge-error'}`;

    summaryLabel.textContent = `${ok} captured${err ? `, ${err} failed` : ''}`;
    footerActions.classList.remove('hidden');
    if (ok === 0) zipBtn.disabled = true;
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

// ── ZIP download ──────────────────────────────────────────────────────────────

zipBtn.addEventListener('click', async () => {
  zipBtn.disabled = true;
  zipBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" style="animation:spin .8s linear infinite"/></svg> Building ZIP…`;

  try {
    // Fetch full-resolution results from SW in-memory store
    const { results: fullResults } = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'get-batch-results' }, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response || { results: [] });
      });
    });

    const succeeded = fullResults.filter(r => r.status === 'success' && r.dataUrl);
    if (!succeeded.length) { zipBtn.disabled = false; return; }

    const zip = new JSZip();
    const folder = zip.folder('screenshots');

    const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

    succeeded.forEach((r, i) => {
      const [header, b64] = r.dataUrl.split(',');
      const mime = r.format || header.match(/:(.*?);/)[1];
      const ext  = extMap[mime] || 'png';
      const parts = [
        r.number   ? String(r.number).padStart(3, '0') : String(i + 1).padStart(3, '0'),
        r.category ? safeName(r.category) : null,
        r.product  ? safeName(r.product)  : null,
      ].filter(Boolean);
      const filename = parts.join('_') + '.' + ext;
      folder.file(filename, b64, { base64: true });
    });

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `screenshots_${isoTs()}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    console.error('[FPS] zip:', err);
  } finally {
    zipBtn.disabled  = false;
    zipBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download ZIP`;
  }
});

function safeName(str) {
  return String(str).replace(/[^a-z0-9]/gi, '_').slice(0, 30).replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function isoTs() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
}
