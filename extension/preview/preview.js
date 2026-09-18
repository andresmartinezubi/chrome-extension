let originalDataUrl = null;
let isActualSize = false;

const img           = document.getElementById('screenshotImg');
const imageWrapper  = document.getElementById('imageWrapper');
const loadingState  = document.getElementById('loadingState');
const errorState    = document.getElementById('errorState');
const errorMsg      = document.getElementById('errorMsg');
const pageTitle     = document.getElementById('pageTitle');
const pageUrl       = document.getElementById('pageUrl');
const dimensionsLbl = document.getElementById('dimensionsLabel');
const downloadBtn   = document.getElementById('downloadBtn');
const copyBtn       = document.getElementById('copyBtn');
const formatSelect  = document.getElementById('formatSelect');
const zoomToggle    = document.getElementById('zoomToggle');
const zoomLabel     = document.getElementById('zoomLabel');

// Load screenshot via message (avoids session storage quota limits)
(async () => {
  try {
    const params = new URLSearchParams(location.search);
    const errorParam = params.get('error');
    if (errorParam) throw new Error(decodeURIComponent(errorParam));

    const id = params.get('id');
    if (!id) throw new Error('No screenshot ID found. Try capturing again.');

    const data = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'get-screenshot', id }, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });

    if (data?.error) throw new Error(data.error);
    if (!data?.dataUrl) throw new Error('No screenshot data returned. Try capturing again.');

    originalDataUrl = data.dataUrl;

    pageTitle.textContent = data.title || 'Screenshot';
    pageUrl.textContent   = data.url   || '';
    document.title        = `Screenshot — ${data.title || 'Preview'}`;

    // Pre-select the format that was used to capture
    if (data.format && formatSelect.querySelector(`option[value="${data.format}"]`)) {
      formatSelect.value = data.format;
    }

    img.src = originalDataUrl;
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      dimensionsLbl.textContent = `${w} × ${h} px`;
      loadingState.classList.add('hidden');
      imageWrapper.classList.remove('hidden');
    };
    img.onerror = () => showError('Failed to render screenshot.');
  } catch (err) {
    showError(err.message);
  }
})();

// Download
downloadBtn.addEventListener('click', async () => {
  const format = formatSelect.value;

  if (format === 'pdf') {
    await downloadPDF();
    return;
  }

  const ext     = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[format];
  const quality = { 'image/jpeg': 0.92, 'image/webp': 0.90 }[format];

  let dataUrl = originalDataUrl;
  if (format !== 'image/png') {
    dataUrl = await convertFormat(originalDataUrl, format, quality);
  }

  const filename = buildFilename(pageTitle.textContent, ext);
  triggerDownload(dataUrl, filename);
});

async function downloadPDF() {
  if (!window.jspdf) { showToast('PDF library not loaded'); return; }
  const { jsPDF } = window.jspdf;

  const image = new Image();
  await new Promise(r => { image.onload = r; image.src = originalDataUrl; });

  const imgW = image.naturalWidth;
  const imgH = image.naturalHeight;

  // A4 dimensions in pt (portrait or landscape based on aspect ratio)
  const a4W = 595.28, a4H = 841.89;
  const landscape = imgW > imgH;
  const pageW = landscape ? a4H : a4W;
  const pageH = landscape ? a4W : a4H;

  const scale = pageW / imgW;
  const scaledH = imgH * scale;

  const pdf = new jsPDF({ orientation: landscape ? 'l' : 'p', unit: 'pt', format: 'a4' });

  if (scaledH <= pageH) {
    pdf.addImage(originalDataUrl, 'PNG', 0, 0, pageW, scaledH);
  } else {
    // Slice into pages
    let srcY = 0;
    const sliceH = Math.floor(pageH / scale);
    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d');
    canvas.width = imgW;

    while (srcY < imgH) {
      const h = Math.min(sliceH, imgH - srcY);
      canvas.height = h;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, srcY, imgW, h, 0, 0, imgW, h);
      const sliceUrl = canvas.toDataURL('image/png');
      if (srcY > 0) pdf.addPage();
      pdf.addImage(sliceUrl, 'PNG', 0, 0, pageW, h * scale);
      srcY += h;
    }
  }

  pdf.save(buildFilename(pageTitle.textContent, 'pdf'));
}

// Copy to clipboard (always as PNG — widest clipboard support)
copyBtn.addEventListener('click', async () => {
  try {
    const blob = await dataUrlToBlob(originalDataUrl);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    showToast('Copied to clipboard');
  } catch {
    showToast('Copy failed — try downloading instead');
  }
});

// Zoom toggle
zoomToggle.addEventListener('click', () => {
  isActualSize = !isActualSize;
  imageWrapper.classList.toggle('actual-size', isActualSize);
  zoomToggle.classList.toggle('active', isActualSize);
  zoomToggle.querySelector('svg').innerHTML = isActualSize
    ? '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>'
    : '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>';
  zoomLabel.textContent = isActualSize ? 'Actual size' : 'Fit width';
});

// ---- Helpers ----

async function convertFormat(srcUrl, mimeType, quality) {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (mimeType === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(image, 0, 0);
      resolve(canvas.toDataURL(mimeType, quality));
    };
    image.src = srcUrl;
  });
}

function dataUrlToBlob(dataUrl) {
  return new Promise(resolve => {
    const [header, b64] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(b64);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    resolve(new Blob([buf], { type: mime }));
  });
}

function triggerDownload(dataUrl, filename) {
  const a = document.createElement('a');
  a.href     = dataUrl;
  a.download = filename;
  a.click();
}

function buildFilename(title, ext) {
  const safe = (title || 'screenshot').replace(/[^a-z0-9_\-. ]/gi, '_').slice(0, 60).trim();
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${safe}_${ts}.${ext}`;
}

function showError(msg) {
  loadingState.classList.add('hidden');
  errorMsg.textContent = msg;
  errorState.classList.remove('hidden');
}

let toastTimer;
function showToast(text) {
  let toast = document.querySelector('.copy-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'copy-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}
