(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MosaicSketchfabTextureReadback = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  // Sampling is required for compressed textures: they can be sampled by the
  // viewer but cannot generally be attached directly as a color framebuffer.
  // The caller must suspend its GL observers for this synchronous operation.
  function unavailable() {
    return Object.assign(new Error('Sketchfab texture readback is unavailable.'), { code: 'SKETCHFAB_VIEWER_INCOMPLETE' });
  }
  function readTextureRGBA(gl, texture, width, height, options = {}) {
    if (!gl || !texture || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        !options || typeof options !== 'object' || Array.isArray(options) ||
        (options.encodeSrgb !== undefined && typeof options.encodeSrgb !== 'boolean')) throw unavailable();
    const webgl2 = typeof gl.createVertexArray === 'function' && typeof gl.bindVertexArray === 'function' &&
      typeof gl.drawBuffers === 'function' && gl.READ_FRAMEBUFFER !== undefined;
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (!Number.isInteger(maxSize) || width > maxSize || height > maxSize || width * height > 64 * 1024 * 1024 ||
        (typeof gl.isTexture === 'function' && !gl.isTexture(texture)) || gl.isContextLost?.()) throw unavailable();
    const oes = !webgl2 ? gl.getExtension('OES_vertex_array_object') : null;
    const angle = !webgl2 && !oes ? gl.getExtension('ANGLE_instanced_arrays') : null;
    const vao = webgl2 ? { key: gl.VERTEX_ARRAY_BINDING, create: () => gl.createVertexArray(), bind: value => gl.bindVertexArray(value), remove: value => gl.deleteVertexArray(value) }
      : oes ? { key: oes.VERTEX_ARRAY_BINDING_OES, create: () => oes.createVertexArrayOES(), bind: value => oes.bindVertexArrayOES(value), remove: value => oes.deleteVertexArrayOES(value) } : null;
    const get = key => gl.getParameter(key);
    const original = {
      program: get(gl.CURRENT_PROGRAM), activeTexture: get(gl.ACTIVE_TEXTURE), arrayBuffer: get(gl.ARRAY_BUFFER_BINDING),
      viewport: Array.from(get(gl.VIEWPORT)), colorMask: Array.from(get(gl.COLOR_WRITEMASK)),
      packAlignment: get(gl.PACK_ALIGNMENT), framebuffer: get(gl.FRAMEBUFFER_BINDING),
      ...(vao ? { vao: get(vao.key) } : {}),
      ...(webgl2 ? { readFramebuffer: get(gl.READ_FRAMEBUFFER_BINDING), drawFramebuffer: get(gl.DRAW_FRAMEBUFFER_BINDING),
        readBuffer: get(gl.READ_BUFFER), packBuffer: get(gl.PIXEL_PACK_BUFFER_BINDING), unpackBuffer: get(gl.PIXEL_UNPACK_BUFFER_BINDING),
        packRowLength: get(gl.PACK_ROW_LENGTH), packSkipRows: get(gl.PACK_SKIP_ROWS), packSkipPixels: get(gl.PACK_SKIP_PIXELS),
        transformFeedbackActive: get(gl.TRANSFORM_FEEDBACK_ACTIVE), transformFeedbackPaused: get(gl.TRANSFORM_FEEDBACK_PAUSED) } : {})
    };
    const capabilities = [gl.BLEND, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.SCISSOR_TEST, gl.CULL_FACE, gl.POLYGON_OFFSET_FILL,
      gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE, gl.DITHER, ...(webgl2 ? [gl.RASTERIZER_DISCARD] : [])]
      .filter(key => key !== undefined).map(key => [key, gl.isEnabled(key)]);
    if (!webgl2 && !vao) {
      original.attribute = {
        buffer: gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),
        size: gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_SIZE), type: gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_TYPE),
        normalized: gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED), stride: gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_STRIDE),
        enabled: gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_ENABLED), offset: gl.getVertexAttribOffset(0, gl.VERTEX_ATTRIB_ARRAY_POINTER),
        ...(angle ? { divisor: gl.getVertexAttrib(0, angle.VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE) } : {})
      };
    }
    let sourceParameters, unitTexture, unitSampler, unitSaved = false, pausedFeedback = false, vertexArray, buffer, framebuffer, destination, program, vertexShader, fragmentShader;
    const createShader = (type, source) => {
      const shader = gl.createShader(type); if (!shader) throw unavailable();
      if (type === gl.VERTEX_SHADER) vertexShader = shader; else fragmentShader = shader;
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw unavailable(); return shader;
    };
    try {
      if (original.transformFeedbackActive && !original.transformFeedbackPaused) { gl.pauseTransformFeedback(); pausedFeedback = true; }
      gl.activeTexture(gl.TEXTURE0);
      unitTexture = get(gl.TEXTURE_BINDING_2D); if (webgl2) unitSampler = get(gl.SAMPLER_BINDING); unitSaved = true;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      const parameterKeys = [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER, gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T,
        ...(webgl2 ? [gl.TEXTURE_BASE_LEVEL, gl.TEXTURE_MAX_LEVEL] : [])];
      sourceParameters = parameterKeys.map(key => [key, gl.getTexParameter(gl.TEXTURE_2D, key)]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (webgl2) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0); gl.bindSampler(0, null); }
      if (vao) { vertexArray = vao.create(); if (!vertexArray) throw unavailable(); vao.bind(vertexArray); }
      const vertexSource = webgl2
        ? '#version 300 es\nprecision highp float;out vec2 uv;void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=p;gl_Position=vec4(p*2.0-1.0,0.0,1.0);}'
        : 'attribute vec2 position;varying vec2 uv;void main(){uv=position*0.5+0.5;gl_Position=vec4(position,0.0,1.0);}';
      const precision = !gl.getShaderPrecisionFormat || gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ? 'highp' : 'mediump';
      const fragmentSource = (webgl2 ? '#version 300 es\n' : '') + 'precision ' + precision + ' float;' +
        (webgl2 ? 'in vec2 uv;out vec4 result;' : 'varying vec2 uv;') +
        'uniform sampler2D source;uniform bool encodeSrgb;vec3 srgb(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));}' +
        'void main(){vec4 c=' + (webgl2 ? 'texture' : 'texture2D') + '(source,uv);if(encodeSrgb)c.rgb=srgb(c.rgb);' + (webgl2 ? 'result' : 'gl_FragColor') + '=c;}';
      program = gl.createProgram(); if (!program) throw unavailable();
      gl.attachShader(program, createShader(gl.VERTEX_SHADER, vertexSource)); gl.attachShader(program, createShader(gl.FRAGMENT_SHADER, fragmentSource));
      if (!webgl2) gl.bindAttribLocation(program, 0, 'position');
      gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw unavailable();
      gl.useProgram(program); gl.uniform1i(gl.getUniformLocation(program, 'source'), 0); gl.uniform1i(gl.getUniformLocation(program, 'encodeSrgb'), options.encodeSrgb ? 1 : 0);
      if (!webgl2) {
        buffer = gl.createBuffer(); if (!buffer) throw unavailable(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(0); if (angle) angle.vertexAttribDivisorANGLE(0, 0);
      }
      destination = gl.createTexture(); framebuffer = gl.createFramebuffer(); if (!destination || !framebuffer) throw unavailable();
      gl.bindTexture(gl.TEXTURE_2D, destination);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (webgl2) gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.texImage2D(gl.TEXTURE_2D, 0, webgl2 ? gl.RGBA8 : gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, destination, 0);
      if (webgl2) { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); gl.readBuffer(gl.COLOR_ATTACHMENT0); }
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw unavailable();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const [key] of capabilities) gl.disable(key);
      gl.colorMask(true, true, true, true); gl.viewport(0, 0, width, height);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      if (webgl2) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.PACK_SKIP_ROWS, 0); gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (gl.isContextLost?.()) throw unavailable();
      return pixels;
    } finally {
      // Restore the exact state while all temporary objects still exist. In
      // WebGL1 deleting our VBO below clears a formerly-null attribute binding.
      try {
      if (unitSaved) {
        gl.activeTexture(gl.TEXTURE0);
        if (sourceParameters) { gl.bindTexture(gl.TEXTURE_2D, texture); for (const [key, value] of sourceParameters) gl.texParameteri(gl.TEXTURE_2D, key, value); }
        gl.bindTexture(gl.TEXTURE_2D, unitTexture); if (webgl2) gl.bindSampler(0, unitSampler);
      }
      if (vao) vao.bind(original.vao);
      else if (original.attribute && buffer) {
        const a = original.attribute; gl.bindBuffer(gl.ARRAY_BUFFER, a.buffer || buffer);
        gl.vertexAttribPointer(0, a.size, a.type, a.normalized, a.stride, a.offset);
        a.enabled ? gl.enableVertexAttribArray(0) : gl.disableVertexAttribArray(0);
        if (angle) angle.vertexAttribDivisorANGLE(0, a.divisor);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, original.arrayBuffer); gl.useProgram(original.program);
      if (webgl2) {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, original.drawFramebuffer); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, original.readFramebuffer);
        gl.readBuffer(original.readBuffer); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, original.packBuffer); gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, original.unpackBuffer);
        gl.pixelStorei(gl.PACK_ROW_LENGTH, original.packRowLength); gl.pixelStorei(gl.PACK_SKIP_ROWS, original.packSkipRows); gl.pixelStorei(gl.PACK_SKIP_PIXELS, original.packSkipPixels);
      } else gl.bindFramebuffer(gl.FRAMEBUFFER, original.framebuffer);
      gl.pixelStorei(gl.PACK_ALIGNMENT, original.packAlignment); gl.viewport(...original.viewport); gl.colorMask(...original.colorMask);
      for (const [key, enabled] of capabilities) enabled ? gl.enable(key) : gl.disable(key);
      gl.activeTexture(original.activeTexture);
      if (pausedFeedback) { gl.resumeTransformFeedback(); pausedFeedback = false; }
      } finally {
        // A page wrapper throwing during restoration must not leak every
        // subsequent temporary resource. Native WebGL deletion is nonthrowing.
        const release = action => { try { action(); } catch {} };
        if (buffer) release(() => gl.deleteBuffer(buffer)); if (vertexArray) release(() => vao.remove(vertexArray));
        if (framebuffer) release(() => gl.deleteFramebuffer(framebuffer)); if (destination) release(() => gl.deleteTexture(destination));
        if (program) release(() => gl.deleteProgram(program)); if (vertexShader) release(() => gl.deleteShader(vertexShader)); if (fragmentShader) release(() => gl.deleteShader(fragmentShader));
      }
    }
  }
  return { readTextureRGBA };
});
