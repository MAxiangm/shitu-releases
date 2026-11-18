'use strict';
(() => {
  let viewer;
  const ready = import('./model-viewer.js');
  async function load(options) {
    const { create } = await ready;
    viewer ||= create(document.getElementById('modelThumbnailRoot'), { pixelRatio: 1 });
    const metadata = await viewer.load(options);
    viewer.resize();
    return metadata;
  }
  window.renderModelThumbnail = async options => {
    const metadata = await load(options);
    return { dataUrl: viewer.captureJPEG({ quality: 0.88 }), metadata };
  };
  window.renderModelTurntable = async (options, frameCount) => {
    await load(options);
    return viewer.captureTurntable(frameCount);
  };
  window.disposeModelThumbnail = () => { viewer?.dispose(); viewer = null; };
})();
