const CAPTURE_MS = 750; // respects ~2 captureVisibleTab calls/sec limit

// In-memory stores — avoids chrome.storage.session quota limits
const _captures = new Map(); // uuid → { dataUrl, title, url, timestamp }
let _batchResults = [];      // full results with dataUrls, for ZIP download

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'start-capture') {
    runSingleCapture(msg.options || {}).catch(err => openErrorTab(err.message));
    sendResponse({ started: true });
    return false;
  }
  if (msg.action === 'start-batch') {
    runBatch(msg.items, msg.options || {}).catch(err => console.error('[FPS] batch:', err));
    sendResponse({ started: true });
    return false;
  }
  if (msg.action === 'get-screenshot') {
    const data = _captures.get(msg.id) || { error: 'Screenshot data expired. Try capturing again.' };
    _captures.delete(msg.id);
    sendResponse(data);
    return true;
  }
  if (msg.action === 'get-batch-results') {
    sendResponse({ results: _batchResults });
    return true;
  }
});

// ── Single capture ────────────────────────────────────────────────────────────

async function runSingleCapture(options) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');

  const vp = options.viewport;
  let captureTabId = tab.id;
  let captureWindowId = tab.windowId;
  let ownWindow = false;

  if (vp) {
    const win = await chrome.windows.create({ url: tab.url, type: 'popup', width: vp.width, height: 900, focused: false });
    ownWindow = true;
    captureWindowId = win.id;
    const [winTab] = await chrome.tabs.query({ windowId: win.id });
    captureTabId = winTab.id;
    await waitForTabLoad(captureTabId);
    await sleep(1000);
  }

  try {
    const dataUrl = await captureFullPage(captureTabId, captureWindowId, options);
    const id = crypto.randomUUID();
    _captures.set(id, { dataUrl, title: tab.title || 'Screenshot', url: tab.url, timestamp: Date.now() });
    chrome.tabs.create({ url: chrome.runtime.getURL(`preview/preview.html?id=${id}`) });
  } finally {
    if (ownWindow) chrome.windows.remove(captureWindowId).catch(() => {});
  }
}

// ── Batch capture ─────────────────────────────────────────────────────────────

async function runBatch(items, options) {
  _batchResults = [];
  await chrome.tabs.create({ url: chrome.runtime.getURL('batch/batch.html') });
  await setBatchProgress({ total: items.length, current: 0, results: [], status: 'running' });
  await sleep(700);

  const vp = options.viewport;
  const winWidth = vp ? vp.width : 1440;

  const win = await chrome.windows.create({ url: 'about:blank', type: 'popup', width: winWidth, height: 900, focused: false });
  const displayResults = []; // metadata + small thumbnails only (safe for session storage)

  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      await setBatchProgress({
        total: items.length, current: i + 1,
        currentLabel: [item.product, item.url].filter(Boolean).join(' — '),
        results: [...displayResults], status: 'running',
      });

      try {
        const [winTab] = await chrome.tabs.query({ windowId: win.id });
        await chrome.tabs.update(winTab.id, { url: item.url, active: true });
        await waitForTabLoad(winTab.id);
        await sleep(1500);
        const dataUrl = await captureFullPage(winTab.id, win.id, options);

        // Small JPEG thumbnail for display (stays in session storage safely)
        const thumb = await createThumbnail(dataUrl, 160);

        _batchResults.push({ ...item, dataUrl, status: 'success' });
        displayResults.push({ ...item, thumb, status: 'success' });
      } catch (err) {
        console.error('[FPS] item:', item.url, err.message);
        _batchResults.push({ ...item, status: 'error', error: err.message });
        displayResults.push({ ...item, status: 'error', error: err.message });
      }
    }
  } finally {
    chrome.windows.remove(win.id).catch(() => {});
  }

  await setBatchProgress({ total: items.length, current: items.length, results: displayResults, status: 'done' });
}

async function setBatchProgress(data) {
  await chrome.storage.session.set({ batchProgress: data });
}

// ── Core capture ──────────────────────────────────────────────────────────────

async function captureFullPage(tabId, windowId, options = {}) {
  const { delay = 0, prePass = false } = options;

  if (prePass) {
    const info0 = await getPageInfo(tabId);
    await doPrePass(tabId, info0.totalHeight, info0.viewportHeight);
  }

  if (delay > 0) await sleep(delay * 1000);

  const info = await getPageInfo(tabId);
  return captureAndStitch(tabId, windowId, info);
}

async function captureAndStitch(tabId, windowId, info) {
  const { totalWidth, totalHeight, viewportWidth, viewportHeight, devicePixelRatio: dpr, scrollX: ox, scrollY: oy } = info;
  const maxX = Math.max(0, totalWidth  - viewportWidth);
  const maxY = Math.max(0, totalHeight - viewportHeight);
  const tiles = [];

  // Convert fixed→absolute and sticky→relative so they don't repeat on every tile.
  // Fixed elements are out of flow, so this doesn't change scroll dimensions.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      window.__fps_pos__ = [];
      document.querySelectorAll('*').forEach(el => {
        const pos = getComputedStyle(el).position;
        if (pos !== 'fixed' && pos !== 'sticky') return;
        window.__fps_pos__.push([el, el.style.getPropertyValue('position'), el.style.getPropertyPriority('position')]);
        el.style.setProperty('position', pos === 'fixed' ? 'absolute' : 'relative', 'important');
      });
    },
  }).catch(() => {});

  try {
    let y = 0;
    while (true) {
      const sy = Math.min(y, maxY);
      let x = 0;
      while (true) {
        const sx = Math.min(x, maxX);
        await scrollPage(tabId, sx, sy);
        await sleep(CAPTURE_MS);
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        tiles.push({ dataUrl, x: sx, y: sy });
        if (sx >= maxX) break;
        x += viewportWidth;
      }
      if (sy >= maxY) break;
      y += viewportHeight;
    }
  } finally {
    // Restore original position values before scrolling back
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        (window.__fps_pos__ || []).forEach(([el, val, priority]) => {
          if (val) el.style.setProperty('position', val, priority);
          else el.style.removeProperty('position');
        });
        delete window.__fps_pos__;
      },
    }).catch(() => {});
    await restoreScroll(tabId, ox, oy);
  }

  return stitchTiles(tiles, totalWidth, totalHeight, dpr);
}

// ── Pre-pass (slow scroll to trigger lazy-load / animations) ─────────────────

async function doPrePass(tabId, totalHeight, viewportHeight) {
  const step = viewportHeight * 0.8;
  for (let y = step; y <= totalHeight + viewportHeight; y += step) {
    await scrollPage(tabId, 0, Math.min(y, totalHeight));
    await sleep(350);
  }
  await scrollPage(tabId, 0, 0);
  await sleep(600);
}

// ── Page interaction ──────────────────────────────────────────────────────────

async function getPageInfo(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      totalWidth:       document.documentElement.scrollWidth,
      totalHeight:      document.documentElement.scrollHeight,
      viewportWidth:    window.innerWidth,
      viewportHeight:   window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX:          window.scrollX,
      scrollY:          window.scrollY,
    }),
  });
  return result;
}

async function scrollPage(tabId, x, y) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sx, sy) => {
      window.scrollTo({ left: sx, top: sy, behavior: 'instant' });
      return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    args: [x, y],
  });
}

async function restoreScroll(tabId, x, y) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sx, sy) => window.scrollTo({ left: sx, top: sy, behavior: 'instant' }),
    args: [x, y],
  }).catch(() => {});
}

async function waitForTabLoad(tabId, timeout = 30000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Page load timed out (30s)'));
    }, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Stitching (OffscreenCanvas, no offscreen document needed) ────────────────

async function stitchTiles(tiles, totalWidth, totalHeight, dpr) {
  const canvas = new OffscreenCanvas(Math.round(totalWidth * dpr), Math.round(totalHeight * dpr));
  const ctx = canvas.getContext('2d');
  for (const tile of tiles) {
    const bitmap = await createImageBitmap(dataUrlToBlob(tile.dataUrl));
    ctx.drawImage(bitmap, Math.round(tile.x * dpr), Math.round(tile.y * dpr));
    bitmap.close();
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(blob);
}

async function createThumbnail(dataUrl, maxWidth) {
  const srcBlob = dataUrlToBlob(dataUrl);
  const bitmap  = await createImageBitmap(srcBlob);
  const scale   = Math.min(1, maxWidth / bitmap.width);
  const w = Math.round(bitmap.width  * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return blobToDataUrl(thumbBlob);
}

function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime  = header.match(/:(.*?);/)[1];
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  const buf   = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary  = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function openErrorTab(msg) {
  console.error('[FPS]', msg);
  chrome.tabs.create({ url: chrome.runtime.getURL(`preview/preview.html?error=${encodeURIComponent(msg)}`) });
}
