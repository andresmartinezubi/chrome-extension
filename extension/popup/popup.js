// ── Tab switching ─────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('panelSingle').classList.toggle('hidden', tab !== 'single');
    document.getElementById('panelBatch').classList.toggle('hidden',  tab !== 'batch');
  });
});

// ── Viewport helpers ──────────────────────────────────────────────────────────

const vpRadios   = document.querySelectorAll('input[name="viewport"]');
const vpCustom   = document.getElementById('vpCustom');

vpCustom.disabled = true;
vpRadios.forEach(r => r.addEventListener('change', () => {
  vpCustom.disabled = r.value !== 'custom' || !r.checked;
}));

function getViewport() {
  const val = [...vpRadios].find(r => r.checked)?.value;
  if (!val || val === 'current') return null;
  const w = val === 'custom' ? parseInt(vpCustom.value, 10) : parseInt(val, 10);
  if (!w || w < 200) return null;
  return { width: w };
}

// ── Options helpers ───────────────────────────────────────────────────────────

function getOptions() {
  return {
    viewport: getViewport(),
    format:   document.getElementById('captureFormat').value,
    delay:    parseFloat(document.getElementById('delayInput').value) || 0,
    prePass:  document.getElementById('prePassCheck').checked,
  };
}

// ── Single capture ────────────────────────────────────────────────────────────

const captureBtn     = document.getElementById('captureBtn');
const captureBtnText = document.getElementById('captureBtnText');
const captureSpinner = document.getElementById('captureSpinner');
const captureStatus  = document.getElementById('captureStatus');

captureBtn.addEventListener('click', () => {
  setBusy(true);
  chrome.runtime.sendMessage({ action: 'start-capture', options: getOptions() }, () => {
    // Popup will close when preview tab opens; if it doesn't, reset state
    setTimeout(() => setBusy(false), 8000);
  });
});

function setBusy(on) {
  captureBtn.disabled = on;
  captureBtnText.textContent = on ? 'Capturing…' : 'Capture Page';
  captureSpinner.classList.toggle('hidden', !on);
  captureStatus.classList.add('hidden');
}

// ── Batch: file parsing ───────────────────────────────────────────────────────

let parsedItems = [];

const fileInput  = document.getElementById('fileInput');
const browseBtn  = document.getElementById('browseBtn');
const dropZone   = document.getElementById('dropZone');
const fileInfo   = document.getElementById('fileInfo');
const batchBtn   = document.getElementById('batchBtn');
const batchBtnText = document.getElementById('batchBtnText');
const batchStatus  = document.getElementById('batchStatus');

browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});

async function handleFile(file) {
  if (!file) return;
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'csv') {
      const text = await file.text();
      parsedItems = parseCSV(text);
    } else if (ext === 'xlsx' || ext === 'xls') {
      const buf = await file.arrayBuffer();
      parsedItems = await parseExcel(buf);
    } else {
      throw new Error('Unsupported file type. Use CSV or Excel (.xlsx).');
    }

    if (!parsedItems.length) throw new Error('No valid URLs found in file.');

    fileInfo.textContent = `✓ ${parsedItems.length} URL${parsedItems.length > 1 ? 's' : ''} loaded from "${file.name}"`;
    fileInfo.className = 'file-info';
    batchBtn.disabled = false;
    batchBtnText.textContent = `Start Batch (${parsedItems.length} pages)`;
  } catch (err) {
    fileInfo.textContent = `Error: ${err.message}`;
    fileInfo.className = 'file-info error';
    parsedItems = [];
    batchBtn.disabled = true;
  }
  fileInfo.classList.remove('hidden');
}

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSV(text) {
  const clean = text.replace(/^﻿/, ''); // strip BOM
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV appears empty.');

  const rows = lines.map(parseCSVLine);
  const hasHeader = rows[0].length >= 4 && !rows[0][3]?.toLowerCase().startsWith('http');
  const data = hasHeader ? rows.slice(1) : rows;

  return data
    .filter(r => r.length >= 4 && r[3]?.startsWith('http'))
    .map(r => ({ number: r[0], category: r[1], product: r[2], url: r[3].trim() }));
}

function parseCSVLine(line) {
  const fields = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ ? (line[i + 1] === '"' ? (cur += '"', i++) : (inQ = false)) : (inQ = true); }
    else if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}

// ── Excel parser (lazy-loads SheetJS) ────────────────────────────────────────

async function parseExcel(buffer) {
  const XLSX = await loadSheetJS();
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const hasHeader = rows[0] && !String(rows[0][3] || '').toLowerCase().startsWith('http');
  const data = hasHeader ? rows.slice(1) : rows;

  return data
    .filter(r => String(r[3] || '').startsWith('http'))
    .map(r => ({
      number:   String(r[0] || ''),
      category: String(r[1] || ''),
      product:  String(r[2] || ''),
      url:      String(r[3] || '').trim(),
    }));
}

function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('lib/xlsx.mini.min.js');
    s.onload  = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Failed to load Excel parser.'));
    document.head.appendChild(s);
  });
}

// ── Batch start ───────────────────────────────────────────────────────────────

batchBtn.addEventListener('click', () => {
  if (!parsedItems.length) return;
  batchBtn.disabled = true;
  batchBtnText.textContent = 'Starting…';
  chrome.runtime.sendMessage({
    action: 'start-batch',
    items: parsedItems,
    options: getOptions(),
  });
  // Popup closes when results tab opens
  setTimeout(() => window.close(), 1000);
});
