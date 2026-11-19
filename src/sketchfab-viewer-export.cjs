'use strict';

// A deliberately small GLB 2.0 writer. It accepts data, never viewer code or URLs.
const DEFAULT_LIMITS = Object.freeze({
  jsonBytes: 48 * 1024 * 1024,
  vertices: 1_000_000,
  triangles: 2_000_000,
  meshes: 512,
  images: 128,
  imageBytes: 32 * 1024 * 1024,
  totalImageBytes: 32 * 1024 * 1024,
  imageDimension: 8192,
  totalImagePixels: 32 * 1024 * 1024,
  outputBytes: 128 * 1024 * 1024,
});
const FLOAT_MAX = 3.4028234663852886e38;
const INTERNAL_ERRORS = new WeakSet();
const MODEL_ID = /^[a-f0-9]{32}$/;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function issue(large = false) {
  const error = Object.assign(new Error(large ? 'Sketchfab 预览模型超出安全导出限制。' : 'Sketchfab 预览模型数据无效。'), {
    code: large ? 'SKETCHFAB_VIEWER_TOO_LARGE' : 'SKETCHFAB_VIEWER_INVALID',
  });
  INTERNAL_ERRORS.add(error);
  return error;
}
function reject() { throw issue(); }
function bound(value, maximum) { if (value > maximum) throw issue(true); }
function record(value, fields, required = []) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject();
  const result = Object.create(null), descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !fields.includes(key))) reject();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject();
    result[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) reject();
  return result;
}
function makeLimits(options) {
  if (options === undefined) return { ...DEFAULT_LIMITS };
  const config = record(options, ['limits']);
  if (!Object.hasOwn(config, 'limits')) return { ...DEFAULT_LIMITS };
  const requested = record(config.limits, Object.keys(DEFAULT_LIMITS)), limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(requested)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) reject();
    limits[key] = value;
  }
  return limits;
}
class JsonBudget {
  constructor(limit) { this.limit = limit; this.bytes = 0; }
  add(bytes) { this.bytes += bytes; bound(this.bytes, this.limit); }
  string(value) { this.add(Buffer.byteLength(JSON.stringify(value))); }
  number(value) { this.add(String(Object.is(value, -0) ? 0 : value).length); }
  object(value) {
    const keys = Object.keys(value);
    this.add(2 + Math.max(0, keys.length - 1));
    for (const key of keys) { this.string(key); this.add(1); }
  }
}
function array(value, minimum, maximum, budget) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) reject();
  bound(value.length, maximum);
  if (value.length < minimum) reject();
  budget.add(2 + Math.max(0, value.length - 1));
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys[keys.length - 1] !== 'length') reject();
  for (let index = 0; index < value.length; index++) {
    if (keys[index] !== String(index)) reject();
    const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject();
  }
  return value;
}
function number(value, budget, asFloat = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (asFloat && Math.abs(value) > FLOAT_MAX)) reject();
  budget.number(value);
  return asFloat ? Math.fround(value) : value;
}
function text(value, budget, maximum = 240) {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) reject();
  budget.string(value);
  return value;
}
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
function pngInfo(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG)) reject();
  let offset = 8, sawHeader = false, sawData = false, hasAlpha = false, width, height;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) reject();
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) reject();
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12)) reject();
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      const depth = bytes[offset + 16], color = bytes[offset + 17];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || bytes[offset + 18] || bytes[offset + 19] || bytes[offset + 20] > 1) reject();
      hasAlpha = color === 4 || color === 6;
      sawHeader = true;
    } else if (type === 'IHDR') reject();
    if (type === 'tRNS') hasAlpha = true;
    if (type === 'IDAT') sawData = true;
    offset += length + 12;
    if (type === 'IEND') {
      if (length || !sawData || offset !== bytes.length) reject();
      return { hasAlpha, width, height };
    }
  }
  reject();
}
function jpegInfo(bytes) {
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) reject();
  let offset = 2, frame = false, scan = false, width, height;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) reject();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217) { if (!frame || !scan || offset !== bytes.length) reject(); return { hasAlpha: false, width, height }; }
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215)) reject();
    if (offset + 2 > bytes.length) reject();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) reject();
    if ([192, 193, 194].includes(marker)) {
      if (length < 8 || !bytes.readUInt16BE(offset + 3) || !bytes.readUInt16BE(offset + 5)) reject();
      if (frame) reject();
      height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5);
      frame = true;
    }
    offset += length;
    if (marker === 218) {
      if (!frame) reject();
      scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || (next >= 208 && next <= 215)) { offset += 2; continue; }
        break;
      }
    }
  }
  reject();
}
function image(input, limits, budget) {
  const value = record(input, ['name', 'mimeType', 'data'], ['mimeType', 'data']); budget.object(value);
  const name = Object.hasOwn(value, 'name') ? text(value.name, budget) : undefined;
  if (!['image/png', 'image/jpeg'].includes(value.mimeType)) reject();
  budget.string(value.mimeType);
  if (typeof value.data !== 'string') reject();
  bound(value.data.length, Math.ceil(limits.imageBytes / 3) * 4);
  if (!value.data.length || value.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) reject();
  budget.add(value.data.length + 2);
  const length = value.data.length / 4 * 3 - (value.data.endsWith('==') ? 2 : value.data.endsWith('=') ? 1 : 0);
  bound(length, limits.imageBytes);
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.length !== length || bytes.toString('base64') !== value.data) reject();
  const info = value.mimeType === 'image/png' ? pngInfo(bytes) : jpegInfo(bytes);
  bound(info.width, limits.imageDimension); bound(info.height, limits.imageDimension);
  return { name, mimeType: value.mimeType, bytes, ...info };
}
function matrix(input, budget) {
  const values = array(input, 16, 16, budget).map(value => number(value, budget));
  if (values[3] !== 0 || values[7] !== 0 || values[11] !== 0 || values[15] !== 1) reject();
  // glTF node matrices must decompose into translation, rotation and scale (no shear).
  const axes = [values.slice(0, 3), values.slice(4, 7), values.slice(8, 11)];
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
    const length = Math.hypot(...axes[a]) * Math.hypot(...axes[b]);
    if (length && Math.abs(axes[a].reduce((sum, v, i) => sum + v * axes[b][i], 0)) > length * 1e-5) reject();
  }
  return values;
}
function build(snapshot, options) {
  const limits = makeLimits(options), budget = new JsonBudget(limits.jsonBytes);
  const input = record(snapshot, ['version', 'modelId', 'meshes', 'images', 'warnings', 'coordinateSystem'], ['version', 'modelId', 'meshes', 'images']);
  budget.object(input);
  if (input.version !== 1 || typeof input.modelId !== 'string' || !MODEL_ID.test(input.modelId)) reject();
  budget.number(input.version); budget.string(input.modelId);
  if (Object.hasOwn(input, 'coordinateSystem')) {
    if (input.coordinateSystem !== 'sketchfab-z-up') reject();
    budget.string(input.coordinateSystem);
  }
  const warnings = Object.hasOwn(input, 'warnings') ? array(input.warnings, 0, 64, budget).map(value => text(value, budget, 500)) : [];
  let imageBytes = 0, imagePixels = 0;
  const images = array(input.images, 0, limits.images, budget).map(value => {
    const result = image(value, limits, budget);
    imageBytes += result.bytes.length; imagePixels += result.width * result.height;
    bound(imageBytes, limits.totalImageBytes); bound(imagePixels, limits.totalImagePixels);
    return result;
  });
  const doc = { asset: { version: '2.0', generator: 'Mosaic Sketchfab viewer export', extras: { modelId: input.modelId } },
    scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], materials: [], buffers: [{ byteLength: 0 }] };
  const binary = []; let binaryBytes = 0, vertexCount = 0, triangleCount = 0;
  function view(bytes, target) {
    const offset = binaryBytes, padding = (4 - bytes.length % 4) % 4;
    binaryBytes += bytes.length + padding; bound(binaryBytes + 28, limits.outputBytes);
    binary.push(bytes); if (padding) binary.push(Buffer.alloc(padding));
    const result = doc.bufferViews.length;
    doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) });
    return result;
  }
  function accessor(bytes, count, type, componentType, target, bounds) {
    const result = doc.accessors.length;
    doc.accessors.push({ bufferView: view(bytes, target), componentType, count, type, ...bounds });
    return result;
  }
  if (images.length) {
    doc.images = images.map(value => ({ bufferView: view(value.bytes), mimeType: value.mimeType, ...(value.name !== undefined ? { name: value.name } : {}) }));
    doc.textures = images.map((_, source) => ({ source }));
  }
  for (const source of array(input.meshes, 1, limits.meshes, budget)) {
    const mesh = record(source, ['name', 'positions', 'normals', 'texcoords', 'indices', 'matrix', 'material'], ['positions']); budget.object(mesh);
    const name = Object.hasOwn(mesh, 'name') ? text(mesh.name, budget) : undefined;
    const positions = array(mesh.positions, 9, limits.vertices * 3, budget);
    if (positions.length % 3) reject();
    const count = positions.length / 3; vertexCount += count; bound(vertexCount, limits.vertices);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], positionBytes = Buffer.alloc(positions.length * 4);
    for (let i = 0; i < positions.length; i++) {
      const value = number(positions[i], budget); positionBytes.writeFloatLE(value, i * 4);
      min[i % 3] = Math.min(min[i % 3], value); max[i % 3] = Math.max(max[i % 3], value);
    }
    const attributes = { POSITION: accessor(positionBytes, count, 'VEC3', 5126, 34962, { min, max }) };
    if (Object.hasOwn(mesh, 'normals')) {
      const normals = array(mesh.normals, positions.length, positions.length, budget), bytes = Buffer.alloc(normals.length * 4);
      let normalized = false;
      for (let i = 0; i < normals.length; i += 3) {
        const xyz = [number(normals[i], budget), number(normals[i + 1], budget), number(normals[i + 2], budget)], length = Math.hypot(...xyz);
        if (!length) reject();
        if (Math.abs(length - 1) > 1e-5) normalized = true;
        for (let c = 0; c < 3; c++) bytes.writeFloatLE(xyz[c] / length, (i + c) * 4);
      }
      if (normalized && !warnings.includes('模型法线已归一化。')) warnings.push('模型法线已归一化。');
      attributes.NORMAL = accessor(bytes, count, 'VEC3', 5126, 34962);
    }
    if (Object.hasOwn(mesh, 'texcoords')) {
      const uv = array(mesh.texcoords, count * 2, count * 2, budget), bytes = Buffer.alloc(uv.length * 4);
      for (let i = 0; i < uv.length; i++) bytes.writeFloatLE(number(uv[i], budget), i * 4);
      attributes.TEXCOORD_0 = accessor(bytes, count, 'VEC2', 5126, 34962);
    }
    let indexAccessor, triangles;
    if (Object.hasOwn(mesh, 'indices')) {
      const indices = array(mesh.indices, 3, limits.triangles * 3, budget);
      if (indices.length % 3) reject();
      triangles = indices.length / 3; bound(triangleCount + triangles, limits.triangles);
      let maximum = 0;
      for (const index of indices) { number(index, budget, false); if (!Number.isSafeInteger(index) || index < 0 || index >= count) reject(); maximum = Math.max(maximum, index); }
      // 0xffff is the primitive-restart sentinel and cannot occur in a uint16 index accessor.
      const small = maximum < 65535, bytes = Buffer.alloc(indices.length * (small ? 2 : 4));
      for (let i = 0; i < indices.length; i++) small ? bytes.writeUInt16LE(indices[i], i * 2) : bytes.writeUInt32LE(indices[i], i * 4);
      indexAccessor = accessor(bytes, indices.length, 'SCALAR', small ? 5123 : 5125, 34963);
    } else { if (count % 3) reject(); triangles = count / 3; }
    triangleCount += triangles; bound(triangleCount, limits.triangles);
    const material = Object.hasOwn(mesh, 'material') ? record(mesh.material, ['baseColorFactor', 'baseColorTexture', 'doubleSided']) : {};
    if (Object.hasOwn(mesh, 'material')) budget.object(material);
    const pbr = { metallicFactor: 0, roughnessFactor: 1 }, renderedMaterial = { pbrMetallicRoughness: pbr };
    if (Object.hasOwn(material, 'baseColorFactor')) {
      pbr.baseColorFactor = array(material.baseColorFactor, 4, 4, budget).map(value => { number(value, budget, false); if (value < 0 || value > 1) reject(); return value; });
      if (pbr.baseColorFactor[3] < 1) renderedMaterial.alphaMode = 'BLEND';
    }
    if (Object.hasOwn(material, 'baseColorTexture')) {
      const index = material.baseColorTexture; number(index, budget, false);
      if (!Number.isSafeInteger(index) || index < 0 || index >= images.length || attributes.TEXCOORD_0 === undefined) reject();
      pbr.baseColorTexture = { index }; if (images[index].hasAlpha) renderedMaterial.alphaMode = 'BLEND';
    }
    if (Object.hasOwn(material, 'doubleSided')) { if (typeof material.doubleSided !== 'boolean') reject(); budget.add(material.doubleSided ? 4 : 5); renderedMaterial.doubleSided = material.doubleSided; }
    const materialIndex = doc.materials.push(renderedMaterial) - 1;
    const primitive = { attributes, mode: 4, material: materialIndex, ...(indexAccessor !== undefined ? { indices: indexAccessor } : {}) };
    const meshIndex = doc.meshes.push({ primitives: [primitive], ...(name !== undefined ? { name } : {}) }) - 1;
    doc.scenes[0].nodes.push(doc.nodes.length);
    doc.nodes.push({ mesh: meshIndex, ...(name !== undefined ? { name } : {}), ...(Object.hasOwn(mesh, 'matrix') ? { matrix: matrix(mesh.matrix, budget) } : {}) });
  }
  if (input.coordinateSystem === 'sketchfab-z-up') {
    const children = doc.scenes[0].nodes;
    doc.scenes[0].nodes = [doc.nodes.length];
    doc.nodes.push({ matrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1], children });
  }
  doc.buffers[0].byteLength = binaryBytes;
  const json = Buffer.from(JSON.stringify(doc)), jsonLength = Math.ceil(json.length / 4) * 4, total = 12 + 8 + jsonLength + 8 + binaryBytes;
  bound(total, limits.outputBytes);
  const glb = Buffer.alloc(total);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(total, 8);
  glb.writeUInt32LE(jsonLength, 12); glb.writeUInt32LE(0x4e4f534a, 16); glb.fill(0x20, 20, 20 + jsonLength); json.copy(glb, 20);
  const binHeader = 20 + jsonLength; glb.writeUInt32LE(binaryBytes, binHeader); glb.writeUInt32LE(0x004e4942, binHeader + 4);
  let cursor = binHeader + 8; for (const bytes of binary) { bytes.copy(glb, cursor); cursor += bytes.length; }
  return { glb, stats: { meshCount: doc.meshes.length, vertexCount, triangleCount, imageCount: images.length, imageBytes, inputJsonBytes: budget.bytes, glbBytes: total }, warnings: [...new Set(warnings)] };
}
function exportSketchfabViewer(snapshot, options) {
  try { return build(snapshot, options); }
  catch (error) { if (INTERNAL_ERRORS.has(error)) throw error; throw issue(); }
}

module.exports = { exportSketchfabViewer, DEFAULT_LIMITS };
