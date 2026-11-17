'use strict';
(() => {
  let viewer;
  const ready = import('./model-viewer.js');
  window.renderModelThumbnail = async options => {
    const { create } = await ready;
    viewer ||= create(document.getElementById('modelThumbnailRoot'), { pixelRatio: 1 });
    const metadata = await viewer.load(options);
    viewer.resize();
    return { dataUrl: viewer.captureJPEG({ quality: 0.88 }), metadata };
  };
  window.disposeModelThumbnail = () => { viewer?.dispose(); viewer = null; };
})();
