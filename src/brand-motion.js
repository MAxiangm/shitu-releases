(() => {
  'use strict';

  const items = Array.from(document.querySelectorAll('[data-brand-motion]'), mark =>
    ({ mark, layer: mark.querySelector('.brand-mark-motion'), animation: null })
  );
  if (!items.length || !CSS.supports('mask-position', '50% 50%')) return;

  // The approved eight-second clip contains 240 frames at 30 fps.
  const columns = 16, rows = 15, frames = columns * rows;
  const keyframes = Array.from({ length: frames + 1 }, (_, index) => {
    const frame = Math.min(index, frames - 1);
    const x = frame % columns * 100 / (columns - 1);
    const y = Math.floor(frame / columns) * 100 / (rows - 1);
    return { offset: index / frames, maskPosition: `${x}% ${y}%`, easing: 'step-end' };
  });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const preferenceKey = 'shitu-brand-motion';
  const motionButton = document.getElementById('brandMotionButton');
  const motionLabel = document.getElementById('brandMotionLabel');
  let preference = localStorage.getItem(preferenceKey);
  let loaded = false, windowVisible = true, pageActive = true;

  function motionAllowed() {
    if (preference === 'on') return true;
    if (preference === 'off') return false;
    return !reducedMotion.matches;
  }

  function sync() {
    const allowed = motionAllowed();
    motionButton.setAttribute('aria-pressed', String(allowed));
    motionButton.title = !preference && reducedMotion.matches
      ? 'Windows 动画效果已关闭，点击可单独开启标志动效'
      : '开启或暂停 Mosaic 标志动效';
    motionLabel.textContent = allowed ? '标志动效：开' : '标志动效：关';
    const enabled = loaded && !document.hidden && windowVisible && pageActive && allowed;
    for (const item of items) {
      const playing = enabled && !item.mark.closest('.hidden, [hidden]');
      if (playing) {
        item.animation ||= item.layer.animate(keyframes, { duration: 8000, iterations: Infinity });
        if (item.animation.playState === 'paused') item.animation.play();
      } else if (item.animation?.playState === 'running') item.animation.pause();
      item.mark.dataset.brandMotion = playing ? 'playing' : 'paused';
    }
  }

  motionButton.addEventListener('click', () => {
    preference = motionAllowed() ? 'off' : 'on';
    localStorage.setItem(preferenceKey, preference);
    sync();
  });
  const observer = new MutationObserver(sync);
  const onboarding = document.getElementById('libraryOnboarding');
  if (onboarding) observer.observe(onboarding, { attributes: true, attributeFilter: ['class', 'hidden'] });
  document.addEventListener('visibilitychange', sync);
  window.shitu?.onWindowVisibility?.(visible => { windowVisible = visible; sync(); });
  reducedMotion.addEventListener('change', sync);
  window.addEventListener('pagehide', () => { pageActive = false; sync(); });
  window.addEventListener('pageshow', () => { pageActive = true; sync(); });

  sync();
  const image = new Image();
  image.src = new URL('../assets/mosaic-logo-motion.png', document.baseURI).href;
  image.decode().then(() => { loaded = true; sync(); }).catch(() => {});
})();
