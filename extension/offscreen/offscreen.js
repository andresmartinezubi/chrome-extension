chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'offscreen' || message.action !== 'stitch-tiles') return;

  const { tiles, totalWidth, totalHeight, dpr } = message;

  stitchTiles(tiles, totalWidth, totalHeight, dpr)
    .then(dataUrl => chrome.runtime.sendMessage({ action: 'stitch-complete', dataUrl }))
    .catch(err => chrome.runtime.sendMessage({ action: 'stitch-error', error: err.message }));
});

async function stitchTiles(tiles, totalWidth, totalHeight, dpr) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(totalWidth * dpr);
  canvas.height = Math.round(totalHeight * dpr);
  const ctx = canvas.getContext('2d');

  for (const tile of tiles) {
    const img = await loadImage(tile.dataUrl);
    ctx.drawImage(img, Math.round(tile.x * dpr), Math.round(tile.y * dpr));
  }

  return canvas.toDataURL('image/png');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load tile image'));
    img.src = src;
  });
}
