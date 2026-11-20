'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readTextureRGBA } = require('../extension/sketchfab-texture-readback.js');

const constants = {
  MAX_TEXTURE_SIZE: 3379, CURRENT_PROGRAM: 35725, ACTIVE_TEXTURE: 34016, ARRAY_BUFFER: 34962, ARRAY_BUFFER_BINDING: 34964,
  ELEMENT_ARRAY_BUFFER: 34963, VIEWPORT: 2978, COLOR_WRITEMASK: 3107, PACK_ALIGNMENT: 3333, FRAMEBUFFER: 36160,
  FRAMEBUFFER_BINDING: 36006, FRAMEBUFFER_COMPLETE: 36053, COLOR_ATTACHMENT0: 36064, TEXTURE0: 33984, TEXTURE_2D: 3553,
  TEXTURE_BINDING_2D: 32873, TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240, TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243,
  NEAREST: 9728, CLAMP_TO_EDGE: 33071, FLOAT: 5126, UNSIGNED_BYTE: 5121, STATIC_DRAW: 35044, TRIANGLES: 4, RGBA: 6408,
  VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713, LINK_STATUS: 35714, HIGH_FLOAT: 36338,
  BLEND: 3042, DEPTH_TEST: 2929, STENCIL_TEST: 2960, SCISSOR_TEST: 3089, CULL_FACE: 2884, POLYGON_OFFSET_FILL: 32823,
  SAMPLE_ALPHA_TO_COVERAGE: 32926, SAMPLE_COVERAGE: 32928, DITHER: 3024,
  VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: 34975, VERTEX_ATTRIB_ARRAY_SIZE: 34339, VERTEX_ATTRIB_ARRAY_TYPE: 34341,
  VERTEX_ATTRIB_ARRAY_NORMALIZED: 34922, VERTEX_ATTRIB_ARRAY_STRIDE: 34340, VERTEX_ATTRIB_ARRAY_ENABLED: 34338,
  VERTEX_ATTRIB_ARRAY_POINTER: 34373,
};
function fixture({ webgl2 = true, oes = false, nullAttribute = false } = {}) {
  const C = { ...constants, ...(webgl2 ? { VERTEX_ARRAY_BINDING: 34229, READ_FRAMEBUFFER: 36008, DRAW_FRAMEBUFFER: 36009,
    READ_FRAMEBUFFER_BINDING: 36010, DRAW_FRAMEBUFFER_BINDING: 36006, READ_BUFFER: 3074, SAMPLER_BINDING: 35097,
    PIXEL_PACK_BUFFER: 35051, PIXEL_UNPACK_BUFFER: 35052, PIXEL_PACK_BUFFER_BINDING: 35053, PIXEL_UNPACK_BUFFER_BINDING: 35055,
    PACK_ROW_LENGTH: 3330, PACK_SKIP_ROWS: 3331, PACK_SKIP_PIXELS: 3332, TEXTURE_BASE_LEVEL: 33084, TEXTURE_MAX_LEVEL: 33085,
    RGBA8: 32856, RASTERIZER_DISCARD: 35977, TRANSFORM_FEEDBACK_ACTIVE: 36388, TRANSFORM_FEEDBACK_PAUSED: 36387 } : {}) };
  let next = 0;
  const object = type => ({ type, id: ++next });
  const oldTexture = object('oldTexture'), source = object('source'), otherTexture = object('otherTexture');
  source.pixels = [20, 70, 130, 127, 220, 110, 25, 255]; source.compressed = true;
  for (const texture of [oldTexture, source, otherTexture]) texture.params = new Map([[C.TEXTURE_MIN_FILTER, 9987], [C.TEXTURE_MAG_FILTER, 9729],
    [C.TEXTURE_WRAP_S, 10497], [C.TEXTURE_WRAP_T, 33648], ...(webgl2 ? [[C.TEXTURE_BASE_LEVEL, 2], [C.TEXTURE_MAX_LEVEL, 6]] : [])]);
  const originalVAO = object('oldVAO'), originalBuffer = object('oldArrayBuffer'), originalAttribute = object('oldAttributeBuffer');
  const originalRead = object('oldReadFbo'), originalDraw = object('oldDrawFbo'), originalProgram = object('oldProgram');
  const originalPack = object('oldPack'), originalUnpack = object('oldUnpack'), originalSampler = object('oldSampler');
  const attrib = () => ({ buffer: nullAttribute ? null : originalAttribute, size: 4, type: 5123, normalized: true, stride: 16, offset: 8, enabled: false, divisor: 3 });
  originalVAO.attribute = attrib();
  const state = { active: C.TEXTURE0 + 3, program: originalProgram, arrayBuffer: originalBuffer, vao: originalVAO,
    units: new Map([[0, oldTexture], [3, otherTexture]]), samplers: new Map([[0, originalSampler]]),
    read: originalRead, draw: webgl2 ? originalDraw : originalRead, readBuffer: 36065,
    viewport: [7, 11, 500, 300], colorMask: [false, true, false, true], packAlignment: 8, rowLength: 12, skipRows: 2, skipPixels: 3,
    packBuffer: originalPack, unpackBuffer: originalUnpack, feedbackActive: true, feedbackPaused: false, enabled: new Set([C.BLEND, C.DEPTH_TEST, C.STENCIL_TEST, C.SCISSOR_TEST,
      C.CULL_FACE, C.POLYGON_OFFSET_FILL, C.SAMPLE_ALPHA_TO_COVERAGE, C.SAMPLE_COVERAGE, C.DITHER, ...(webgl2 ? [C.RASTERIZER_DISCARD] : [])]) };
  const allocations = [], deleted = new Set(), calls = [];
  const create = type => { const value = object(type); allocations.push(value); return value; };
  const gl = { ...C, failCompile: false, failFramebuffer: false, failDraw: false,
    getParameter(key) {
      const map = new Map([[C.MAX_TEXTURE_SIZE, 16384], [C.CURRENT_PROGRAM, state.program], [C.ACTIVE_TEXTURE, state.active],
        [C.ARRAY_BUFFER_BINDING, state.arrayBuffer], [C.VIEWPORT, state.viewport.slice()], [C.COLOR_WRITEMASK, state.colorMask.slice()],
        [C.PACK_ALIGNMENT, state.packAlignment], [C.FRAMEBUFFER_BINDING, state.draw], [C.TEXTURE_BINDING_2D, state.units.get(state.active - C.TEXTURE0) || null],
        [C.VERTEX_ARRAY_BINDING, state.vao], [C.READ_FRAMEBUFFER_BINDING, state.read], [C.READ_BUFFER, state.readBuffer],
        [C.SAMPLER_BINDING, state.samplers.get(state.active - C.TEXTURE0)], [C.PIXEL_PACK_BUFFER_BINDING, state.packBuffer],
        [C.PIXEL_UNPACK_BUFFER_BINDING, state.unpackBuffer], [C.PACK_ROW_LENGTH, state.rowLength], [C.PACK_SKIP_ROWS, state.skipRows],
        [C.PACK_SKIP_PIXELS, state.skipPixels], [34229, state.vao], [C.TRANSFORM_FEEDBACK_ACTIVE, state.feedbackActive], [C.TRANSFORM_FEEDBACK_PAUSED, state.feedbackPaused]]);
      if (!map.has(key)) throw new Error('Unexpected parameter ' + key); return map.get(key);
    },
    isTexture: value => value === source || allocations.includes(value), isContextLost: () => false,
    isEnabled: key => state.enabled.has(key), enable: key => state.enabled.add(key), disable: key => state.enabled.delete(key),
    activeTexture: value => { state.active = value; }, bindTexture: (_target, value) => state.units.set(state.active - C.TEXTURE0, value),
    getTexParameter: (_target, key) => state.units.get(state.active - C.TEXTURE0).params.get(key),
    texParameteri: (_target, key, value) => { const texture = state.units.get(state.active - C.TEXTURE0); texture.params ||= new Map(); texture.params.set(key, value); },
    getShaderPrecisionFormat: () => ({ precision: 23 }), createShader: type => create(type),
    shaderSource: (shader, source) => { shader.source = source; }, compileShader() {}, getShaderParameter: () => !gl.failCompile,
    createProgram: () => create('program'), attachShader() {}, bindAttribLocation() {}, linkProgram() {}, getProgramParameter: () => true,
    useProgram: value => { state.program = value; }, getUniformLocation: (program, name) => ({ program, name }),
    uniform1i(location, value) { location.program.uniforms ||= {}; location.program.uniforms[location.name] = value; },
    createBuffer: () => create('buffer'), bindBuffer(target, value) { if (target === C.ARRAY_BUFFER) state.arrayBuffer = value;
      else if (target === C.PIXEL_PACK_BUFFER) state.packBuffer = value; else if (target === C.PIXEL_UNPACK_BUFFER) state.unpackBuffer = value; else throw new Error('Unexpected bind buffer'); },
    bufferData() {}, vertexAttribPointer(_index, size, type, normalized, stride, offset) { Object.assign(state.vao.attribute, { buffer: state.arrayBuffer, size, type, normalized, stride, offset }); },
    enableVertexAttribArray: () => { state.vao.attribute.enabled = true; }, disableVertexAttribArray: () => { state.vao.attribute.enabled = false; },
    getVertexAttrib(_index, key) { const a = state.vao.attribute; return new Map([[C.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING, a.buffer], [C.VERTEX_ATTRIB_ARRAY_SIZE, a.size],
      [C.VERTEX_ATTRIB_ARRAY_TYPE, a.type], [C.VERTEX_ATTRIB_ARRAY_NORMALIZED, a.normalized], [C.VERTEX_ATTRIB_ARRAY_STRIDE, a.stride], [C.VERTEX_ATTRIB_ARRAY_ENABLED, a.enabled], [35070, a.divisor]]).get(key); },
    getVertexAttribOffset: () => state.vao.attribute.offset,
    createTexture: () => create('texture'), texImage2D(_target, _level, _internal, width, height) { assert.equal(state.unpackBuffer, webgl2 ? null : originalUnpack); state.units.get(state.active-C.TEXTURE0).width=width; state.units.get(state.active-C.TEXTURE0).height=height; },
    createFramebuffer: () => create('framebuffer'),
    bindFramebuffer(target, value) { if (target === C.FRAMEBUFFER || target === C.DRAW_FRAMEBUFFER) state.draw = value; if (target === C.FRAMEBUFFER || target === C.READ_FRAMEBUFFER) state.read = value; },
    framebufferTexture2D(_target, _attachment, _textarget, texture) { assert.notEqual(texture, source, 'compressed source is never directly attached'); state.draw.texture = texture; },
    checkFramebufferStatus: () => gl.failFramebuffer ? 0 : C.FRAMEBUFFER_COMPLETE,
    viewport: (...values) => { state.viewport = values; }, colorMask: (...values) => { state.colorMask = values; },
    pixelStorei(key, value) { const field = new Map([[C.PACK_ALIGNMENT, 'packAlignment'], [C.PACK_ROW_LENGTH, 'rowLength'], [C.PACK_SKIP_ROWS, 'skipRows'], [C.PACK_SKIP_PIXELS, 'skipPixels']]).get(key); if (!field) throw new Error('Unexpected pixel store'); state[field] = value; },
    drawArrays(mode, first, count) {
      assert.equal(mode, C.TRIANGLES); assert.equal(first, 0); assert.equal(count, 3);
      assert.equal(state.enabled.size, 0); assert.deepEqual(state.colorMask, [true,true,true,true]);
      assert.equal(state.units.get(0), source); assert.equal(source.params.get(C.TEXTURE_MIN_FILTER), C.NEAREST);
      if (webgl2) { assert.equal(state.samplers.get(0), null); assert.equal(source.params.get(C.TEXTURE_BASE_LEVEL), 0); assert.equal(state.feedbackPaused,true); }
      calls.push('draw'); if (gl.failDraw) throw new Error('fixture draw failure');
      let pixels = source.pixels.slice();
      if (state.program.uniforms.encodeSrgb) pixels = pixels.map((c,i) => i%4===3 ? c : Math.round((c/255 <= .0031308 ? c/255*12.92 : 1.055*Math.pow(c/255,1/2.4)-.055)*255));
      state.draw.pixels = pixels;
    },
    readPixels(_x, _y, _w, _h, _format, _type, pixels) { assert.equal(state.packAlignment,1); if (webgl2) { assert.equal(state.packBuffer,null); assert.equal(state.rowLength,0); assert.equal(state.skipRows,0); assert.equal(state.skipPixels,0); } pixels.set(state.read.pixels); },
    deleteShader: value => deleted.add(value), deleteProgram: value => deleted.add(value), deleteTexture: value => deleted.add(value), deleteFramebuffer: value => deleted.add(value),
    deleteBuffer(value) { deleted.add(value); for(const item of [originalVAO,...allocations])if(item.attribute?.buffer===value)item.attribute.buffer=null; },
    getError() { throw new Error('Must not consume page GL errors'); },
  };
  const createVAO=()=>{const value=create('vao');value.attribute=attrib();return value;};
  if(webgl2)Object.assign(gl,{createVertexArray:createVAO,bindVertexArray:value=>{state.vao=value;},deleteVertexArray:value=>deleted.add(value),
    bindSampler:(unit,value)=>state.samplers.set(unit,value),drawBuffers(){},readBuffer:value=>{state.readBuffer=value;},pauseTransformFeedback:()=>{state.feedbackPaused=true;},resumeTransformFeedback:()=>{state.feedbackPaused=false;}});
  gl.getExtension = name => name==='OES_vertex_array_object' && oes ? { VERTEX_ARRAY_BINDING_OES:34229,createVertexArrayOES:createVAO,
    bindVertexArrayOES:value=>{state.vao=value;},deleteVertexArrayOES:value=>deleted.add(value)}
    : name==='ANGLE_instanced_arrays' ? {VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE:35070,vertexAttribDivisorANGLE:(_index,value)=>{state.vao.attribute.divisor=value;}} : null;
  function snapshot(){return {program:state.program,active:state.active,arrayBuffer:state.arrayBuffer,vao:state.vao,
    units:[...state.units],samplers:[...state.samplers],read:state.read,draw:state.draw,readBuffer:state.readBuffer,viewport:state.viewport.slice(),
    colorMask:state.colorMask.slice(),packAlignment:state.packAlignment,rowLength:state.rowLength,skipRows:state.skipRows,skipPixels:state.skipPixels,
    packBuffer:state.packBuffer,unpackBuffer:state.unpackBuffer,feedbackActive:state.feedbackActive,feedbackPaused:state.feedbackPaused,enabled:[...state.enabled].sort(),attribute:{...originalVAO.attribute},
    textureParameters:[...source.params]};}
  return {gl,source,allocations,deleted,calls,snapshot};
}

for(const options of [{webgl2:true},{webgl2:false,oes:true},{webgl2:false},{webgl2:false,nullAttribute:true}])test('sampling restores all page state: '+JSON.stringify(options),()=>{
  const f=fixture(options),before=f.snapshot();const result=readTextureRGBA(f.gl,f.source,2,1);
  assert.deepEqual([...result],f.source.pixels);assert.deepEqual(f.snapshot(),before);assert.equal(f.calls.length,1);
  assert.equal(f.allocations.length,f.deleted.size);
});
for(const stage of ['failCompile','failFramebuffer','failDraw'])test('failure restores page state and deletes temporary resources: '+stage,()=>{
  const f=fixture(),before=f.snapshot();f.gl[stage]=true;
  assert.throws(()=>readTextureRGBA(f.gl,f.source,2,1));assert.deepEqual(f.snapshot(),before);assert.equal(f.allocations.length,f.deleted.size);
});
test('optional sRGB encoding changes RGB only and leaves the alpha channel intact',()=>{
  const f=fixture(),before=f.snapshot();const result=readTextureRGBA(f.gl,f.source,2,1,{encodeSrgb:true});
  assert.equal(result[3],127);assert.equal(result[7],255);assert.ok(result[0]>20);assert.ok(result[1]>70);assert.deepEqual(f.snapshot(),before);
});
test('invalid dimensions, foreign textures and nonboolean sRGB options are rejected before mutation',()=>{
  const f=fixture(),before=f.snapshot();for(const [texture,w,h,options]of [[f.source,0,1],[f.source,2.5,1],[f.source,16385,1],[{},2,1],[f.source,2,1,{encodeSrgb:1}],[f.source,2,1,null]])
    assert.throws(()=>readTextureRGBA(f.gl,texture,w,h,options),{code:'SKETCHFAB_VIEWER_INCOMPLETE'});
  assert.deepEqual(f.snapshot(),before);assert.equal(f.allocations.length,0);
});
