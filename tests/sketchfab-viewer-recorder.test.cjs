'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installSketchfabViewerRecorder, modelIdFromUrl } = require('../extension/sketchfab-viewer-recorder.js');
const ID = '0123456789abcdef0123456789abcdef', OTHER = 'a'.repeat(32);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

function fixture(t, options = {}) {
  class GL {
    constructor() {
      Object.assign(this, { ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963, FLOAT: 5126, UNSIGNED_BYTE: 5121, UNSIGNED_SHORT: 5123,
        SHORT: 5122, TRIANGLES: 4, TRIANGLE_STRIP: 5, TEXTURE_2D: 3553, TEXTURE0: 33984, RGBA: 6408, RGB: 6407,
        FRAMEBUFFER: 36160, FRAMEBUFFER_BINDING: 36006, FRAMEBUFFER_COMPLETE: 36053, COLOR_ATTACHMENT0: 36064,
        PACK_ALIGNMENT: 3333, UNPACK_FLIP_Y_WEBGL: 37440, PIXEL_PACK_BUFFER: 35051, PIXEL_PACK_BUFFER_BINDING: 35053,
        READ_FRAMEBUFFER: 36008, DRAW_FRAMEBUFFER: 36009, READ_FRAMEBUFFER_BINDING: 36010, DRAW_FRAMEBUFFER_BINDING: 36006,
        PACK_ROW_LENGTH: 3330, PACK_SKIP_PIXELS: 3332, PACK_SKIP_ROWS: 3331, ACTIVE_ATTRIBUTES: 35721, ACTIVE_UNIFORMS: 35718,
        VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, SHADER_TYPE: 35663, CULL_FACE: 2884 });
      this.parameters = new Map([[36006, { old: 'draw' }], [36010, { old: 'read' }], [35053, { old: 'packBuffer' }], [3333, 4], [3330, 8], [3332, 2], [3331, 1]]);
      this.nativeCalls = [];
      this.pixels = [255, 0, 0, 127]; this.framebufferComplete = true;
    }
    bindBuffer(...a) { this.nativeCalls.push(['bindBuffer', ...a]); if (a[0] === 35051) this.parameters.set(35053, a[1]); }
    bufferData(...a) { this.nativeCalls.push(['bufferData', ...a]); }
    bufferSubData(...a) { this.nativeCalls.push(['bufferSubData', ...a]); }
    deleteBuffer() {}
    bindVertexArray() {}
    deleteVertexArray() {}
    vertexAttribPointer() {}
    vertexAttribIPointer() {}
    enableVertexAttribArray() {}
    disableVertexAttribArray() {}
    vertexAttribDivisor() {}
    linkProgram() {}
    useProgram() {}
    getProgramParameter(p, kind) { return kind === 35721 ? p.attrs.length : kind === 35718 ? (p.uniforms || []).length : true; }
    getActiveAttrib(p, i) { return p.attrs[i]; }
    getAttribLocation(p, name) { return p.attrs.findIndex(a => a.name === name); }
    getActiveUniform(p, i) { return p.uniforms[i]; }
    getAttachedShaders(p) { return p.shaders || []; }
    getShaderSource(shader) { return shader.source; }
    getShaderParameter(shader) { return shader.type; }
    getUniformLocation(p, name) { return { p, name }; }
    uniformMatrix4fv() {}
    uniform4fv() {}
    uniform3fv() {}
    uniform2fv() {}
    uniform1fv() {}
    uniform1iv() {}
    uniform4f() {}
    uniform3f() {}
    uniform2f() {}
    uniform1i() {}
    uniform1f() {}
    activeTexture() {}
    bindTexture() {}
    pixelStorei(key, value) { this.parameters.set(key, value); }
    texImage2D() {}
    texSubImage2D() {}
    compressedTexImage2D() {}
    compressedTexSubImage2D() {}
    texStorage2D() {}
    deleteTexture(...args) { this.nativeCalls.push(['deleteTexture', ...args]); }
    enable() {}
    disable() {}
    drawArrays(...args) { this.nativeCalls.push(['drawArrays', ...args]); }
    drawElements(...args) { this.nativeCalls.push(['drawElements', ...args]); }
    drawRangeElements(...args) { this.nativeCalls.push(['drawRangeElements', ...args]); }
    drawElementsInstanced(...args) { this.nativeCalls.push(['drawElementsInstanced', ...args]); }
    drawArraysInstanced() {}
    getExtension() { return null; }
    getParameter(key) { return this.parameters.get(key); }
    createFramebuffer() { return { temporary: true }; }
    bindFramebuffer(target, value) {
      if (target === 36160 || target === 36009) this.parameters.set(36006, value);
      if (target === 36160 || target === 36008) this.parameters.set(36010, value);
    }
    framebufferTexture2D() {}
    checkFramebufferStatus() { return this.framebufferComplete ? 36053 : 0; }
    readPixels(_x, _y, _w, _h, _format, _type, data) { for (let i = 0; i < data.length; i++) data[i] = this.pixels[i % this.pixels.length]; }
    deleteFramebuffer() {}
  }
  const listeners = new Map(), responses = [], images = [], raf = [];
  let time = 100;
  const scope = {
    WebGLRenderingContext: GL, WebGL2RenderingContext: GL,
    location: { href: `https://sketchfab.com/models/${ID}/embed`, origin: 'https://sketchfab.com' },
    setTimeout, requestAnimationFrame: callback => { raf.push(callback); return raf.length; }, btoa: s => Buffer.from(s, 'binary').toString('base64'),
    fetch() { throw new Error('Recorder must not make network requests'); },
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type),
    postMessage: (body, origin) => responses.push({ body, origin }),
    document: { createElement(tag) {
      assert.equal(tag, 'canvas');
      const image = { pixels: null }; images.push(image);
      return { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: data => { image.pixels = [...data.data]; }, translate() {}, scale() {}, drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, 127]) }) }), toDataURL: () => 'data:image/png;base64,' + PNG };
    } }
  };
  Object.defineProperty(scope.document, 'cookie', { get() { throw new Error('Must not read cookies'); } });
  const recorder = installSketchfabViewerRecorder(scope, { waitMs: 0, now: () => time, ...options });
  t.after(() => recorder.dispose());
  const gl = new GL();
  function program(attrs = ['Vertex', 'Normal', 'TexCoord0'], uniforms = [], shaders = []) {
    const p = { attrs: attrs.map(name => ({ name })), uniforms: uniforms.map(name => ({ name, type: 35678 })), shaders };
    gl.linkProgram(p); gl.useProgram(p); return p;
  }
  function attribute(location, data, size, type = gl.FLOAT, normalized = false, stride = 0, offset = 0) {
    const buffer = {}; gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, 35044);
    gl.vertexAttribPointer(location, size, type, normalized, stride, offset); gl.enableVertexAttribArray(location); return buffer;
  }
  function triangle({ textured = false } = {}) {
    const p = program(undefined, textured ? ['uBaseColorTexture'] : []);
    const vertex = attribute(0, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3);
    attribute(1, new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3);
    attribute(2, new Float32Array([0, 0, 1, 0, 0, 1]), 2);
    const matrix = IDENTITY.slice(); matrix[12] = 3;
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uModelMatrix'), false, new Float32Array(matrix));
    const indices = {}; gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2]), 35044);
    let texture;
    if (textured) {
      texture = {}; gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(gl.pixels));
      gl.uniform1i(gl.getUniformLocation(p, 'uBaseColorTexture'), 0);
    }
    gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0); return { p, vertex, indices, texture };
  }
  return { scope, recorder, gl, program, attribute, triangle, listeners, responses, images, setTime: value => { time = value; }, runFrame: timestamp => { for (const callback of raf.splice(0)) callback(timestamp); } };
}

test('recorder is restricted to exact HTTPS Sketchfab model pages', () => {
  assert.equal(modelIdFromUrl(`https://sketchfab.com/3d-models/name-${ID}`), ID);
  assert.equal(modelIdFromUrl(`https://www.sketchfab.com/models/${ID}/embed`), ID);
  for (const url of [`https://sketchfab.com.evil/models/${ID}/embed`, `http://sketchfab.com/models/${ID}/embed`, 'https://sketchfab.com/3d-models/popular']) assert.equal(modelIdFromUrl(url), null);
  assert.equal(installSketchfabViewerRecorder({ location: { href: 'https://example.com/' } }), null);
});

test('static triangle records positions, normals, UV, indices, world matrix and leaves native calls intact', async t => {
  const f = fixture(t); f.triangle();
  const snapshot = await f.recorder.snapshot(ID);
  assert.equal(snapshot.version, 1); assert.equal(snapshot.modelId, ID); assert.equal(snapshot.coordinateSystem, 'sketchfab-z-up'); assert.equal(snapshot.meshes.length, 1);
  assert.deepEqual(snapshot.meshes[0].positions, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(snapshot.meshes[0].indices, [0, 1, 2]);
  assert.deepEqual(snapshot.meshes[0].texcoords, [0, 0, 1, 0, 0, 1]);
  assert.equal(snapshot.meshes[0].normals.length, 9); assert.equal(snapshot.meshes[0].matrix[12], 3);
  assert.equal(f.gl.nativeCalls.filter(x => x[0] === 'drawElements').length, 1);
});

test('bufferData copies typed-array views and bufferSubData honors byte offsets', async t => {
  const f = fixture(t); const p = f.program(['Vertex']);
  const backing = new Float32Array([999, 0, 0, 0, 1, 0, 0, 0, 1, 0, 999]);
  f.attribute(0, backing.subarray(1, 10), 3); backing.fill(50);
  f.gl.bufferSubData(f.gl.ARRAY_BUFFER, 12, new Float32Array([2]));
  f.gl.uniformMatrix4fv(f.gl.getUniformLocation(p, 'WorldMatrix'), false, IDENTITY);
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  assert.deepEqual((await f.recorder.snapshot(ID)).meshes[0].positions, [0, 0, 0, 2, 0, 0, 0, 1, 0]);
});

test('VAO element bindings and triangle strips preserve winding and restart', async t => {
  const f = fixture(t); f.program(['Vertex']); f.gl.bindVertexArray({});
  f.attribute(0, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3);
  f.gl.bindBuffer(f.gl.ELEMENT_ARRAY_BUFFER, {}); f.gl.bufferData(f.gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 3]), 35044);
  f.gl.drawElements(f.gl.TRIANGLE_STRIP, 4, f.gl.UNSIGNED_SHORT, 0);
  assert.deepEqual((await f.recorder.snapshot(ID)).meshes[0].indices, [0, 1, 2, 2, 1, 3]);
});

test('quantized vec4 positions use shader division/swizzle/W and vec2 normals use the observed Lambert formula', async t => {
  const f = fixture(t);
  const shader = 'void main(){vec3 localVertex=Vertex.xyz;localVertex+=Vertex.w;localVertex=localVertex*uQVS/vec3(2,4,8).zxy+uQVT;vec3 localNormal=Normal.xyy;localNormal.z=dot(localNormal.xy,localNormal.xy);localNormal.xyz=vec3(2.0*localNormal.xy*sqrt(1.0-localNormal.z),1.0-2.0*localNormal.z);gl_Position=vec4(localVertex,1.0);}';
  const p = f.program(['Vertex', 'Normal'], [], [{ type: 35633, source: shader }]);
  f.attribute(0, new Uint16Array([0, 0, 0, 0, 65535, 0, 0, 0, 0, 65535, 0, 0]), 4, f.gl.UNSIGNED_SHORT, true);
  f.attribute(1, new Int16Array([0, 0, 0, 0, 0, 0]), 2, f.gl.SHORT, true);
  f.gl.uniform3fv(f.gl.getUniformLocation(p, 'uQVS'), new Float32Array([2, 3, 4]));
  f.gl.uniform3fv(f.gl.getUniformLocation(p, 'uQVT'), new Float32Array([1, 2, 3]));
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  const mesh = (await f.recorder.snapshot(ID)).meshes[0];
  assert.deepEqual(mesh.positions, [1, 2, 3, 1.25, 2, 3, 1, 3.5, 3]);
  assert.deepEqual(mesh.normals, [0, 0, 1, 0, 0, 1, 0, 0, 1]);
});

test('unrecognized quantization and skinning fail explicitly', async t => {
  const f = fixture(t); f.program(['Vertex']);
  f.attribute(0, new Uint16Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3, f.gl.UNSIGNED_SHORT, true);
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  await assert.rejects(f.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_UNSUPPORTED' });
  f.program(['Vertex', 'BoneWeight']); f.attribute(0, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3);
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  await assert.rejects(f.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_UNSUPPORTED' });
});

test('FLOAT storage still follows a verified shader quantization formula', async t => {
  const f = fixture(t);
  const p = f.program(['Vertex'], [], [{ type: 35633, source: 'void main(){vec3 localVertex=Vertex.xyz;localVertex=localVertex*uQVS*vec3(2,3,4).yzx+uQVT;gl_Position=vec4(localVertex,1.0);}' }]);
  f.attribute(0, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3);
  f.gl.uniform3fv(f.gl.getUniformLocation(p, 'uQVS'), [2, 3, 4]);
  f.gl.uniform3fv(f.gl.getUniformLocation(p, 'uQVT'), [1, 2, 3]);
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  assert.deepEqual((await f.recorder.snapshot(ID)).meshes[0].positions, [1, 2, 3, 7, 2, 3, 1, 14, 3]);
});

test('W added after quantization preserves shader operation order', async t => {
  const f = fixture(t);
  const p = f.program(['Vertex'], [], [{ type: 35633, source: 'void main(){vec3 localVertex=Vertex.xyz;localVertex=localVertex*uQVS+uQVT;localVertex+=Vertex.w;gl_Position=vec4(localVertex,1.0);}' }]);
  f.attribute(0, new Float32Array([0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1]), 4);
  f.gl.uniform3fv(f.gl.getUniformLocation(p, 'uQVS'), [2, 2, 2]);
  f.gl.uniform3fv(f.gl.getUniformLocation(p, 'uQVT'), [10, 20, 30]);
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  assert.deepEqual((await f.recorder.snapshot(ID)).meshes[0].positions, [11, 21, 31, 13, 21, 31, 11, 23, 31]);
});

test('WebGL1 keeps maximum unsigned-byte index as a vertex, not primitive restart', async t => {
  const f = fixture(t); delete f.scope.WebGL2RenderingContext;
  f.program(['Vertex']);
  const vertices = new Float32Array(256 * 3); vertices[3] = 1; vertices[255 * 3 + 1] = 1;
  f.attribute(0, vertices, 3);
  f.gl.bindBuffer(f.gl.ELEMENT_ARRAY_BUFFER, {}); f.gl.bufferData(f.gl.ELEMENT_ARRAY_BUFFER, new Uint8Array([0, 1, 255]), 35044);
  f.gl.drawElements(f.gl.TRIANGLES, 3, f.gl.UNSIGNED_BYTE, 0);
  assert.deepEqual((await f.recorder.snapshot(ID)).meshes[0].indices, [0, 1, 2]);
});

test('transparent base-color PNG capture restores framebuffer, pack buffer and pixel-store state', async t => {
  const f = fixture(t); const original = new Map(f.gl.parameters); const data = f.triangle({ textured: true });
  const result = await f.recorder.snapshot(ID);
  assert.equal(result.images.length, 1); assert.equal(result.images[0].mimeType, 'image/png');
  assert.equal(result.meshes[0].material.baseColorTexture, 0); assert.equal(f.images[0].pixels[3], 127);
  assert.deepEqual(f.gl.parameters, original);
  assert.equal(f.gl.nativeCalls.filter(x => x[0] === 'deleteTexture').length, 0);
  f.gl.deleteTexture(data.texture);
  assert.equal(f.gl.nativeCalls.filter(x => x[0] === 'deleteTexture').length, 1);
});

test('missing readable texture is an incomplete result, not a silent untextured success', async t => {
  const f = fixture(t); f.triangle({ textured: true }); f.gl.framebufferComplete = false;
  await assert.rejects(f.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_INCOMPLETE' });
});

test('known base-color sampler without a bound texture cannot silently lose its material', async t => {
  const f = fixture(t); f.triangle();
  const p = f.program(['Vertex', 'Normal', 'TexCoord0'], ['uBaseColorTexture']);
  const matrix = IDENTITY.slice(); matrix[12] = 3;
  f.gl.uniformMatrix4fv(f.gl.getUniformLocation(p, 'uModelMatrix'), false, matrix);
  f.gl.drawElements(f.gl.TRIANGLES, 3, f.gl.UNSIGNED_SHORT, 0);
  await assert.rejects(f.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_INCOMPLETE' });
});

test('scalar albedo factor accompanies a UV texture', async t => {
  const f = fixture(t); f.triangle({ textured: true });
  const p = f.program(['Vertex', 'Normal', 'TexCoord0'], ['Texture0'], [{ type: 35632, source: 'void main(){vec3 albedo = uAlbedoPBRFactor * texture(Texture0,vTexCoord0).rgb;}' }]);
  const matrix = IDENTITY.slice(); matrix[12] = 3;
  f.gl.uniformMatrix4fv(f.gl.getUniformLocation(p, 'uModelMatrix'), false, matrix);
  f.gl.uniform1f(f.gl.getUniformLocation(p, 'uAlbedoPBRFactor'), 0.25);
  f.gl.drawElements(f.gl.TRIANGLES, 3, f.gl.UNSIGNED_SHORT, 0);
  const result = await f.recorder.snapshot(ID);
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.meshes[0].material.baseColorFactor, [0.25, 0.25, 0.25, 1]);
});

test('partial texture uploads preserve full dimensions and invalidate the previous image fallback', async t => {
  const f = fixture(t); f.triangle({ textured: true });
  f.gl.texImage2D(f.gl.TEXTURE_2D, 0, f.gl.RGBA, 4, 4, 0, f.gl.RGBA, f.gl.UNSIGNED_BYTE, new Uint8Array(64));
  f.gl.texSubImage2D(f.gl.TEXTURE_2D, 0, 0, 0, 1, 1, f.gl.RGBA, f.gl.UNSIGNED_BYTE, new Uint8Array(4));
  f.gl.drawElements(f.gl.TRIANGLES, 3, f.gl.UNSIGNED_SHORT, 0);
  await f.recorder.snapshot(ID);
  assert.equal(f.images[0].pixels.length, 64);
  f.gl.texImage2D(f.gl.TEXTURE_2D, 0, f.gl.RGBA, f.gl.RGBA, f.gl.UNSIGNED_BYTE, { width: 4, height: 4 });
  f.gl.texSubImage2D(f.gl.TEXTURE_2D, 0, 0, 0, 1, 1, f.gl.RGBA, f.gl.UNSIGNED_BYTE, new Uint8Array(4));
  f.gl.drawElements(f.gl.TRIANGLES, 3, f.gl.UNSIGNED_SHORT, 0);
  f.gl.framebufferComplete = false;
  await assert.rejects(f.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_INCOMPLETE' });
});

test('vec3 diffuse material is opaque and unknown material reports a warning', async t => {
  const f = fixture(t); const p = f.program(['Vertex']);
  f.attribute(0, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3);
  f.gl.uniform3fv(f.gl.getUniformLocation(p, 'uDiffuseColor'), [0.2, 0.3, 0.4]);
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  assert.deepEqual((await f.recorder.snapshot(ID)).meshes[0].material.baseColorFactor, [0.2, 0.3, 0.4, 1]);
  const unknown = fixture(t); unknown.triangle();
  assert.ok((await unknown.recorder.snapshot(ID)).warnings.some(message => message.includes('默认材质')));
});

test('constant-UV palette is material color and is not mistaken for a UV image', async t => {
  const f = fixture(t); const p = f.program(['Vertex'], ['Texture0'], [{ type: 35632, source: 'void main(){vec3 albedo = uAlbedoPBRFactor * texture(Texture0,vec2(0.125,0.5)).rgb;}' }]);
  f.attribute(0, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3);
  f.gl.bindTexture(f.gl.TEXTURE_2D, {}); f.gl.texImage2D(f.gl.TEXTURE_2D, 0, f.gl.RGBA, 4, 1, 0, f.gl.RGBA, f.gl.UNSIGNED_BYTE, new Uint8Array(16));
  f.gl.uniform1iv(f.gl.getUniformLocation(p, 'Texture0'), new Int32Array([0])); f.gl.uniform1fv(f.gl.getUniformLocation(p, 'uAlbedoPBRFactor'), new Float32Array([0.5]));
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  const result = await f.recorder.snapshot(ID);
  assert.equal(result.images.length, 0);
  assert.deepEqual(result.meshes[0].material.baseColorFactor, [0.5, 0, 0, 127 / 255]);
});

test('quantized UVs and an independent red-channel opacity map preserve palette color and transparency', async t => {
  const f = fixture(t); f.gl.pixels = [128, 64, 32, 255];
  const vertex = 'void main(){vTexCoord0=TexCoord0.xy*uQUV0.zw+uQUV0.xy;gl_Position=uModelViewMatrix*vec4(Vertex,1.0);}';
  const fragment = 'vec3 getMaterialAlbedo(){vec3 albedo;albedo=uAlbedoPBRFactor*texture(Texture1,vec2(0.125,0.5)).rgb;return albedo;} float getMaterialOpacity(){float alpha=1.0;alpha=(texture(Texture0,vTexCoord0).r);if(uOpacityInvert==1)alpha=1.0-alpha;alpha*=uOpacityFactor;return alpha;}';
  const p = f.program(['Vertex', 'TexCoord0'], ['Texture0', 'Texture1'], [{ type: 35633, source: vertex }, { type: 35632, source: fragment }]);
  f.attribute(0, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3);
  f.attribute(1, new Float32Array([0, 0, 1, 0, 0, 1]), 2);
  for (let unit = 0; unit < 2; unit++) {
    f.gl.activeTexture(f.gl.TEXTURE0 + unit); f.gl.bindTexture(f.gl.TEXTURE_2D, {});
    f.gl.texImage2D(f.gl.TEXTURE_2D, 0, f.gl.RGBA, 1, 1, 0, f.gl.RGBA, f.gl.UNSIGNED_BYTE, new Uint8Array(f.gl.pixels));
    f.gl.uniform1iv(f.gl.getUniformLocation(p, 'Texture' + unit), [unit]);
  }
  f.gl.uniform4fv(f.gl.getUniformLocation(p, 'uQUV0'), [0.1, 0.2, 2, 3]);
  f.gl.uniform1fv(f.gl.getUniformLocation(p, 'uAlbedoPBRFactor'), [0.5]);
  f.gl.uniform1fv(f.gl.getUniformLocation(p, 'uOpacityFactor'), [0.5]);
  f.gl.uniform1iv(f.gl.getUniformLocation(p, 'uOpacityInvert'), [1]);
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  const result = await f.recorder.snapshot(ID);
  assert.deepEqual(result.meshes[0].texcoords, [0.1, 0.2, 2.1, 0.2, 0.1, 3.2]);
  assert.deepEqual(result.meshes[0].material.baseColorFactor, [64 / 255, 32 / 255, 16 / 255, 1]);
  assert.equal(result.images.length, 1);
  assert.deepEqual(f.images[0].pixels, [255, 255, 255, 64]);
});

test('screen-space shaders and active vec2 attributes never become model geometry', async t => {
  const f = fixture(t);
  const p = f.program(['Vertex']); p.attrs[0].type = 35664; f.gl.linkProgram(p);
  f.attribute(0, new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), 3);
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  await assert.rejects(f.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_UNAVAILABLE' });
  f.program(['Vertex'], [], [{ type: 35633, source: 'uniform mat4 uModelViewMatrix; void main(){gl_Position=vec4(Vertex,1.0);}' }]);
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  await assert.rejects(f.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_UNAVAILABLE' });
});

test('identified viewer ground shader is excluded without excluding author blend materials', async t => {
  const f = fixture(t);
  f.program(['Vertex'], [], [{ type: 35633, source: '#define SHADER_NAME Ground_Opaque\nvoid main(){gl_Position=uModelViewMatrix*vec4(Vertex,1.0);}' },
    { type: 35632, source: '#define SHADER_NAME Ground_Opaque\nuniform float uGroundOpacity; uniform float uGroundFade; void main(){color=getShadow()*uGroundOpacity;}' }]);
  f.attribute(0, new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), 3);
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  await assert.rejects(f.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_UNAVAILABLE' });
  f.program(['Vertex'], [], [{ type: 35633, source: '#define SHADER_NAME Shadeless_Blend(Material_001)\nvoid main(){gl_Position=uModelViewMatrix*vec4(Vertex,1.0);}' }]);
  f.gl.drawArrays(f.gl.TRIANGLES, 0, 3);
  assert.equal((await f.recorder.snapshot(ID)).meshes.length, 1);
});

test('a PBR pass replaces the same geometry from a depth pass', async t => {
  const f = fixture(t); const data = f.triangle();
  const depth = f.program(['Vertex']); f.gl.drawElements(f.gl.TRIANGLES, 3, f.gl.UNSIGNED_SHORT, 0);
  f.gl.useProgram(data.p); f.gl.drawElements(f.gl.TRIANGLES, 3, f.gl.UNSIGNED_SHORT, 0);
  const snapshot = await f.recorder.snapshot(ID);
  assert.equal(snapshot.meshes.length, 1); assert.equal(snapshot.meshes[0].matrix[12], 3);
  assert.ok(depth);
});

test('static last frame remains available and newer RAF frame replaces older transforms', async t => {
  const f = fixture(t); let first;
  f.scope.requestAnimationFrame(() => { first = f.triangle(); });
  f.runFrame(1); f.setTime(5000);
  assert.equal((await f.recorder.snapshot(ID)).meshes.length, 1);
  f.scope.requestAnimationFrame(() => {
    const matrix = IDENTITY.slice(); matrix[12] = 9;
    f.gl.uniformMatrix4fv(f.gl.getUniformLocation(first.p, 'uModelMatrix'), false, matrix);
    f.gl.drawElements(f.gl.TRIANGLES, 3, f.gl.UNSIGNED_SHORT, 0);
  });
  f.runFrame(2);
  const result = await f.recorder.snapshot(ID);
  assert.equal(result.meshes.length, 1); assert.equal(result.meshes[0].matrix[12], 9);
});

test('last-frame buffer mutation without a replacement draw fails safely', async t => {
  const f = fixture(t); const data = f.triangle();
  f.gl.bindBuffer(f.gl.ARRAY_BUFFER, data.vertex); f.gl.bufferSubData(f.gl.ARRAY_BUFFER, 0, new Float32Array([7]));
  await assert.rejects(f.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_INCOMPLETE' });
});

test('new model navigation clears previous geometry and cannot leak a prior model snapshot', async t => {
  const f = fixture(t); f.triangle();
  f.scope.location.href = `https://sketchfab.com/models/${OTHER}/embed`;
  await assert.rejects(f.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_INVALID' });
  await assert.rejects(f.recorder.snapshot(OTHER), { code: 'SKETCHFAB_VIEWER_UNAVAILABLE' });
});

test('snapshot may wait for the next draw and respects vertex/JSON limits', async t => {
  const f = fixture(t); const pending = f.recorder.snapshot(ID, { waitMs: 15 });
  setTimeout(() => f.triangle(), 2);
  assert.equal((await pending).meshes.length, 1);
  const small = fixture(t, { maxVertices: 2 }); small.triangle();
  await assert.rejects(small.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_TOO_LARGE' });
  const tiny = fixture(t, { maxJsonBytes: 16 }); tiny.triangle();
  await assert.rejects(tiny.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_TOO_LARGE' });
});

test('an over-budget draw and aggregate triangle indices reject partial snapshots', async t => {
  const f = fixture(t, { maxIndices: 3 }); f.triangle();
  f.gl.drawElements(f.gl.TRIANGLES, 6, f.gl.UNSIGNED_SHORT, 0);
  await assert.rejects(f.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_TOO_LARGE' });
  const aggregate = fixture(t, { maxIndices: 3 }); aggregate.triangle(); aggregate.triangle();
  await assert.rejects(aggregate.recorder.snapshot(ID), { code: 'SKETCHFAB_VIEWER_TOO_LARGE' });
});

test('bridge enforces source, origin, model identity, request ID and replay/rate bounds', async t => {
  const f = fixture(t); f.triangle(); const receive = f.listeners.get('message');
  const data = { type: 'mosaic:sketchfab-viewer-request', requestId: 'b'.repeat(32), modelId: ID };
  await receive({ source: {}, origin: f.scope.location.origin, data });
  await receive({ source: f.scope, origin: 'https://evil.example', data });
  assert.equal(f.responses.length, 0);
  await receive({ source: f.scope, origin: f.scope.location.origin, data });
  assert.equal(f.responses[0].body.ok, true); assert.equal(f.responses[0].origin, 'https://sketchfab.com');
  await receive({ source: f.scope, origin: f.scope.location.origin, data });
  assert.equal(f.responses[1].body.code, 'SKETCHFAB_VIEWER_UNAVAILABLE');
  f.setTime(3000);
  await receive({ source: f.scope, origin: f.scope.location.origin, data: { ...data, requestId: 'c'.repeat(32), modelId: OTHER } });
  assert.equal(f.responses[2].body.code, 'SKETCHFAB_VIEWER_INVALID');
});
