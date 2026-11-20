(function (scope, factory) {
  'use strict';
  const api = factory(scope);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.MosaicSketchfabGeometryTransfer = api;
})(typeof globalThis === 'object' ? globalThis : this, function (scope) {
  'use strict';
  const MIN_COMPONENTS = 250000;
  const MAX_GEOMETRY_BYTES = 128 * 1024 * 1024;
  const FLOAT_MAX = 3.4028234663852886e38;
  const FIELDS = Object.freeze({ positions: ['float32', 3000000], normals: ['float32', 3000000],
    texcoords: ['float32', 2000000], colors: ['float32', 4000000], weights: ['float32', 4000000], indices: ['uint32', 6000000], joints: ['uint32', 4000000] });
  function fail(large = false) { throw Object.assign(new Error('Sketchfab geometry transfer failed'), { code: large ? 'SKETCHFAB_VIEWER_TOO_LARGE' : 'SKETCHFAB_VIEWER_INVALID' }); }
  function copyRecord(value) {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    const result = {}, properties = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(properties)) {
      const property = properties[key];
      if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')) fail();
      Object.defineProperty(result, key, { value: property.value, enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  function encode(values, componentType, compact) {
    const buffer = compact ? new ArrayBuffer(values.length * 4) : null, view = buffer && new DataView(buffer);
    for (let i = 0; i < values.length; i++) {
      const property = Object.getOwnPropertyDescriptor(values, String(i));
      if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) fail();
      const value = property.value;
      if (typeof value !== 'number' || !Number.isFinite(value)) fail();
      if (componentType === 'uint32') {
        if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) fail();
        if (view) view.setUint32(i * 4, value, true);
      } else {
        if (Math.abs(value) > FLOAT_MAX) fail();
        if (view) view.setFloat32(i * 4, value, true);
      }
    }
    if (!view) return values;
    if (typeof scope.btoa !== 'function') fail();
    const bytes = new Uint8Array(buffer), chunks = [];
    // Every nonterminal slice is divisible by three, so padding only appears
    // at the end; this avoids constructing a second full binary string.
    for (let i = 0; i < bytes.length; i += 32766) chunks.push(scope.btoa(String.fromCharCode(...bytes.subarray(i, i + 32766))));
    return { componentType, count: values.length, data: chunks.join('') };
  }
  function compactGeometry(snapshot, { minimumComponents = MIN_COMPONENTS } = {}) {
    if (!Number.isSafeInteger(minimumComponents) || minimumComponents < 0) fail();
    const output = copyRecord(snapshot);
    if (!Array.isArray(output.meshes) || Object.getPrototypeOf(output.meshes) !== Array.prototype) fail();
    if (output.meshes.length > 512) fail(true);
    if (Reflect.ownKeys(output.meshes).length !== output.meshes.length + 1) fail();
    let components = 0;
    output.meshes = Array.from({ length: output.meshes.length }, (_, i) => {
      const property = Object.getOwnPropertyDescriptor(output.meshes, String(i));
      if (!property || !Object.hasOwn(property, 'value') || !property.enumerable) fail();
      const copy = copyRecord(property.value);
      for (const [key, [, maximum]] of Object.entries(FIELDS)) if (Object.hasOwn(copy, key)) {
        const values = copy[key];
        // Idempotent for already compact data; the receiver validates its
        // canonical encoding, exact shape and values before using it.
        if (!Array.isArray(values)) continue;
        if (Object.getPrototypeOf(values) !== Array.prototype || !values.length) fail();
        if (values.length > maximum) fail(true);
        components += values.length;
        if (components * 4 > MAX_GEOMETRY_BYTES) fail(true);
      }
      return copy;
    });
    const compact = components >= minimumComponents;
    for (const mesh of output.meshes) for (const [key, [type]] of Object.entries(FIELDS)) {
      if (Object.hasOwn(mesh, key) && Array.isArray(mesh[key])) mesh[key] = encode(mesh[key], type, compact);
    }
    return output;
  }
  return { compactGeometry, MIN_COMPONENTS, MAX_GEOMETRY_BYTES };
});
