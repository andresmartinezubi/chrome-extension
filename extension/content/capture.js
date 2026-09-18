chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'get-page-info') {
    sendResponse({
      totalWidth: document.documentElement.scrollWidth,
      totalHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    });
    return false;
  }

  if (message.action === 'scroll-to') {
    window.scrollTo({ left: message.x, top: message.y, behavior: 'instant' });
    // Two rAF cycles to ensure layout and paint are done
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      .then(() => sendResponse({ x: window.scrollX, y: window.scrollY }));
    return true;
  }
});
