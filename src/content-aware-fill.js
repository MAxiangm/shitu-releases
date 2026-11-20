(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituContentAwareFill = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_PIXELS = 16777216, MAX_SIDE = 768;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function abort(signal) {
    if (!signal?.aborted) return;
    const error = new Error('智能填充已取消'); error.name = 'AbortError'; throw error;
  }
  function pause() { return new Promise(resolve => setTimeout(resolve, 0)); }
  function validate(image, mask, options) {
    if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width * image.height > MAX_PIXELS) {
      throw new Error('智能填充最多支持 1677 万像素的有效图片');
    }
    const bytes = value => ArrayBuffer.isView(value) && ['[object Uint8Array]', '[object Uint8ClampedArray]'].includes(Object.prototype.toString.call(value));
    if (!bytes(image.data) || image.data.length !== image.width * image.height * 4) throw new Error('智能填充需要 RGBA 图片');
    if (!bytes(mask) || mask.length !== image.width * image.height) throw new Error('智能填充选区无效');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('智能填充参数无效');
  }

  /** Fill selected pixels with patches sampled from outside the selection.
   * Masks use 0=keep, 255=replace, with fractional coverage for feathering.
   * Large images synthesize at <=768px then interpolate only the selected pixels.
   */
  async function fill(image, mask, options = {}) {
    validate(image, mask, options);
    const { width, height, data } = image, signal = options.signal;
    const progress = value => { if (typeof options.onProgress === 'function') options.onProgress(value); };
    abort(signal); progress(0);
    let selected = 0, unselected = 0;
    for (let i = 0; i < mask.length; i++) { if (mask[i]) selected++; else unselected++; }
    if (!selected) { progress(1); return { width, height, data: new Uint8ClampedArray(data) }; }
    if (!unselected) throw new Error('智能填充需要选区外的参考内容，请缩小选区后重试');
    await pause(); abort(signal);
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale)), size = w * h;
    const source = new Uint8ClampedArray(size * 4), work = new Uint8ClampedArray(size * 4);
    const known = new Uint8Array(size), initial = new Uint8Array(size), coverage = new Uint32Array(size);
    const counts = new Uint32Array(size), sums = new Float64Array(size * 4);
    // Downsample only unselected source samples, so selected objects cannot leak
    // into the donor texture at low resolution.
    for (let y = 0; y < height; y++) {
      const yy = Math.min(h - 1, Math.floor(y * h / height));
      for (let x = 0; x < width; x++) {
        const s = y * width + x, i = yy * w + Math.min(w - 1, Math.floor(x * w / width));
        counts[i]++;
        if (mask[s]) continue;
        coverage[i]++;
        const alpha = data[s * 4 + 3];
        for (let c = 0; c < 3; c++) sums[i * 4 + c] += data[s * 4 + c] * alpha;
        sums[i * 4 + 3] += alpha;
      }
      if (y % 128 === 127) { await pause(); abort(signal); }
    }
    let knownCount = 0;
    for (let i = 0; i < size; i++) {
      if (coverage[i]) {
        const alpha = sums[i * 4 + 3];
        for (let c = 0; c < 3; c++) source[i * 4 + c] = alpha ? Math.round(sums[i * 4 + c] / alpha) : 0;
        source[i * 4 + 3] = Math.round(alpha / coverage[i]);
      }
      known[i] = coverage[i] >= counts[i] / 2 && coverage[i] > 0 ? 1 : 0;
      knownCount += known[i];
    }
    // A very narrow remaining source strip can be smaller than one work pixel.
    if (!knownCount) for (let i = 0; i < size; i++) { known[i] = coverage[i] ? 1 : 0; knownCount += known[i]; }
    if (!knownCount) throw new Error('选区外可用的参考区域太小，请缩小选区后重试');
    work.set(source); initial.set(known);
    progress(0.08); await pause(); abort(signal);

    let remaining = size - knownCount;
    if (remaining) {
      const integral = new Uint32Array((w + 1) * (h + 1));
      for (let y = 0; y < h; y++) {
        let sum = 0;
        for (let x = 0; x < w; x++) {
          sum += initial[y * w + x] ? 0 : 1;
          integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + sum;
        }
      }
      let radius = Math.min(3, Math.floor((w - 1) / 2), Math.floor((h - 1) / 2)), donors;
      const validDonor = new Uint8Array(size);
      for (; radius >= 0; radius--) {
        donors = [];
        for (let y = radius; y < h - radius; y++) for (let x = radius; x < w - radius; x++) {
          const x0 = x - radius, y0 = y - radius, x1 = x + radius + 1, y1 = y + radius + 1;
          const missing = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
          if (!missing) donors.push(y * w + x);
        }
        if (donors.length) break;
      }
      for (const i of donors) validDonor[i] = 1;
      const donorAt = new Int32Array(size).fill(-1);
      for (let i = 0; i < size; i++) if (initial[i]) donorAt[i] = i;
      const queued = new Uint8Array(size), queue = new Int32Array(size);
      let read = 0, write = 0;
      function enqueue(i) {
        if (i < 0 || i >= size || known[i] || queued[i]) return;
        queued[i] = 1; queue[write++] = i;
      }
      function neighbors(i) {
        const x = i % w;
        if (x) enqueue(i - 1);
        if (x < w - 1) enqueue(i + 1);
        enqueue(i - w); enqueue(i + w);
      }
      for (let i = 0; i < size; i++) if (known[i]) neighbors(i);
      let randomState = 0x65a1b42d;
      function random(limit) {
        randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
        return (randomState >>> 0) % limit;
      }
      const stencil = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1], [-2, 0], [2, 0], [0, -2], [0, 2]];
      const total = remaining;
      let lastYield = Date.now();
      while (remaining) {
        abort(signal);
        if (read >= write) throw new Error('智能填充无法到达选区，请换一个较小选区重试');
        const target = queue[read++];
        if (known[target]) continue;
        const x = target % w, y = Math.floor(target / w), samples = [];
        for (const [dx, dy] of stencil) {
          const xx = x + dx, yy = y + dy, i = yy * w + xx;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h && known[i]) samples.push({ dx, dy, i });
        }
        let best = donors[random(donors.length)], bestError = Infinity;
        function consider(candidate) {
          if (candidate < 0 || candidate >= size || !validDonor[candidate]) return;
          const cx = candidate % w, cy = Math.floor(candidate / w);
          let error = 0, count = 0;
          for (const sample of samples) {
            const sx = cx + sample.dx, sy = cy + sample.dy, q = sy * w + sx;
            if (sx < 0 || sx >= w || sy < 0 || sy >= h || !initial[q]) continue;
            const p = sample.i * 4, sp = q * 4;
            for (let c = 0; c < 4; c++) { const difference = work[p + c] - source[sp + c]; error += difference * difference; }
            count++;
          }
          if (samples.length && !count) return;
          error = error / Math.max(1, count) + ((cx - x) ** 2 + (cy - y) ** 2) * 0.001;
          if (error < bestError) { bestError = error; best = candidate; }
        }
        // Propagated matches preserve nearby texture alignment; randomized
        // candidates let the frontier find a better patch elsewhere.
        for (const sample of samples) {
          const donor = donorAt[sample.i];
          if (donor < 0) continue;
          const xx = donor % w - sample.dx, yy = Math.floor(donor / w) - sample.dy;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h) consider(yy * w + xx);
        }
        for (let c = 0; c < 40; c++) consider(donors[random(donors.length)]);
        const bx = best % w, by = Math.floor(best / w), copyRadius = Math.max(1, radius);
        for (let dy = -copyRadius; dy <= copyRadius; dy++) for (let dx = -copyRadius; dx <= copyRadius; dx++) {
          const tx = x + dx, ty = y + dy, sx = bx + dx, sy = by + dy;
          if (tx < 0 || tx >= w || ty < 0 || ty >= h || sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          const i = ty * w + tx, donor = sy * w + sx;
          if (known[i] || !initial[donor]) continue;
          work.set(source.subarray(donor * 4, donor * 4 + 4), i * 4);
          known[i] = 1; donorAt[i] = donor; remaining--; neighbors(i);
        }
        if (Date.now() - lastYield > 12) {
          progress(0.08 + 0.84 * (1 - remaining / total)); await pause(); abort(signal); lastYield = Date.now();
        }
      }
    }
    progress(0.93); await pause(); abort(signal);
    const output = new Uint8ClampedArray(data);
    for (let y = 0; y < height; y++) {
      const fy = clamp((y + 0.5) * h / height - 0.5, 0, h - 1), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ay = fy - y0;
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!mask[i]) continue;
        const fx = clamp((x + 0.5) * w / width - 0.5, 0, w - 1), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), ax = fx - x0;
        const points = [y0 * w + x0, y0 * w + x1, y1 * w + x0, y1 * w + x1];
        const weights = [(1 - ax) * (1 - ay), ax * (1 - ay), (1 - ax) * ay, ax * ay];
        let alpha = 0; const color = [0, 0, 0];
        for (let k = 0; k < 4; k++) {
          const p = points[k] * 4, a = work[p + 3] / 255 * weights[k]; alpha += a;
          for (let c = 0; c < 3; c++) color[c] += work[p + c] * a;
        }
        const amount = mask[i] / 255, oldAlpha = data[i * 4 + 3] / 255 * (1 - amount), newAlpha = alpha * amount, combined = oldAlpha + newAlpha;
        for (let c = 0; c < 3; c++) output[i * 4 + c] = combined ? Math.round((data[i * 4 + c] * oldAlpha + (alpha ? color[c] / alpha : 0) * newAlpha) / combined) : 0;
        output[i * 4 + 3] = Math.round(combined * 255);
      }
      if (y % 128 === 127) { await pause(); abort(signal); }
    }
    progress(1);
    return { width, height, data: output };
  }
  return Object.freeze({ fill, MAX_PIXELS, MAX_SIDE });
});
