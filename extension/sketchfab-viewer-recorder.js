(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (api.modelIdFromUrl(root.location?.href)) api.installSketchfabViewerRecorder(root);
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const DEFAULTS = Object.freeze({ maxVertices: 1000000, maxMeshes: 512, maxImages: 128,
    maxImageBytes: 32 * 1024 * 1024, maxJsonBytes: 48 * 1024 * 1024, maxShadowBytes: 128 * 1024 * 1024,
    maxTexturePixels: 4096 * 4096, maxIndices: 3000000, waitMs: 700, minRequestInterval: 1200 });
  const C = { ARRAY: 34962, ELEMENT: 34963, TEXTURE_2D: 3553, TEXTURE0: 33984, FLOAT: 5126,
    BYTE: 5120, UBYTE: 5121, SHORT: 5122, USHORT: 5123, INT: 5124, UINT: 5125, HALF: 5131,
    TRIANGLES: 4, STRIP: 5, FAN: 6, RGBA: 6408, RGB: 6407, SAMPLER_2D: 35678 };
  function failure(code) { return Object.assign(new Error(code), { code }); }
  function modelIdFromUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !['sketchfab.com', 'www.sketchfab.com'].includes(url.hostname) || url.port || url.username || url.password) return null;
      return /^\/models\/([a-f0-9]{32})\/embed\/?$/.exec(url.pathname)?.[1] ||
        /(?:^|-)([a-f0-9]{32})$/.exec(/^\/3d-models\/([^/]+)\/?$/.exec(url.pathname)?.[1] || '')?.[1] || null;
    } catch { return null; }
  }
  function cleanName(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function semantic(name) {
    name = cleanName(name);
    if (/(?:vertex|position|positions)0?$/.test(name) && !/morph|instance|previous/.test(name)) return 'position';
    if (/normal0?$/.test(name) && !/tangent|binormal/.test(name)) return 'normal';
    if (/(?:texcoord0|texcoord|uv0|uv)$/.test(name)) return 'uv';
    return null;
  }
  function half(value) {
    const sign = value & 0x8000 ? -1 : 1, e = value >> 10 & 31, m = value & 1023;
    return e === 31 ? (m ? NaN : sign * Infinity) : e ? sign * Math.pow(2, e - 15) * (1 + m / 1024) : sign * Math.pow(2, -14) * m / 1024;
  }
  function elementSize(type) { return ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5124: 4, 5125: 4, 5126: 4, 5131: 2, 36193: 2 })[type] || 0; }
  function readComponent(view, offset, type, normalized) {
    let value;
    switch (type) {
      case C.FLOAT: return view.getFloat32(offset, true);
      case C.HALF: case 36193: return half(view.getUint16(offset, true));
      case C.BYTE: value = view.getInt8(offset); return normalized ? Math.max(-1, value / 127) : value;
      case C.UBYTE: value = view.getUint8(offset); return normalized ? value / 255 : value;
      case C.SHORT: value = view.getInt16(offset, true); return normalized ? Math.max(-1, value / 32767) : value;
      case C.USHORT: value = view.getUint16(offset, true); return normalized ? value / 65535 : value;
      case C.INT: value = view.getInt32(offset, true); return normalized ? Math.max(-1, value / 2147483647) : value;
      case C.UINT: value = view.getUint32(offset, true); return normalized ? value / 4294967295 : value;
      default: throw failure('SKETCHFAB_VIEWER_UNSUPPORTED');
    }
  }
  function sourceBytes(value, offset = 0, length) {
    if (value instanceof ArrayBuffer) {
      if (offset || length !== undefined) throw failure('SKETCHFAB_VIEWER_INVALID');
      return new Uint8Array(value);
    }
    if (!ArrayBuffer.isView(value)) return null;
    const unit = value.BYTES_PER_ELEMENT || 1;
    const size = length === undefined || length === 0 ? value.byteLength - offset * unit : length * unit;
    if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset * unit + size > value.byteLength) throw failure('SKETCHFAB_VIEWER_INVALID');
    return new Uint8Array(value.buffer, value.byteOffset + offset * unit, size);
  }
  function installSketchfabViewerRecorder(scope, options = {}) {
    if (!scope || !modelIdFromUrl(scope.location?.href)) return null;
    const limits = { ...DEFAULTS, ...options };
    let currentId = modelIdFromUrl(scope.location.href), contexts = new Set(), states = new WeakMap();
    let shadowBytes = 0, nextId = 1, pending = null, disposed = false, lastRequest = -Infinity, unsupportedAt = -Infinity, tooLargeAt = -Infinity, capacityExceeded = false;
    let animationFrame = null, outsideFrame = 0, outsideBurst = false;
    const warnings = new Set(), restorers = [], seenRequests = new Set();
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const timeout = scope.setTimeout?.bind(scope) || setTimeout;
    const warn = message => { if (warnings.size < 64) warnings.add(message); };
    function syncModel() {
      const selected = modelIdFromUrl(scope.location?.href);
      if (selected !== currentId) {
        currentId = selected; contexts = new Set(); states = new WeakMap(); shadowBytes = 0; unsupportedAt = -Infinity; tooLargeAt = -Infinity; capacityExceeded = false; warnings.clear(); seenRequests.clear();
        if (pending) pending.changed = true;
      }
      return currentId;
    }
    function state(gl) {
      if (!syncModel() || disposed) return null;
      let value = states.get(gl);
      if (!value) {
        if (contexts.size >= 8) { capacityExceeded = true; return null; }
        value = { gl, isWebGL2: Boolean(scope.WebGL2RenderingContext && gl instanceof scope.WebGL2RenderingContext), buffers: new Map(), bindings: new Map(), vaos: new Map(), vao: null, programs: new Map(), program: null,
          textures: new Map(), units: new Map(), activeUnit: 0, unpackFlip: false, draws: new Map() };
        value.vaos.set(null, { attributes: new Map(), element: null }); states.set(gl, value); contexts.add(value);
      }
      return value;
    }
    const vao = s => s.vaos.get(s.vao) || s.vaos.get(null);
    function hook(object, name, after) {
      if (!object || typeof object[name] !== 'function') return;
      const original = object[name];
      if (original.__mosaicViewerHook) return;
      function wrapped(...args) {
        const result = original.apply(this, args);
        try { after(this, args, result); } catch { warn('部分绘图数据无法记录，导出可能不完整。'); }
        return result;
      }
      Object.defineProperty(wrapped, '__mosaicViewerHook', { value: true });
      try { object[name] = wrapped; } catch { return; }
      restorers.push(() => { if (object[name] === wrapped) object[name] = original; });
    }
    function buffer(s, object) {
      if (!object) return null;
      if (!s.buffers.has(object)) { if (s.buffers.size >= 16384) { capacityExceeded = true; return null; } s.buffers.set(object, { id: nextId++, bytes: null, version: 0 }); }
      return s.buffers.get(object);
    }
    function uploadBuffer(gl, args, sub) {
      const s = state(gl); if (!s) return;
      const target = args[0], object = target === C.ELEMENT ? vao(s).element : s.bindings.get(target), info = buffer(s, object);
      if (!info) return;
      const value = args[sub ? 2 : 1], offset = sub ? args[1] : 0;
      const bytes = typeof value === 'number' && !sub ? null : sourceBytes(value, args[sub ? 3 : 3] || 0, args[sub ? 4 : 4]);
      const length = bytes?.byteLength ?? (Number.isSafeInteger(value) && value >= 0 ? value : 0);
      info.version++;
      if (sub) {
        if (!info.bytes || !bytes || !Number.isSafeInteger(offset) || offset < 0 || offset + length > info.bytes.length) { info.incomplete = true; return; }
        info.bytes.set(bytes, offset); return;
      }
      shadowBytes -= info.bytes?.byteLength || 0; info.bytes = null; info.incomplete = false;
      if (length > limits.maxShadowBytes || shadowBytes + length > limits.maxShadowBytes) { info.incomplete = true; warn('绘图缓冲超过记录上限。'); return; }
      info.bytes = new Uint8Array(length); if (bytes) info.bytes.set(bytes); shadowBytes += length;
    }
    function program(s, object) {
      if (!object) return null;
      if (!s.programs.has(object)) { if (s.programs.size >= 512) { capacityExceeded = true; return null; } s.programs.set(object, { id: nextId++, attributes: new Map(), locations: new Map(), uniforms: new Map(), samplers: new Set(), unsupported: false }); }
      return s.programs.get(object);
    }
    function shaderFacts(vertex, fragment) {
      const facts = {}, compact = vertex.replace(/\s+/g, '');
      facts.screenSpace = /gl_Position\s*=\s*(?:vec4\s*\(\s*Vertex|Vertex\s*;)/.test(vertex);
      facts.uvQuantized = /vTexCoord0=TexCoord0\.xy\*uQUV0\.zw\+uQUV0\.xy/.test(compact);
      const quantized = /localVertex=localVertex\*uQVS(?:([*/])vec3\(([^)]+)\)(?:\.([xyz]{3}))?)?\+uQVT/.exec(compact);
      if (quantized) {
        const values = quantized[2] ? quantized[2].split(',').map(Number) : [1, 1, 1];
        if (values.length === 3 && values.every(Number.isFinite) && (quantized[1] !== '/' || values.every(value => value !== 0))) {
          const ordered = quantized[3] ? [...quantized[3]].map(axis => values['xyz'.indexOf(axis)]) : values;
          facts.quantizedScale = quantized[1] === '/' ? ordered.map(value => 1 / value) : ordered;
          const addW = compact.indexOf('localVertex+=Vertex.w');
          facts.addW = addW >= 0;
          facts.addWAfter = addW > quantized.index;
        }
      }
      facts.normalLambert = /localNormal\.z=dot\(localNormal\.xy,localNormal\.xy\)/.test(compact) &&
        /2(?:\.0)?\*localNormal\.xy\*sqrt\(1(?:\.0)?-localNormal\.z\)/.test(compact) && /1(?:\.0)?-2(?:\.0)?\*localNormal\.z/.test(compact);
      facts.surface = /SHADER_NAME\s+PBR|\balbedo\s*=/.test(vertex + '\n' + fragment);
      facts.viewerGround = /SHADER_NAME\s+Ground_(?:Opaque|Blend)\b/.test(vertex + '\n' + fragment) &&
        /uGroundOpacity|uGroundFade/.test(fragment) && !facts.surface;
      const albedo = /\balbedo\s*=\s*([^;]+);/.exec(fragment)?.[1];
      const sample = albedo && /texture(?:2D)?\(\s*(\w+)\s*,\s*(vec2\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)|[\w.]+)/i.exec(albedo);
      if (sample) {
        facts.baseSampler = sample[1];
        facts.baseUV = sample[2];
        if (sample[3] !== undefined && [Number(sample[3]), Number(sample[4])].every(Number.isFinite)) facts.constantUV = [Number(sample[3]), Number(sample[4])];
        if (/uAlbedoPBRFactor/.test(albedo)) facts.colorFactor = 'uAlbedoPBRFactor';
      }
      const opacity = /float\s+getMaterialOpacity\s*\([^)]*\)\s*\{([\s\S]{0,4000}?)return\s+alpha\s*;/.exec(fragment)?.[1];
      if (opacity) {
        const texture = /alpha\s*=\s*\(?\s*texture(?:2D)?\(\s*(\w+)\s*,\s*vTexCoord0\s*\)\.(r|a)\s*\)?\s*;/.exec(opacity);
        if (texture) { facts.opacitySampler = texture[1]; facts.opacityChannel = texture[2] === 'r' ? 0 : 3; }
        else if (/texture/.test(opacity)) facts.opacityUnsupported = true;
        facts.opacityFactor = /alpha\s*\*=\s*(\w+)\s*;/.exec(opacity)?.[1];
        facts.opacityInvert = /if\s*\(\s*uOpacityInvert\s*==\s*1\s*\)\s*alpha\s*=\s*1(?:\.0)?\s*-\s*alpha/.test(opacity);
      }
      return facts;
    }
    function inspectProgram(gl, object) {
      const s = state(gl); if (!s) return;
      const p = program(s, object); if (!p) return;
      if (typeof gl.getAttachedShaders === 'function' && typeof gl.getShaderSource === 'function') {
        let vertex = '', fragment = '';
        for (const shader of gl.getAttachedShaders(object) || []) {
          const source = gl.getShaderSource(shader);
          if (typeof source !== 'string' || source.length > 1024 * 1024) continue;
          if (gl.getShaderParameter?.(shader, gl.SHADER_TYPE || 35663) === (gl.VERTEX_SHADER || 35633) || /gl_Position/.test(source)) vertex += source;
          else fragment += source;
        }
        p.facts = shaderFacts(vertex, fragment);
      }
      const count = gl.getProgramParameter(object, gl.ACTIVE_ATTRIBUTES || 35721);
      if (!Number.isInteger(count) || count < 0 || count > 128) return;
      p.attributes.clear();
      for (let i = 0; i < count; i++) {
        const item = gl.getActiveAttrib(object, i); if (!item) continue;
        const location = gl.getAttribLocation(object, item.name), role = semantic(item.name);
        if (role && location >= 0) p.attributes.set(role, { location, type: item.type });
        if (/joint|weight|bone|morph/i.test(item.name)) p.unsupported = true;
      }
      const uniforms = gl.getProgramParameter(object, gl.ACTIVE_UNIFORMS || 35718);
      p.hasModelTransform = false;
      if (Number.isInteger(uniforms) && uniforms >= 0 && uniforms <= 1024) for (let i = 0; i < uniforms; i++) {
        const item = gl.getActiveUniform(object, i); if (!item) continue;
        if (/model|world/i.test(item.name) && /matrix/i.test(item.name)) p.hasModelTransform = true;
        if (item.type === C.SAMPLER_2D) p.samplers.add(item.name);
        if (/bone|joint|morph|skinning/i.test(item.name)) p.unsupported = true;
      }
    }
    function texture(s, object) {
      if (!object) return null;
      if (!s.textures.has(object)) { if (s.textures.size >= 2048) { capacityExceeded = true; return null; } s.textures.set(object, { id: nextId++, object, gl: s.gl, target: C.TEXTURE_2D, width: 0, height: 0, source: null, deleted: false, version: 0 }); }
      return s.textures.get(object);
    }
    function textureUpload(gl, args, sub, compressed) {
      const s = state(gl); if (!s || args[1] !== 0) return;
      const t = texture(s, s.units.get(s.activeUnit)?.get(args[0])); if (!t) return;
      t.version++;
      t.target = args[0]; t.flipY = s.unpackFlip;
      const imageForm = !compressed && args.length === (sub ? 7 : 6);
      const source = imageForm ? args[sub ? 6 : 5] : null;
      const width = imageForm ? source?.videoWidth || source?.naturalWidth || source?.width : args[sub ? 4 : 3];
      const height = imageForm ? source?.videoHeight || source?.naturalHeight || source?.height : args[sub ? 5 : 4];
      if (!sub && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) {
        t.width = width; t.height = height; t.source = source || null;
      } else if (sub) t.source = null;
      if (width * height > limits.maxTexturePixels) t.tooLarge = true;
      if (compressed) t.compressed = true;
    }
    function matrixFor(p) {
      for (const [name, value] of p.uniforms) {
        const n = cleanName(name);
        if (value.length === 16 && /model|world/.test(n) && !/view|projection|mvp|normal|bone|joint|previous/.test(n)) return value.slice();
      }
      return null;
    }
    function colorFor(p) {
      for (const [name, value] of p.uniforms) if ([3, 4].includes(value.length) && /basecolor|albedo|diffuse/i.test(name) && !/texture|map|uv/i.test(name)) return value.length === 3 ? [...value, 1] : value.slice();
      return null;
    }
    function selectedTexture(s, p) {
      let selected = null;
      for (const name of p.samplers) {
        if (/shadow|integrate|brdf|environment/i.test(name)) continue;
        if (/normal|metal|rough|occlusion|emissive|specular|gloss|height|bump/i.test(name)) { warn('法线、粗糙度、金属度等附加材质通道尚未导出。'); continue; }
        if (name !== p.facts?.baseSampler && !/base.?color|albedo|diffuse/i.test(name)) continue;
        const unit = p.uniforms.get(name)?.[0] ?? 0;
        const candidate = texture(s, s.units.get(unit)?.get(C.TEXTURE_2D));
        if (candidate && selected && candidate !== selected) warn('底色材质包含多个纹理，当前只保存一个通道。');
        if (candidate && !selected) selected = candidate;
      }
      if (!selected && [...p.samplers].some(name => !/shadow|integrate|brdf|environment/i.test(name))) warn('无法确定底色纹理，未将其他材质贴图误当作底色。');
      return selected;
    }
    function samplerTexture(s, p, name) {
      if (!name) return null;
      return texture(s, s.units.get(p.uniforms.get(name)?.[0] ?? 0)?.get(C.TEXTURE_2D));
    }
    function expectsBaseTexture(p) {
      return [...p.samplers].some(name => name === p.facts?.baseSampler || /base.?color|albedo|diffuse/i.test(name));
    }
    function beginFrame(s) {
      if (animationFrame === null && !outsideBurst) {
        outsideBurst = true; outsideFrame++;
        Promise.resolve().then(() => { outsideBurst = false; });
      }
      const key = animationFrame === null ? 'sync:' + outsideFrame : 'raf:' + animationFrame;
      if (s.frameKey !== key) { s.frameKey = key; s.draws = new Map(); s.drawError = null; }
    }
    if (typeof scope.requestAnimationFrame === 'function') {
      const original = scope.requestAnimationFrame;
      function wrapped(callback) {
        if (typeof callback !== 'function') return original.apply(this, arguments);
        return original.call(this, function (timestamp) {
          const previous = animationFrame; animationFrame = timestamp;
          try { return callback.call(this, timestamp); } finally { animationFrame = previous; }
        });
      }
      scope.requestAnimationFrame = wrapped;
      restorers.push(() => { if (scope.requestAnimationFrame === wrapped) scope.requestAnimationFrame = original; });
    }
    function draw(gl, mode, count, type, offset, first, instances = 1) {
      const s = state(gl); if (!s || !Number.isSafeInteger(count) || count < 3) return;
      const p = program(s, s.program); if (!p?.attributes.has('position')) return;
      if (![C.TRIANGLES, C.STRIP, C.FAN].includes(mode)) { warn('非三角形图元未导出。'); return; }
      const attributes = {};
      for (const [role, item] of p.attributes) {
        const value = vao(s).attributes.get(item.location); if (value?.enabled) attributes[role] = { ...value, shaderType: item.type, version: buffer(s, value.buffer)?.version };
      }
      if (!attributes.position) return;
      if (attributes.position.size < 3 || attributes.position.shaderType === 35664 || p.facts?.screenSpace && !p.hasModelTransform || p.facts?.viewerGround) return;
      beginFrame(s);
      if (count > limits.maxIndices) { s.drawError = 'SKETCHFAB_VIEWER_TOO_LARGE'; tooLargeAt = now(); if (pending) pending.tooLarge = true; return; }
      if (instances !== 1 || p.unsupported || [...vao(s).attributes.values()].some(a => a.divisor > 0)) {
        s.drawError = 'SKETCHFAB_VIEWER_UNSUPPORTED'; unsupportedAt = now(); warn('骨骼、变形或实例化网格尚未支持，不能作为完整静态模型导出。'); if (pending) pending.unsupported = true; return;
      }
      const pos = buffer(s, attributes.position.buffer); if (!pos) return;
      const element = type ? buffer(s, vao(s).element) : null;
      const matrix = matrixFor(p), textureInfo = selectedTexture(s, p);
      const opacityTexture = samplerTexture(s, p, p.facts?.opacitySampler);
      const descriptor = { s, attributes, element, elementVersion: element?.version, mode, count, type, offset, first, matrix, color: colorFor(p), texture: textureInfo, textureVersion: textureInfo?.version, requiresTexture: expectsBaseTexture(p),
        opacityTexture, opacityVersion: opacityTexture?.version, opacityFactor: p.facts?.opacityFactor ? p.uniforms.get(p.facts.opacityFactor)?.[0] : 1,
        opacityInvert: p.facts?.opacityInvert && p.uniforms.get('uOpacityInvert')?.[0] === 1,
        quv0: p.uniforms.get('uQUV0'),
        qvs: [...p.uniforms].find(([name]) => cleanName(name) === 'uqvs')?.[1], qvt: [...p.uniforms].find(([name]) => cleanName(name) === 'uqvt')?.[1],
        facts: p.facts || {}, scalarFactor: p.facts?.colorFactor ? p.uniforms.get(p.facts.colorFactor)?.[0] : undefined,
        doubleSided: !s.cullEnabled, at: now() };
      descriptor.score = (matrix ? 4 : 0) + (attributes.normal ? 2 : 0) + (textureInfo ? 4 : 0) + (descriptor.facts.surface ? 4 : 0);
      const geometry = [pos.id, attributes.position.offset, attributes.position.stride, attributes.position.type, attributes.position.size, attributes.position.normalized,
        type ? element?.id : 'a', mode, count, offset, first].join('|');
      const key = geometry + '|' + (matrix?.join(',') || 'local');
      const remember = map => {
        if (matrix) map.delete(geometry + '|local');
        else if ([...map.keys()].some(existing => existing.startsWith(geometry + '|') && existing !== key)) return;
        if (!map.has(key) || descriptor.score >= map.get(key).score) map.set(key, descriptor);
      };
      remember(s.draws);
      if (s.draws.size > limits.maxMeshes) { s.draws.delete(key); s.drawError = 'SKETCHFAB_VIEWER_TOO_LARGE'; if (pending) pending.tooLarge = true; }
    }
    function setupPrototype(proto) {
      hook(proto, 'bindBuffer', (gl, a) => { const s = state(gl); if (!s) return; s.bindings.set(a[0], a[1]); if (a[0] === C.ELEMENT) vao(s).element = a[1]; });
      hook(proto, 'bufferData', (gl, a) => uploadBuffer(gl, a, false));
      hook(proto, 'bufferSubData', (gl, a) => uploadBuffer(gl, a, true));
      hook(proto, 'deleteBuffer', (gl, a) => { const s = state(gl), b = s?.buffers.get(a[0]); if (b) { shadowBytes -= b.bytes?.length || 0; b.bytes = null; b.incomplete = true; s.buffers.delete(a[0]); } });
      const bindVao = (gl, object) => {
        const s = state(gl); if (!s) return; s.vao = object;
        if (!s.vaos.has(object)) { if (s.vaos.size >= 4096) { capacityExceeded = true; return; } s.vaos.set(object, { attributes: new Map(), element: null }); }
      };
      hook(proto, 'bindVertexArray', (gl, a) => bindVao(gl, a[0]));
      hook(proto, 'deleteVertexArray', (gl, a) => { const s = state(gl); if (s && a[0]) s.vaos.delete(a[0]); });
      for (const name of ['vertexAttribPointer', 'vertexAttribIPointer']) hook(proto, name, (gl, a) => {
        const s = state(gl); if (!s) return; const old = vao(s).attributes.get(a[0]) || {};
        vao(s).attributes.set(a[0], { ...old, buffer: s.bindings.get(C.ARRAY), size: a[1], type: a[2], normalized: name === 'vertexAttribPointer' && a[3],
          stride: a[name === 'vertexAttribPointer' ? 4 : 3], offset: a[name === 'vertexAttribPointer' ? 5 : 4] });
      });
      for (const [name, enabled] of [['enableVertexAttribArray', true], ['disableVertexAttribArray', false]]) hook(proto, name, (gl, a) => {
        const s = state(gl); if (s) vao(s).attributes.set(a[0], { ...(vao(s).attributes.get(a[0]) || {}), enabled });
      });
      hook(proto, 'vertexAttribDivisor', (gl, a) => { const s = state(gl); if (s) vao(s).attributes.set(a[0], { ...(vao(s).attributes.get(a[0]) || {}), divisor: a[1] }); });
      hook(proto, 'linkProgram', (gl, a) => inspectProgram(gl, a[0]));
      hook(proto, 'useProgram', (gl, a) => { const s = state(gl); if (s) { s.program = a[0]; const p = program(s, a[0]); if (p && !p.attributes.size) inspectProgram(gl, a[0]); } });
      hook(proto, 'getUniformLocation', (gl, a, location) => {
        const s = state(gl), p = s && program(s, a[0]); if (!p || !location) return;
        if (p.locations.size >= 2048 || typeof a[1] !== 'string' || a[1].length > 256) { capacityExceeded = true; return; }
        p.locations.set(location, a[1]);
      });
      for (const name of ['uniformMatrix4fv', 'uniform4fv', 'uniform3fv', 'uniform2fv', 'uniform1fv', 'uniform1iv', 'uniform4f', 'uniform3f', 'uniform2f', 'uniform1i', 'uniform1f']) hook(proto, name, (gl, a) => {
        const s = state(gl), p = s && program(s, s.program), key = p?.locations.get(a[0]); if (!key) return;
        let value;
        if (name === 'uniformMatrix4fv') value = Array.prototype.slice.call(a[2] || [], a[3] || 0, (a[3] || 0) + 16);
        else if (/[fi]v$/.test(name)) value = Array.prototype.slice.call(a[1] || [], a[2] || 0, (a[2] || 0) + Number(name[7]));
        else value = a.slice(1);
        if (value.every(Number.isFinite)) p.uniforms.set(key, value);
      });
      hook(proto, 'activeTexture', (gl, a) => { const s = state(gl); if (s) s.activeUnit = a[0] - C.TEXTURE0; });
      hook(proto, 'bindTexture', (gl, a) => { const s = state(gl); if (!s) return; if (!s.units.has(s.activeUnit)) s.units.set(s.activeUnit, new Map()); s.units.get(s.activeUnit).set(a[0], a[1]); texture(s, a[1]); });
      hook(proto, 'pixelStorei', (gl, a) => { const s = state(gl); if (s && a[0] === 37440) s.unpackFlip = Boolean(a[1]); });
      hook(proto, 'enable', (gl, a) => { const s = state(gl); if (s && a[0] === 2884) s.cullEnabled = true; });
      hook(proto, 'disable', (gl, a) => { const s = state(gl); if (s && a[0] === 2884) s.cullEnabled = false; });
      hook(proto, 'texImage2D', (gl, a) => textureUpload(gl, a, false, false));
      hook(proto, 'texSubImage2D', (gl, a) => textureUpload(gl, a, true, false));
      hook(proto, 'compressedTexImage2D', (gl, a) => textureUpload(gl, a, false, true));
      hook(proto, 'compressedTexSubImage2D', (gl, a) => textureUpload(gl, a, true, true));
      hook(proto, 'texStorage2D', (gl, a) => { const s = state(gl), t = s && texture(s, s.units.get(s.activeUnit)?.get(a[0])); if (t) { t.width = a[3]; t.height = a[4]; t.version++; } });
      hook(proto, 'deleteTexture', (gl, a) => { const s = state(gl), t = s?.textures.get(a[0]); if (t) { t.deleted = true; t.source = null; s.textures.delete(a[0]); } });
      hook(proto, 'drawArrays', (gl, a) => draw(gl, a[0], a[2], null, 0, a[1]));
      hook(proto, 'drawElements', (gl, a) => draw(gl, a[0], a[1], a[2], a[3], 0));
      hook(proto, 'drawRangeElements', (gl, a) => draw(gl, a[0], a[3], a[4], a[5], 0));
      hook(proto, 'drawArraysInstanced', (gl, a) => draw(gl, a[0], a[2], null, 0, a[1], a[3]));
      hook(proto, 'drawElementsInstanced', (gl, a) => draw(gl, a[0], a[1], a[2], a[3], 0, a[4]));
      hook(proto, 'getExtension', (gl, a, ext) => {
        if (a[0] === 'OES_vertex_array_object' && ext) {
          hook(ext, 'bindVertexArrayOES', (_e, values) => bindVao(gl, values[0]));
          hook(ext, 'deleteVertexArrayOES', (_e, values) => { const s = state(gl); if (s && values[0]) s.vaos.delete(values[0]); });
        }
        if (a[0] === 'ANGLE_instanced_arrays' && ext) {
          hook(ext, 'vertexAttribDivisorANGLE', (_e, v) => { const s = state(gl); if (s) vao(s).attributes.set(v[0], { ...(vao(s).attributes.get(v[0]) || {}), divisor: v[1] }); });
          hook(ext, 'drawArraysInstancedANGLE', (_e, v) => draw(gl, v[0], v[2], null, 0, v[1], v[3]));
          hook(ext, 'drawElementsInstancedANGLE', (_e, v) => draw(gl, v[0], v[1], v[2], v[3], 0, v[4]));
        }
      });
    }
    const prototypes = [scope.WebGLRenderingContext?.prototype, scope.WebGL2RenderingContext?.prototype].filter(Boolean);
    for (const proto of prototypes) setupPrototype(proto);

    function decodeAttribute(descriptor, info, vertices, dimensions) {
      const data = buffer(descriptor.s, info?.buffer);
      if (!info || !data?.bytes || data.incomplete || data.version !== info.version || !elementSize(info.type) || info.size < dimensions) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
      const component = elementSize(info.type), stride = info.stride || info.size * component;
      if (!Number.isInteger(stride) || stride < info.size * component || !Number.isInteger(info.offset) || info.offset < 0) throw failure('SKETCHFAB_VIEWER_INVALID');
      const view = new DataView(data.bytes.buffer, data.bytes.byteOffset, data.bytes.byteLength), out = [];
      for (const index of vertices) {
        const at = info.offset + index * stride;
        if (!Number.isSafeInteger(at) || at < 0 || at + dimensions * component > data.bytes.length) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
        for (let c = 0; c < dimensions; c++) {
          const value = readComponent(view, at + c * component, info.type, info.normalized);
          if (!Number.isFinite(value)) throw failure('SKETCHFAB_VIEWER_INVALID'); out.push(value);
        }
      }
      return out;
    }
    function meshFor(d) {
      const raw = [];
      if (d.type) {
        const size = elementSize(d.type);
        if (![C.UBYTE, C.USHORT, C.UINT].includes(d.type) || !d.element?.bytes || d.element.version !== d.elementVersion || !size || !Number.isInteger(d.offset) || d.offset < 0 ||
            d.offset % size || d.offset + d.count * size > d.element.bytes.length) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
        const view = new DataView(d.element.bytes.buffer, d.element.bytes.byteOffset, d.element.bytes.byteLength);
        for (let i = 0; i < d.count; i++) raw.push(readComponent(view, d.offset + i * size, d.type, false));
      } else {
        if (!Number.isInteger(d.first) || d.first < 0) throw failure('SKETCHFAB_VIEWER_INVALID');
        for (let i = 0; i < d.count; i++) raw.push(d.first + i);
      }
      const triangles = [], restart = !d.s.isWebGL2 || !d.type ? -1 : d.type === C.UBYTE ? 255 : d.type === C.USHORT ? 65535 : 4294967295;
      const add = (a, b, c) => {
        if (a !== b && b !== c && a !== c && a !== restart && b !== restart && c !== restart) {
          if (triangles.length + 3 > limits.maxIndices) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
          triangles.push(a, b, c);
        }
      };
      if (d.mode === C.TRIANGLES) for (let i = 0; i + 2 < raw.length; i += 3) add(raw[i], raw[i + 1], raw[i + 2]);
      else {
        let segment = [];
        for (const index of raw) {
          if (index === restart && d.type) { segment = []; continue; }
          segment.push(index); const i = segment.length - 1;
          if (i >= 2) d.mode === C.FAN ? add(segment[0], segment[i - 1], segment[i]) : i % 2 ? add(segment[i - 1], segment[i - 2], segment[i]) : add(segment[i - 2], segment[i - 1], segment[i]);
        }
      }
      if (!triangles.length) return null;
      const vertices = [], remap = new Map(), indices = triangles.map(index => {
        if (!remap.has(index)) { remap.set(index, vertices.length); vertices.push(index); }
        return remap.get(index);
      });
      if (vertices.length > limits.maxVertices) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
      const positionDimensions = d.facts.addW ? 4 : 3;
      const rawPositions = decodeAttribute(d, d.attributes.position, vertices, positionDimensions), positions = [];
      for (let i = 0; i < vertices.length; i++) for (let component = 0; component < 3; component++) positions.push(rawPositions[i * positionDimensions + component] + (d.facts.addW && !d.facts.addWAfter ? rawPositions[i * 4 + 3] : 0));
      if (d.facts.quantizedScale) {
        if (d.qvs?.length !== 3 || d.qvt?.length !== 3) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
        for (let i = 0; i < positions.length; i++) positions[i] = positions[i] * d.qvs[i % 3] * d.facts.quantizedScale[i % 3] + d.qvt[i % 3];
      } else if (![C.FLOAT, C.HALF, 36193].includes(d.attributes.position.type)) throw failure('SKETCHFAB_VIEWER_UNSUPPORTED');
      if (d.facts.addWAfter) for (let i = 0; i < positions.length; i++) positions[i] += rawPositions[Math.floor(i / 3) * 4 + 3];
      if (!positions.every(Number.isFinite)) throw failure('SKETCHFAB_VIEWER_INVALID');
      const mesh = { positions, indices };
      if (d.requiresTexture && !d.texture) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
      if (d.attributes.normal) {
        if (d.attributes.normal.size === 2) {
          if (!d.facts.normalLambert) throw failure('SKETCHFAB_VIEWER_UNSUPPORTED');
          const xy = decodeAttribute(d, d.attributes.normal, vertices, 2); mesh.normals = [];
          for (let i = 0; i < xy.length; i += 2) {
            const x = xy[i], y = xy[i + 1], z = x * x + y * y;
            if (z > 1.001) throw failure('SKETCHFAB_VIEWER_INVALID');
            const scale = 2 * Math.sqrt(Math.max(0, 1 - z)); mesh.normals.push(x * scale, y * scale, 1 - 2 * z);
          }
        } else mesh.normals = decodeAttribute(d, d.attributes.normal, vertices, 3);
      } else warn('部分网格缺少法线，需在导出时重算法线。');
      if (d.attributes.uv) mesh.texcoords = decodeAttribute(d, d.attributes.uv, vertices, 2);
      else if (d.texture && !d.facts.constantUV) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
      if (d.facts.uvQuantized && mesh.texcoords) {
        if (d.quv0?.length !== 4) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
        for (let i = 0; i < mesh.texcoords.length; i++) mesh.texcoords[i] = mesh.texcoords[i] * d.quv0[2 + i % 2] + d.quv0[i % 2];
      }
      if (d.facts.opacityUnsupported) throw failure('SKETCHFAB_VIEWER_UNSUPPORTED');
      if (d.facts.opacitySampler && (!d.opacityTexture || !mesh.texcoords)) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
      if (d.matrix) mesh.matrix = d.matrix;
      else warn('部分网格未记录世界变换，保存的是局部坐标。');
      const color = d.color || (Number.isFinite(d.scalarFactor) ? [d.scalarFactor, d.scalarFactor, d.scalarFactor, 1] : null);
      mesh.material = { ...(color ? { baseColorFactor: color } : {}), doubleSided: d.doubleSided };
      if (d.facts.opacityFactor && !d.facts.opacitySampler) {
        if (!Number.isFinite(d.opacityFactor)) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
        mesh.material.baseColorFactor = color ? color.slice() : [1, 1, 1, 1];
        mesh.material.baseColorFactor[3] *= d.opacityFactor;
      }
      if (!color && !d.texture) warn('未识别底色参数，当前网格使用默认材质。');
      return mesh;
    }
    async function pixelsFromTexture(t) {
      if (!t || t.deleted || !t.width || !t.height || t.width * t.height > limits.maxTexturePixels || t.target !== C.TEXTURE_2D) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
      const gl = t.gl, framebuffer = gl.createFramebuffer(), pixels = new Uint8Array(t.width * t.height * 4);
      const get = key => key === undefined ? undefined : gl.getParameter(key);
      const framebufferBinding = get(gl.FRAMEBUFFER_BINDING || 36006), pack = get(gl.PACK_ALIGNMENT || 3333);
      const readBinding = get(gl.READ_FRAMEBUFFER_BINDING), drawBinding = get(gl.DRAW_FRAMEBUFFER_BINDING), pixelBuffer = get(gl.PIXEL_PACK_BUFFER_BINDING);
      const packFields = [gl.PACK_ROW_LENGTH, gl.PACK_SKIP_PIXELS, gl.PACK_SKIP_ROWS].filter(x => x !== undefined).map(key => [key, get(key)]);
      let okay = false;
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER || 36160, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER || 36160, gl.COLOR_ATTACHMENT0 || 36064, C.TEXTURE_2D, t.object, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER || 36160) === (gl.FRAMEBUFFER_COMPLETE || 36053)) {
          if (gl.IMPLEMENTATION_COLOR_READ_TYPE !== undefined && get(gl.IMPLEMENTATION_COLOR_READ_TYPE) !== C.UBYTE) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
          if (gl.PIXEL_PACK_BUFFER !== undefined) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          gl.pixelStorei(gl.PACK_ALIGNMENT || 3333, 1); for (const [key] of packFields) gl.pixelStorei(key, 0);
          gl.readPixels(0, 0, t.width, t.height, C.RGBA, C.UBYTE, pixels); okay = true;
        }
      } catch {} finally {
        if (gl.READ_FRAMEBUFFER !== undefined && readBinding !== undefined) { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readBinding); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawBinding); }
        else gl.bindFramebuffer(gl.FRAMEBUFFER || 36160, framebufferBinding);
        if (gl.PIXEL_PACK_BUFFER !== undefined) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pixelBuffer);
        if (pack !== undefined) gl.pixelStorei(gl.PACK_ALIGNMENT || 3333, pack);
        for (const [key, value] of packFields) gl.pixelStorei(key, value);
        gl.deleteFramebuffer(framebuffer);
      }
      if (okay) return pixels;
      const canvas = scope.OffscreenCanvas ? new scope.OffscreenCanvas(t.width, t.height) : scope.document?.createElement('canvas');
      if (!canvas) throw failure('SKETCHFAB_VIEWER_INCOMPLETE'); canvas.width = t.width; canvas.height = t.height;
      const ctx = canvas.getContext('2d'); if (!ctx) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
      if (t.source) { if (t.flipY) { ctx.translate(0, t.height); ctx.scale(1, -1); } ctx.drawImage(t.source, 0, 0); }
      else throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
      return ctx.getImageData(0, 0, t.width, t.height).data;
    }
    async function pngFromPixels(width, height, pixels, name) {
      const canvas = scope.OffscreenCanvas ? new scope.OffscreenCanvas(width, height) : scope.document?.createElement('canvas');
      if (!canvas) throw failure('SKETCHFAB_VIEWER_INCOMPLETE'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); if (!ctx) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
      const image = ctx.createImageData(width, height); image.data.set(pixels); ctx.putImageData(image, 0, 0);
      if (typeof canvas.convertToBlob === 'function') {
        const blob = await canvas.convertToBlob({ type: 'image/png' }); if (blob.size > limits.maxImageBytes) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
        const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return { name, mimeType: 'image/png', data: scope.btoa(binary) };
      }
      const data = canvas.toDataURL('image/png');
      if (!data.startsWith('data:image/png;base64,')) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
      return { name, mimeType: 'image/png', data: data.slice(22) };
    }
    async function pngFromTexture(t) {
      return pngFromPixels(t.width, t.height, await pixelsFromTexture(t), 'base-color-' + t.id + '.png');
    }
    async function pngWithOpacity(d) {
      const opacity = d.opacityTexture;
      if (opacity.version !== d.opacityVersion || !Number.isFinite(d.opacityFactor)) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
      const alpha = await pixelsFromTexture(opacity), base = d.facts.constantUV ? null : d.texture;
      if (base && d.facts.baseUV !== 'vTexCoord0') throw failure('SKETCHFAB_VIEWER_UNSUPPORTED');
      const width = base?.width || opacity.width, height = base?.height || opacity.height;
      const pixels = base ? new Uint8Array(await pixelsFromTexture(base)) : new Uint8Array(width * height * 4).fill(255);
      const readAlpha = (x, y) => alpha[(Math.max(0, Math.min(opacity.height - 1, y)) * opacity.width + Math.max(0, Math.min(opacity.width - 1, x))) * 4 + d.facts.opacityChannel] / 255;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width * opacity.width - 0.5, v = (y + 0.5) / height * opacity.height - 0.5;
        const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
        let value = (readAlpha(x0, y0) * (1 - fx) + readAlpha(x0 + 1, y0) * fx) * (1 - fy) +
          (readAlpha(x0, y0 + 1) * (1 - fx) + readAlpha(x0 + 1, y0 + 1) * fx) * fy;
        if (d.opacityInvert) value = 1 - value;
        const i = (y * width + x) * 4 + 3;
        pixels[i] = Math.round(pixels[i] * Math.max(0, Math.min(1, value * d.opacityFactor)));
      }
      return pngFromPixels(width, height, pixels, 'base-opacity-' + opacity.id + '.png');
    }
    async function snapshot(modelId, { waitMs = limits.waitMs } = {}) {
      if (disposed || !syncModel() || modelId !== currentId) throw failure('SKETCHFAB_VIEWER_INVALID');
      if (pending) throw failure('SKETCHFAB_VIEWER_UNAVAILABLE');
      const job = { modelId, draws: new Map(), changed: false, unsupported: false, tooLarge: false }; pending = job;
      try {
        if (waitMs > 0) await new Promise(resolve => timeout(resolve, Math.min(1000, waitMs)));
        if (syncModel() !== modelId || job.changed) throw failure('SKETCHFAB_VIEWER_INVALID');
        if (job.unsupported || now() - unsupportedAt <= 1000) throw failure('SKETCHFAB_VIEWER_UNSUPPORTED');
        if (capacityExceeded || job.tooLarge || now() - tooLargeAt <= 1000) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
        for (const s of contexts) {
          if (s.drawError) throw failure(s.drawError);
          for (const [key, value] of s.draws) job.draws.set(key, value);
        }
        if (!job.draws.size) throw failure('SKETCHFAB_VIEWER_UNAVAILABLE');
        if (job.draws.size > limits.maxMeshes) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
        const result = { version: 1, modelId, coordinateSystem: 'sketchfab-z-up', meshes: [], images: [] }, images = new Map(); let totalVertices = 0, totalIndices = 0, imageBytes = 0;
        for (const d of job.draws.values()) {
          if (syncModel() !== modelId || job.changed) throw failure('SKETCHFAB_VIEWER_INVALID');
          const mesh = meshFor(d); if (!mesh) continue;
          totalVertices += mesh.positions.length / 3; if (totalVertices > limits.maxVertices) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
          totalIndices += mesh.indices.length; if (totalIndices > limits.maxIndices) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
          if (d.texture) {
            if (d.texture.version !== d.textureVersion) throw failure('SKETCHFAB_VIEWER_INCOMPLETE');
            if (d.facts.constantUV) {
              const pixels = await pixelsFromTexture(d.texture), uv = d.facts.constantUV;
              const x = Math.min(d.texture.width - 1, Math.max(0, Math.floor(uv[0] * d.texture.width))), y = Math.min(d.texture.height - 1, Math.max(0, Math.floor(uv[1] * d.texture.height)));
              const start = (y * d.texture.width + x) * 4, factor = d.scalarFactor ?? 1;
              mesh.material.baseColorFactor = [pixels[start] / 255 * factor, pixels[start + 1] / 255 * factor, pixels[start + 2] / 255 * factor, pixels[start + 3] / 255];
            } else if (!d.opacityTexture) {
            if (!images.has(d.texture.id)) {
              if (result.images.length >= limits.maxImages) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
              const image = await pngFromTexture(d.texture); imageBytes += Math.floor(image.data.length * 3 / 4);
              if (imageBytes > limits.maxImageBytes) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
              images.set(d.texture.id, result.images.length); result.images.push(image);
            }
            mesh.material.baseColorTexture = images.get(d.texture.id);
            }
          }
          if (d.opacityTexture) {
            const key = ['opacity', d.texture?.id, d.opacityTexture.id, d.opacityFactor, d.opacityInvert].join(':');
            if (!images.has(key)) {
              if (result.images.length >= limits.maxImages) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
              const image = await pngWithOpacity(d); imageBytes += Math.floor(image.data.length * 3 / 4);
              if (imageBytes > limits.maxImageBytes) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
              images.set(key, result.images.length); result.images.push(image);
            }
            mesh.material.baseColorTexture = images.get(key);
          }
          mesh.name = 'mesh-' + (result.meshes.length + 1); result.meshes.push(mesh);
        }
        if (syncModel() !== modelId || job.changed) throw failure('SKETCHFAB_VIEWER_INVALID');
        if (!result.meshes.length) throw failure('SKETCHFAB_VIEWER_UNAVAILABLE');
        if (warnings.size) result.warnings = [...warnings];
        const text = JSON.stringify(result), bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length * 2;
        if (bytes > limits.maxJsonBytes) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
        return result;
      } finally { if (pending === job) pending = null; }
    }
    async function onMessage(event) {
      const message = event.data;
      if (event.source !== scope || event.origin !== scope.location?.origin || !message || message.type !== 'mosaic:sketchfab-viewer-request' ||
          typeof message.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(message.requestId) || typeof message.modelId !== 'string' || !/^[a-f0-9]{32}$/.test(message.modelId)) return;
      const reply = { type: 'mosaic:sketchfab-viewer-response', requestId: message.requestId, modelId: message.modelId };
      try {
        if (message.modelId !== syncModel()) throw failure('SKETCHFAB_VIEWER_INVALID');
        if (seenRequests.has(message.requestId) || now() - lastRequest < limits.minRequestInterval) throw failure('SKETCHFAB_VIEWER_UNAVAILABLE');
        seenRequests.add(message.requestId); if (seenRequests.size > 64) seenRequests.delete(seenRequests.values().next().value); lastRequest = now();
        const data = await snapshot(message.modelId); scope.postMessage({ ...reply, ok: true, snapshot: data }, scope.location.origin);
      } catch (error) {
        const code = /^SKETCHFAB_VIEWER_(?:UNAVAILABLE|UNSUPPORTED|TOO_LARGE|INVALID|INCOMPLETE)$/.test(error?.code) ? error.code : 'SKETCHFAB_VIEWER_INCOMPLETE';
        scope.postMessage({ ...reply, ok: false, code }, scope.location.origin);
      }
    }
    scope.addEventListener?.('message', onMessage);
    return Object.freeze({ snapshot, dispose() { disposed = true; if (pending) pending.changed = true; scope.removeEventListener?.('message', onMessage); for (const restore of restorers.reverse()) restore(); contexts.clear(); shadowBytes = 0; },
      limits: Object.freeze({ ...limits }) });
  }
  return { installSketchfabViewerRecorder, modelIdFromUrl, DEFAULT_LIMITS: DEFAULTS };
});
