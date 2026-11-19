'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { exportSketchfabViewer, DEFAULT_LIMITS } = require('../src/sketchfab-viewer-export.cjs');

const modelId = '0123456789abcdef0123456789abcdef';
const triangle = () => ({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] });
const snapshot = (meshes = [triangle()], images = []) => ({ version: 1, modelId, meshes, images });
const jpeg = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z', 'base64');
function crc32(bytes) {
  let result = 0xffffffff;
  for (const byte of bytes) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit++) result = result & 1 ? result >>> 1 ^ 0xedb88320 : result >>> 1;
  }
  return (result ^ 0xffffffff) >>> 0;
}
function png(colorType = 6, transparentPalette = false) {
  function chunk(type, data) {
    const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4);
    data.copy(bytes, 8); bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4); return bytes;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = colorType;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    ...(colorType === 3 ? [chunk('PLTE', Buffer.from([100, 150, 200])), ...(transparentPalette ? [chunk('tRNS', Buffer.from([0]))] : [])] : []),
    chunk('IDAT', deflateSync(Buffer.from(colorType === 6 ? [0, 100, 150, 200, 96] : colorType === 2 ? [0, 100, 150, 200] : [0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}
function image(bytes = png(), mimeType = 'image/png') { return { name: 'texture', mimeType, data: bytes.toString('base64') }; }
function pngSize(width, height) {
  const bytes = png(); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29); return bytes;
}
function jpegSize(width, height) {
  const bytes = Buffer.from(jpeg), sof = bytes.indexOf(Buffer.from([255, 192]));
  assert.ok(sof > 0); bytes.writeUInt16BE(height, sof + 5); bytes.writeUInt16BE(width, sof + 7); return bytes;
}
function parseGlb(glb) {
  assert.equal(glb.readUInt32LE(0), 0x46546c67); assert.equal(glb.readUInt32LE(4), 2); assert.equal(glb.readUInt32LE(8), glb.length);
  const jsonLength = glb.readUInt32LE(12); assert.equal(jsonLength % 4, 0); assert.equal(glb.readUInt32LE(16), 0x4e4f534a);
  const jsonChunk = glb.subarray(20, 20 + jsonLength), doc = JSON.parse(jsonChunk.toString('utf8'));
  const binAt = 20 + jsonLength, binLength = glb.readUInt32LE(binAt); assert.equal(binLength % 4, 0); assert.equal(glb.readUInt32LE(binAt + 4), 0x004e4942);
  assert.equal(binAt + 8 + binLength, glb.length); assert.equal(doc.buffers[0].byteLength, binLength); assert.equal(doc.buffers[0].uri, undefined);
  const binary = glb.subarray(binAt + 8);
  for (const view of doc.bufferViews) { assert.equal(view.byteOffset % 4, 0); assert.ok(view.byteOffset + view.byteLength <= binary.length); }
  return { doc, binary, jsonChunk };
}
function bufferView(parsed, index) { const view = parsed.doc.bufferViews[index]; return parsed.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength); }
function accessor(parsed, index) {
  const value = parsed.doc.accessors[index], bytes = bufferView(parsed, value.bufferView), width = value.componentType === 5123 ? 2 : 4;
  return Array.from({ length: bytes.length / width }, (_, i) => value.componentType === 5126 ? bytes.readFloatLE(i * width) : width === 2 ? bytes.readUInt16LE(i * width) : bytes.readUInt32LE(i * width));
}
function transform(matrix, point) {
  const p = [...point, 1];
  return [0, 1, 2].map(row => p.reduce((sum, value, column) => sum + matrix[column * 4 + row] * value, 0));
}
function multiply(a, b) {
  return Array.from({ length: 16 }, (_, i) => {
    const column = Math.floor(i / 4), row = i % 4;
    return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[column * 4 + k], 0);
  });
}
function invalid(input, options, code = 'SKETCHFAB_VIEWER_INVALID') {
  assert.throws(() => exportSketchfabViewer(input, options), error => error.code === code && !error.message.includes('fixture-secret'));
}

test('writes valid GLB chunks, exact positions, float bounds, indices and node matrix without mutating input', () => {
  const input = snapshot([{ ...triangle(), name: '三角形', positions: [-0.1, 0, 0, 1.1, 0, 0, 0, 2.2, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    texcoords: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2], matrix: [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 7, 8, 9, 1], material: { baseColorFactor: [0.25, 0.5, 1, 1], doubleSided: true } }]);
  const copy = structuredClone(input), result = exportSketchfabViewer(input), parsed = parseGlb(result.glb), primitive = parsed.doc.meshes[0].primitives[0];
  assert.deepEqual(input, copy); assert.equal(parsed.doc.asset.version, '2.0'); assert.equal(parsed.doc.asset.extras.modelId, modelId);
  assert.deepEqual(parsed.doc.scenes, [{ nodes: [0] }]); assert.equal(parsed.doc.scene, 0); assert.deepEqual(parsed.doc.nodes[0].matrix, input.meshes[0].matrix);
  assert.deepEqual(accessor(parsed, primitive.attributes.POSITION), input.meshes[0].positions.map(Math.fround));
  assert.deepEqual(parsed.doc.accessors[primitive.attributes.POSITION].min, [Math.fround(-0.1), 0, 0]);
  assert.deepEqual(parsed.doc.accessors[primitive.attributes.POSITION].max, [Math.fround(1.1), Math.fround(2.2), 0]);
  assert.deepEqual(accessor(parsed, primitive.attributes.NORMAL), input.meshes[0].normals);
  assert.deepEqual(accessor(parsed, primitive.attributes.TEXCOORD_0), input.meshes[0].texcoords);
  assert.deepEqual(accessor(parsed, primitive.indices), [0, 1, 2]); assert.equal(parsed.doc.accessors[primitive.indices].componentType, 5123);
  assert.equal(primitive.mode, 4); assert.equal(parsed.doc.materials[0].doubleSided, true);
  assert.deepEqual(parsed.doc.materials[0].pbrMetallicRoughness, { metallicFactor: 0, roughnessFactor: 1, baseColorFactor: [0.25, 0.5, 1, 1] });
  assert.equal(result.stats.inputJsonBytes, Buffer.byteLength(JSON.stringify(input)));
  assert.deepEqual({ ...result.stats, glbBytes: 0 }, { meshCount: 1, vertexCount: 3, triangleCount: 1, imageCount: 0, imageBytes: 0, inputJsonBytes: Buffer.byteLength(JSON.stringify(input)), glbBytes: 0 });
});

test('preserves embedded PNG/JPEG bytes and only enables transparency for alpha, tRNS or a translucent factor', () => {
  const images = [image(png(6)), image(png(2)), image(png(3, true)), image(jpeg, 'image/jpeg')];
  const meshes = images.map((_, index) => ({ ...triangle(), texcoords: [0, 0, 1, 0, 0, 1], material: { baseColorTexture: index } }));
  meshes.push({ ...triangle(), material: { baseColorFactor: [1, 1, 1, 0.5] } });
  const parsed = parseGlb(exportSketchfabViewer(snapshot(meshes, images)).glb);
  images.forEach((value, index) => {
    assert.equal(parsed.doc.images[index].mimeType, value.mimeType); assert.equal(parsed.doc.images[index].uri, undefined);
    assert.deepEqual(bufferView(parsed, parsed.doc.images[index].bufferView), Buffer.from(value.data, 'base64'));
    assert.equal(parsed.doc.bufferViews[parsed.doc.images[index].bufferView].target, undefined);
    assert.deepEqual(parsed.doc.textures[index], { source: index });
    assert.deepEqual(parsed.doc.materials[index].pbrMetallicRoughness.baseColorTexture, { index });
  });
  assert.deepEqual(parsed.doc.materials.map(value => value.alphaMode), ['BLEND', undefined, 'BLEND', undefined, 'BLEND']);
});

test('Sketchfab Z-up conversion adds only a parent and composes with original mesh transforms', () => {
  const child = [2, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 4, 5, 6, 1];
  const input = { ...snapshot([{ positions: [1, 2, 3, 2, 2, 3, 1, 3, 3], matrix: child }, triangle()]), coordinateSystem: 'sketchfab-z-up' };
  const saved = structuredClone(input), result = exportSketchfabViewer(input), parsed = parseGlb(result.glb);
  assert.deepEqual(input, saved); assert.equal(result.stats.meshCount, 2);
  assert.deepEqual(parsed.doc.scenes[0].nodes, [2]); assert.deepEqual(parsed.doc.nodes[2].children, [0, 1]);
  const rotation = parsed.doc.nodes[2].matrix;
  assert.deepEqual(rotation, [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parsed.doc.nodes[0].matrix, child); assert.equal(parsed.doc.nodes[1].matrix, undefined);
  const position = parsed.doc.meshes[0].primitives[0].attributes.POSITION;
  assert.deepEqual(accessor(parsed, position), input.meshes[0].positions);
  assert.deepEqual(transform(rotation, [0, 0, 1]), [0, 1, 0]);
  assert.deepEqual(transform(rotation, transform(child, [1, 2, 3])), [6, 8, -2]);
  assert.deepEqual(transform(multiply(rotation, child), [1, 2, 3]), [6, 8, -2]);
  const jsonBytes = Buffer.byteLength(JSON.stringify(input)); assert.equal(result.stats.inputJsonBytes, jsonBytes);
  assert.equal(exportSketchfabViewer(input, { limits: { jsonBytes } }).stats.inputJsonBytes, jsonBytes);
  invalid(input, { limits: { jsonBytes: jsonBytes - 1 } }, 'SKETCHFAB_VIEWER_TOO_LARGE');
});

test('coordinate conversion is opt-in and rejects unrecognized coordinate systems', () => {
  const parsed = parseGlb(exportSketchfabViewer(snapshot([triangle(), triangle()])).glb);
  assert.deepEqual(parsed.doc.scenes[0].nodes, [0, 1]); assert.equal(parsed.doc.nodes.length, 2);
  for (const value of ['gltf-y-up', 'SKETCHFAB-Z-UP', '', null, 1, undefined]) invalid({ ...snapshot(), coordinateSystem: value });
});

test('uses uint32 at the uint16 primitive-restart boundary and preserves large indices', () => {
  const positions = Array(65536 * 3).fill(0);
  for (const [maximum, type] of [[65534, 5123], [65535, 5125]]) {
    const parsed = parseGlb(exportSketchfabViewer(snapshot([{ positions, indices: [0, 1, maximum] }])).glb);
    const index = parsed.doc.meshes[0].primitives[0].indices;
    assert.equal(parsed.doc.accessors[index].componentType, type); assert.deepEqual(accessor(parsed, index), [0, 1, maximum]);
  }
});

test('pads JSON with spaces and every binary section with zero bytes', () => {
  const parsed = parseGlb(exportSketchfabViewer(snapshot([{ ...triangle(), indices: [0, 1, 2] }], [image(png())])).glb);
  const used = new Set();
  for (const view of parsed.doc.bufferViews) for (let i = view.byteOffset; i < view.byteOffset + view.byteLength; i++) used.add(i);
  for (let i = 0; i < parsed.binary.length; i++) if (!used.has(i)) assert.equal(parsed.binary[i], 0);
  const text = parsed.jsonChunk.toString('utf8'); assert.match(text.slice(text.lastIndexOf('}') + 1), /^ *$/);
});

test('normalizes nonzero normals, supports unindexed triangles and returns bounded warnings separately', () => {
  const input = snapshot([{ ...triangle(), normals: [0, 0, 2, 0, 3, 0, 4, 0, 0] }, triangle()]); input.warnings = ['来源缺少部分材质', '来源缺少部分材质'];
  const result = exportSketchfabViewer(input), parsed = parseGlb(result.glb), first = parsed.doc.meshes[0].primitives[0];
  assert.deepEqual(accessor(parsed, first.attributes.NORMAL), [0, 0, 1, 0, 1, 0, 1, 0, 0]); assert.equal(first.indices, undefined);
  assert.equal(result.stats.triangleCount, 2); assert.deepEqual(result.warnings, ['来源缺少部分材质', '模型法线已归一化。']);
  assert.equal(JSON.stringify(parsed.doc).includes('来源缺少部分材质'), false);
});

test('rejects unknown fields, prototypes, accessors, sparse arrays and hostile exception messages', () => {
  invalid({ ...snapshot(), cookie: 'fixture-secret' });
  invalid(snapshot([{ ...triangle(), script: 'fixture-secret' }]));
  invalid(snapshot([], [{ ...image(), url: 'https://fixture-secret/' }]));
  invalid(Object.assign(Object.create({ inherited: true }), snapshot()));
  invalid({ ...snapshot(), meshes: [Object.assign(Object.create({ x: 1 }), triangle())] });
  const fromJson = JSON.parse(JSON.stringify(snapshot()).replace('"version":1', '"version":1,"__proto__":{"x":1}')); invalid(fromJson);
  let read = false; const getter = snapshot(); Object.defineProperty(getter, 'meshes', { enumerable: true, get() { read = true; throw new Error('fixture-secret'); } }); invalid(getter); assert.equal(read, false);
  const sparse = triangle(); delete sparse.positions[4]; invalid(snapshot([sparse]));
  const annotated = triangle(); annotated.positions.filename = 'fixture-secret'; invalid(snapshot([annotated]));
  invalid(new Proxy({}, { getPrototypeOf() { throw Object.assign(new Error('fixture-secret'), { code: 'SKETCHFAB_VIEWER_INVALID' }); } }));
});

test('rejects malformed identity, dimensions, numbers, indices, materials and node matrices', () => {
  for (const input of [null, [], { ...snapshot(), version: 2 }, { ...snapshot(), modelId: 'A'.repeat(32) }, snapshot([])]) invalid(input);
  for (const positions of [[0, 0, 0], [...triangle().positions, 1], [NaN, ...triangle().positions.slice(1)], [Infinity, ...triangle().positions.slice(1)], [1e39, ...triangle().positions.slice(1)]]) invalid(snapshot([{ positions }]));
  for (const patch of [
    { normals: [0, 0, 1] }, { normals: Array(9).fill(0) }, { texcoords: [0, 0] },
    { indices: [0, 1] }, { indices: [0, 1, 3] }, { indices: [0, -1, 2] }, { indices: [0, 1.2, 2] },
    { material: { baseColorFactor: [1, 1, 1] } }, { material: { baseColorFactor: [1, 1, 1, 2] } },
    { material: { doubleSided: 1 } }, { material: { baseColorTexture: 0 } },
    { matrix: [1, 0, 0] }, { matrix: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    { matrix: [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  ]) invalid(snapshot([{ ...triangle(), ...patch }]));
  invalid(snapshot([{ ...triangle(), material: { baseColorTexture: 0 } }], [image()]));
  invalid(snapshot([{ ...triangle(), texcoords: [0, 0, 1, 0, 0, 1], material: { baseColorTexture: 1 } }], [image()]));
  invalid(snapshot([{ positions: [...triangle().positions, 2, 2, 0] }]));
});

test('rejects malformed image bytes, MIME mismatches and noncanonical base64', () => {
  const corrupt = png(); corrupt[corrupt.length - 1] ^= 1;
  const nonAsciiType = png(); nonAsciiType[12] |= 128; nonAsciiType.writeUInt32BE(crc32(nonAsciiType.subarray(12, 29)), 29);
  for (const value of [image(corrupt), image(nonAsciiType), image(jpeg, 'image/png'), image(png(), 'image/jpeg'), image(Buffer.from('<svg/>')), { ...image(), mimeType: 'image/webp' },
    { ...image(), data: image().data + '\n' }, { ...image(), data: 'YR==' }, { ...image(), data: 'data:image/png;base64,AAAA' }]) invalid(snapshot([triangle()], [value]));
});

test('enforces exact JSON bytes and every resource cap before producing a GLB', () => {
  const input = snapshot(), jsonBytes = Buffer.byteLength(JSON.stringify(input));
  assert.equal(exportSketchfabViewer(input, { limits: { jsonBytes } }).stats.inputJsonBytes, jsonBytes);
  // A 16 MiB per-image policy is now a valid tightening of the shared 32 MiB ceiling.
  // Use the tiny fixture so this compatibility check does not allocate a large image.
  assert.equal(exportSketchfabViewer(snapshot([triangle()], [image()]), { limits: { imageBytes: 16 * 1024 * 1024 } }).stats.imageCount, 1);
  invalid(input, { limits: { jsonBytes: jsonBytes - 1 } }, 'SKETCHFAB_VIEWER_TOO_LARGE');
  invalid(input, { limits: { vertices: 2 } }, 'SKETCHFAB_VIEWER_TOO_LARGE');
  invalid(snapshot([triangle(), triangle()]), { limits: { meshes: 1 } }, 'SKETCHFAB_VIEWER_TOO_LARGE');
  invalid(snapshot([triangle(), triangle()]), { limits: { triangles: 1 } }, 'SKETCHFAB_VIEWER_TOO_LARGE');
  invalid(snapshot([triangle()], [image(), image()]), { limits: { images: 1 } }, 'SKETCHFAB_VIEWER_TOO_LARGE');
  invalid(snapshot([triangle()], [image()]), { limits: { imageBytes: 16 } }, 'SKETCHFAB_VIEWER_TOO_LARGE');
  invalid(snapshot([triangle()], [image(), image()]), { limits: { totalImageBytes: png().length } }, 'SKETCHFAB_VIEWER_TOO_LARGE');
  invalid(snapshot([triangle()], [image(), image()]), { limits: { totalImagePixels: 1 } }, 'SKETCHFAB_VIEWER_TOO_LARGE');
  invalid(input, { limits: { outputBytes: 32 } }, 'SKETCHFAB_VIEWER_TOO_LARGE');
  for (const limits of [{ jsonBytes: DEFAULT_LIMITS.jsonBytes + 1 }, { triangles: 0 }, { unknown: 1 }]) invalid(input, { limits });
});

test('bounds decoded dimensions and total declared image pixels for PNG and JPEG', () => {
  for (const value of [image(pngSize(8193, 1)), image(pngSize(1, 8193)), image(pngSize(4097, 8192)),
    image(jpegSize(8193, 1), 'image/jpeg'), image(jpegSize(4097, 8192), 'image/jpeg')]) {
    invalid(snapshot([triangle()], [value]), undefined, 'SKETCHFAB_VIEWER_TOO_LARGE');
  }
  assert.equal(exportSketchfabViewer(snapshot([triangle()], [image()]), { limits: { imageDimension: 1, totalImagePixels: 1 } }).stats.imageCount, 1);
  invalid(snapshot([triangle()], [image(pngSize(2, 1))]), { limits: { imageDimension: 1 } }, 'SKETCHFAB_VIEWER_TOO_LARGE');
});

test('accepts deeply frozen JSON data and never calls toJSON supplied by an input', () => {
  const input = snapshot(); Object.freeze(input.meshes[0].positions); Object.freeze(input.meshes[0]); Object.freeze(input.meshes); Object.freeze(input.images); Object.freeze(input);
  assert.equal(exportSketchfabViewer(input).stats.meshCount, 1);
  let called = false; invalid({ ...snapshot(), toJSON() { called = true; return snapshot(); } }); assert.equal(called, false);
});
