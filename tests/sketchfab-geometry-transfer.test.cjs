'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { compactGeometry, MIN_COMPONENTS } = require('../extension/sketchfab-geometry-transfer.js');
const sample = () => ({ version: 1, modelId: '0123456789abcdef0123456789abcdef', meshes: [{
  positions: [0.123456789, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0,0,1, 0,0,1, 0,0,1], texcoords: [0,0,1,0,0,1],
  indices: [0,1,2], joints: [0,1,0,0, 0,1,0,0, 0,1,0,0], weights: [0.5,0.5,0,0, 1,0,0,0, 0,1,0,0], material: { metallicFactor: 0.4 } }], images: [],
  scene: { nodes: [{ mesh: 0 }], animations: [{ channels: [{ times: [0,1], values: [0,0,0,1,0,0] }] }] } });

test('compact geometry is little-endian binary, clones its container and leaves nongeometry data intact', () => {
  const input = sample(), saved = structuredClone(input), result = compactGeometry(input, { minimumComponents: 0 });
  assert.deepEqual(input, saved); assert.notEqual(result, input); assert.notEqual(result.meshes, input.meshes); assert.notEqual(result.meshes[0], input.meshes[0]);
  assert.equal(result.images, input.images); assert.equal(result.scene, input.scene); assert.equal(result.meshes[0].material, input.meshes[0].material);
  for (const key of ['positions','normals','texcoords','weights','indices','joints']) {
    const data = result.meshes[0][key], bytes = Buffer.from(data.data, 'base64'), integers = ['indices','joints'].includes(key);
    assert.equal(data.componentType, integers ? 'uint32' : 'float32'); assert.equal(data.count, input.meshes[0][key].length);
    assert.equal(bytes.length, data.count * 4); assert.equal(bytes.toString('base64'), data.data);
    for (let i = 0; i < data.count; i++) assert.equal(integers ? bytes.readUInt32LE(i * 4) : bytes.readFloatLE(i * 4), integers ? input.meshes[0][key][i] : Math.fround(input.meshes[0][key][i]));
  }
  assert.deepEqual(compactGeometry(result), result);
});

test('the threshold applies to total geometry across many meshes and leaves small captures as arrays', () => {
  const small = sample(), result = compactGeometry(small); assert.ok(Array.isArray(result.meshes[0].positions));
  const half = Math.ceil(MIN_COMPONENTS / 2), large = { meshes: [{ positions: Array(half).fill(0.1) }, { positions: Array(half).fill(0.2) }] };
  const converted = compactGeometry(large);
  assert.equal(converted.meshes[0].positions.count, half); assert.equal(converted.meshes[1].positions.count, half);
});

test('the browser UMD path encodes without a Node Buffer global', () => {
  const context = { btoa: data => Buffer.from(data, 'binary').toString('base64') };
  vm.createContext(context); vm.runInContext(fs.readFileSync(require.resolve('../extension/sketchfab-geometry-transfer.js'), 'utf8'), context);
  const output = vm.runInContext('MosaicSketchfabGeometryTransfer.compactGeometry({meshes:[{positions:[0.25,0,0,1,0,0,0,1,0]}]}, {minimumComponents:0})', context);
  assert.equal(output.meshes[0].positions.componentType, 'float32'); assert.equal(output.meshes[0].positions.data, 'AACAPgAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAA');
});

test('invalid values are rejected before Float32 or Uint32 conversion can coerce them', () => {
  for (const value of [NaN, Infinity, -Infinity, 1e40, '1', null]) {
    const input = sample(); input.meshes[0].positions[0] = value;
    assert.throws(() => compactGeometry(input, { minimumComponents: 0 }), { code: 'SKETCHFAB_VIEWER_INVALID' });
  }
  for (const value of [-1, 0.5, 4294967296, NaN, '0']) {
    const input = sample(); input.meshes[0].indices[0] = value;
    assert.throws(() => compactGeometry(input, { minimumComponents: 0 }), { code: 'SKETCHFAB_VIEWER_INVALID' });
  }
  let read = false; const input = sample(); Object.defineProperty(input.meshes[0].positions, '0', { enumerable: true, get() { read = true; return 0; } });
  assert.throws(() => compactGeometry(input), { code: 'SKETCHFAB_VIEWER_INVALID' }); assert.equal(read, false);
  const sparse = sample(); delete sparse.meshes[0].positions[2]; assert.throws(() => compactGeometry(sparse), { code: 'SKETCHFAB_VIEWER_INVALID' });
});
