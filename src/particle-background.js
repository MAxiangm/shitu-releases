'use strict';

// A procedural backdrop: all points and strands are drawn locally, behind UI.
(() => {
  const canvas = document.getElementById('ambientParticles');
  let ctx = canvas?.getContext('2d', { alpha: true });
  if (!ctx) return;
  const motionButton = document.getElementById('backgroundMotionButton');
  let motionEnabled = localStorage.getItem('shitu-background-motion') !== 'off';
  const ribbons = [
    { x: .08, phase: .7, width: .16 },
    { x: .38, phase: 3.4, width: .20 },
    { x: .72, phase: 5.5, width: .17 },
    { x: 1.02, phase: 2.2, width: .19 },
  ];
  const MAX_BACKING_PIXELS = 4_000_000;
  let width = 1, height = 1, dpr = 1, frame = 0, resizeFrame = 0, lastDraw = 0, elapsed = 0, draws = 0;
  let contextLost = false, pageActive = true;
  let particles = [], seed = 197311, appVisible = true;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const glow = document.createElement('canvas');
  glow.width = glow.height = 48;
  const glowContext = glow.getContext('2d');
  const halo = glowContext.createRadialGradient(24, 24, 0, 24, 24, 24);
  halo.addColorStop(0, '#e9f8f5cc'); halo.addColorStop(.12, '#c8e7e080');
  halo.addColorStop(.4, '#9bc6be24'); halo.addColorStop(1, '#9bc6be00');
  glowContext.fillStyle = halo; glowContext.fillRect(0, 0, 48, 48);

  function point(ribbon, u, v, time) {
    const phase = ribbon.phase;
    const fold = u * 8.6 + phase + Math.sin(time * .22 + phase) * .48;
    const breadth = width * ribbon.width * (.66 + .23 * Math.sin(u * 6 + phase + time * .16));
    return {
      x: width * ribbon.x + Math.sin(u * 6.3 + phase + time * .18) * width * .115 + v * breadth * Math.cos(fold),
      y: u * (height + 200) - 100 + Math.sin(u * 4.2 + phase + time * .14) * height * .045 + v * breadth * .42 * Math.sin(fold),
      depth: .5 + .5 * Math.sin(fold + v * .8),
    };
  }
  function resize(force = false) {
    width = Math.max(1, innerWidth); height = Math.max(1, innerHeight);
    // The backdrop is decorative. Bound its GPU backing store on 4K/HiDPI
    // screens rather than keeping a full-resolution surface alive all day.
    dpr = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(MAX_BACKING_PIXELS / (width * height)));
    const nextWidth = Math.max(1, Math.floor(width * dpr)), nextHeight = Math.max(1, Math.floor(height * dpr));
    if (!force && canvas.width === nextWidth && canvas.height === nextHeight) return;
    if (contextLost || !ctx) return;
    canvas.width = nextWidth; canvas.height = nextHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed = 197311;
    const count = Math.max(1400, Math.min(3200, Math.round(width * height / 450)));
    particles = Array.from({ length: count }, (_, i) => ({
      ribbon: ribbons[i % ribbons.length], u: random(), v: (random() + random() - 1) * 1.12,
      drift: .009 + random() * .009, phase: random() * Math.PI * 2,
      size: .45 + random() * .85, light: .15 + random() * .45,
      glow: random() > .994,
    }));
    canvas.dataset.particleCount = String(particles.length);
    draw();
  }
  function scheduleResize() {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; resize(); });
  }
  function draw() {
    if (contextLost || !ctx || ctx.isContextLost?.()) return;
    const started = performance.now();
    const sample = { strands: [], particles: [] };
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = .55;
    for (let r = 0; r < ribbons.length; r++) {
      const ribbon = ribbons[r];
      for (let strand = 0; strand < 34; strand++) {
        const v = strand / 33 * 2 - 1;
        ctx.strokeStyle = `rgba(164,193,191,${.055 + (1 - Math.abs(v)) * .075})`;
        ctx.beginPath();
        for (let segment = 0; segment <= 85; segment++) {
          const p = point(ribbon, segment / 85, v, elapsed);
          if (r < 3 && strand === 17 && segment === 34) sample.strands.push({ x: p.x, y: p.y });
          if (!segment) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
    }
    for (let index = 0; index < particles.length; index++) {
      const particle = particles[index];
      const u = (particle.u + elapsed * particle.drift) % 1;
      const v = particle.v + Math.sin(elapsed * .28 + particle.phase) * .018;
      const p = point(particle.ribbon, u, v, elapsed);
      if (index < 3) sample.particles.push({ x: p.x, y: p.y });
      const shimmer = .8 + Math.sin(elapsed * .5 + particle.phase) * .2;
      const alpha = particle.light * (.35 + p.depth * .65) * shimmer;
      ctx.fillStyle = `rgba(201,223,219,${alpha})`;
      ctx.fillRect(p.x, p.y, particle.size, particle.size);
      if (particle.glow) {
        ctx.globalAlpha = .45 * shimmer;
        ctx.drawImage(glow, p.x - 9, p.y - 9, 18, 18);
        ctx.globalAlpha = 1;
      }
    }
    // Keep the central title quiet while the folds remain visible around it.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    const quiet = ctx.createRadialGradient(width * .5, height * .22, 0, width * .5, height * .22, width * .4);
    quiet.addColorStop(0, '#0009'); quiet.addColorStop(.6, '#0002'); quiet.addColorStop(1, '#0000');
    ctx.fillStyle = quiet; ctx.fillRect(0, 0, width, height);
    ctx.restore();
    canvas.dataset.frame = String(++draws);
    canvas.dataset.time = elapsed.toFixed(3);
    canvas.dataset.drawMs = (performance.now() - started).toFixed(2);
    canvas.dataset.motionSample = JSON.stringify(sample);
  }
  function tick(now) {
    frame = 0;
    if (document.hidden || !appVisible || !pageActive || !motionEnabled || contextLost) return;
    if (!lastDraw || now - lastDraw >= 1000 / 24) {
      elapsed += lastDraw ? Math.min(.1, (now - lastDraw) / 1000) : 0;
      lastDraw = now;
      draw();
    }
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    cancelAnimationFrame(frame); frame = 0; lastDraw = 0;
    canvas.dataset.status = contextLost ? 'context-lost' : document.hidden || !appVisible || !pageActive || !motionEnabled ? 'paused' : 'running';
    if (!document.hidden && appVisible && pageActive && motionEnabled && !contextLost) frame = requestAnimationFrame(tick);
    else if (!document.hidden && appVisible && pageActive && !contextLost) draw();
  }
  function updateButton() {
    motionButton?.setAttribute('aria-pressed', String(motionEnabled));
    const label = document.getElementById('backgroundMotionLabel');
    if (label) label.textContent = motionEnabled ? '动效：开' : '动效：关';
  }
  motionButton?.addEventListener('click', () => {
    motionEnabled = !motionEnabled;
    localStorage.setItem('shitu-background-motion', motionEnabled ? 'on' : 'off');
    updateButton(); sync();
  });
  addEventListener('resize', scheduleResize);
  document.addEventListener('visibilitychange', sync);
  window.shitu?.onWindowVisibility?.(visible => { appVisible = visible; sync(); });
  canvas.addEventListener('contextlost', () => {
    // Do not cancel this Canvas2D event: its default action restores the buffer.
    contextLost = true;
    cancelAnimationFrame(resizeFrame); resizeFrame = 0;
    sync();
  });
  canvas.addEventListener('contextrestored', () => {
    ctx = canvas.getContext('2d', { alpha: true });
    contextLost = !ctx;
    if (!contextLost) resize(true);
    sync();
  });
  addEventListener('pagehide', () => { pageActive = false; cancelAnimationFrame(resizeFrame); resizeFrame = 0; sync(); });
  addEventListener('pageshow', () => { pageActive = true; resize(); sync(); });
  updateButton(); resize(); sync();
})();
