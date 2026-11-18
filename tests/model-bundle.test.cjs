'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { collectModelBundle, copyModelBundle, validateModelBundle, modelBundleHash, isSafeBundlePath } = require('../src/model-bundle.cjs');

const testsRoot = path.resolve(__dirname, '..', '.recovery', 'tests');
async function fixture(t) {
  await fs.mkdir(testsRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testsRoot, 'model-bundle-'));
  t.after(async () => {
    const relative = path.relative(testsRoot, directory);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function write(root, name, data) { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return file; }
function glb(json) {
  const text = Buffer.from(JSON.stringify(json));
  const length = Math.ceil(text.length / 4) * 4, bytes = Buffer.alloc(20 + length, 0x20);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); text.copy(bytes, 20);
  return bytes;
}
function binaryFbx(nodes, version = 7400) {
  const wide = version >= 7500, headerSize = wide ? 25 : 13;
  const uint = (bytes, value, offset) => wide ? bytes.writeBigUInt64LE(BigInt(value), offset) : bytes.writeUInt32LE(value, offset);
  function property(value) {
    if (typeof value === 'bigint') { const bytes = Buffer.alloc(9); bytes[0] = 76; bytes.writeBigInt64LE(value, 1); return bytes; }
    const raw = Buffer.isBuffer(value), bytes = raw ? value : Buffer.from(value), header = Buffer.alloc(5);
    header[0] = raw ? 82 : 83; header.writeUInt32LE(bytes.length, 1); return Buffer.concat([header, bytes]);
  }
  function node(spec, offset) {
    const name = Buffer.from(spec.name), properties = Buffer.concat((spec.properties || []).map(property));
    const head = Buffer.alloc(headerSize); head[headerSize - 1] = name.length;
    uint(head, (spec.properties || []).length, wide ? 8 : 4); uint(head, properties.length, wide ? 16 : 8);
    const parts = [head, name, properties]; let cursor = offset + headerSize + name.length + properties.length;
    for (const child of spec.children || []) { const bytes = node(child, cursor); parts.push(bytes); cursor += bytes.length; }
    if (spec.children?.length) { parts.push(Buffer.alloc(headerSize)); cursor += headerSize; }
    uint(head, cursor, 0); return Buffer.concat(parts);
  }
  const header = Buffer.alloc(27); header.write('Kaydara FBX Binary  \0\x1a\0', 'binary'); header.writeUInt32LE(version, 23);
  const parts = [header]; let cursor = 27;
  for (const spec of nodes) { const bytes = node(spec, cursor); parts.push(bytes); cursor += bytes.length; }
  parts.push(Buffer.alloc(headerSize)); return Buffer.concat(parts);
}
function binaryMedia({ external = false, empty = false, connection = true } = {}) {
  const leaf = (name, ...properties) => ({ name, properties });
  const objects = [
    { name: 'Texture', properties: [9007199254740993n, 'Paint\0\x01Texture', ''], children: [leaf('Media', 'Paint\0\x01Video'), leaf('RelativeFilename', 'asset.fbm/paint.png')] },
    { name: 'Video', properties: [9007199254740995n, 'Paint\0\x01Video', 'Clip'], children: [leaf('Filename', 'Z:\\old\\paint.png'), leaf('RelativeFilename', 'asset.fbm/paint.png'), leaf('Content', Buffer.from(empty ? [] : [1, 2, 3]))] }
  ];
  if (external) objects.push({ name: 'Video', properties: [3n, 'Normal\0\x01Video', 'Clip'], children: [leaf('RelativeFilename', 'other/normal.png')] },
    { name: 'Texture', properties: [4n, 'Normal\0\x01Texture', ''], children: [leaf('Media', 'Normal\0\x01Video'), leaf('RelativeFilename', 'other/normal.png')] });
  return [{ name: 'Objects', children: objects }, { name: 'Connections', children: connection ? [leaf('C', 'OO', 9007199254740995n, 9007199254740993n), ...(external ? [leaf('C', 'OO', 3n, 4n)] : [])] : [] }];
}
test('OBJ material and spaced texture references form an independent package without changing sources', async t => {
  const root = await fixture(t), source = path.join(root, 'source');
  const obj = await write(source, 'model.obj', 'mtllib surface materials.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  await write(source, 'surface materials.mtl', 'newmtl surface\nmap_Kd -s 1 1 1 -o 0 0 0 "textures/my color.png"\n');
  await write(source, 'textures/my color.png', Buffer.from([1, 2, 3, 4]));
  const before = await fs.readFile(obj);
  const plan = await collectModelBundle(obj);
  assert.deepEqual(plan.files.map(file => file.relative).sort(), ['model.obj', 'surface materials.mtl', 'textures/my color.png'].sort());
  assert.deepEqual(plan.missing, []);
  const destination = path.join(root, 'managed');
  const metadata = await copyModelBundle(plan, destination);
  assert.equal(validateModelBundle(metadata), metadata);
  assert.equal(metadata.hash, modelBundleHash(metadata.files, metadata.entry));
  assert.deepEqual(await fs.readFile(obj), before);
  await fs.rm(source, { recursive: true, force: true });
  assert.deepEqual(await fs.readFile(path.join(destination, metadata.entry)), before);
  assert.deepEqual(await fs.readFile(path.join(destination, 'textures/my color.png')), Buffer.from([1, 2, 3, 4]));
  await assert.rejects(copyModelBundle(plan, destination), { code: 'EEXIST' });
});
test('glTF preserves buffers and encoded texture paths, and texture changes alter package identity', async t => {
  const root = await fixture(t);
  const source = await write(root, 'asset.gltf', JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'mesh.bin', byteLength: 12 }], images: [{ uri: 'maps/base%20color.png' }, { uri: 'data:image/png;base64,AA==' }] }));
  await write(root, 'mesh.bin', Buffer.alloc(12)); await write(root, 'maps/base color.png', 'first');
  const first = await collectModelBundle(source);
  assert.equal(first.files.length, 3); assert.deepEqual(first.missing, []);
  await write(root, 'maps/base color.png', 'second');
  const second = await collectModelBundle(source);
  assert.notEqual(first.hash, second.hash);
  await assert.rejects(copyModelBundle(first, path.join(root, 'changed-during-import')), /发生变化/);
  assert.equal(await fs.stat(path.join(root, 'changed-during-import')).then(() => true, () => false), false);
});
test('GLB external resources are collected alongside its binary container', async t => {
  const root = await fixture(t), source = await write(root, 'asset.glb', glb({ asset: { version: '2.0' }, images: [{ uri: 'tex.png' }] }));
  await write(root, 'tex.png', 'image');
  const plan = await collectModelBundle(source);
  assert.equal(plan.files.length, 2); assert.deepEqual(plan.missing, []);
});
test('parent-relative resources require an explicitly imported enclosing directory', async t => {
  const root = await fixture(t), source = await write(root, 'models/model.gltf', JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: '../textures/color.png' }] }));
  await write(root, 'textures/color.png', 'texture');
  const restricted = await collectModelBundle(source);
  assert.deepEqual(restricted.missing, ['../textures/color.png']);
  const allowed = await collectModelBundle(source, { allowedRoots: [root] });
  assert.equal(allowed.entry, 'models/model.gltf'); assert.deepEqual(allowed.missing, []);
  assert.ok(allowed.files.some(file => file.relative === 'textures/color.png'));
});
test('remote and absolute model references are not read or fetched', async t => {
  const root = await fixture(t);
  const source = await write(root, 'asset.gltf', JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'https://example.invalid/a.png' }, { uri: 'file:///C:/private.png' }, { uri: 'C:\\private.png' }] }));
  const plan = await collectModelBundle(source);
  assert.equal(plan.files.length, 1); assert.equal(plan.missing.length, 3); assert.equal(plan.warnings.length, 3);
});
test('a texture directory junction cannot escape the explicitly imported folder', async t => {
  const root = await fixture(t), sourceRoot = path.join(root, 'source'), outside = path.join(root, 'outside');
  const source = await write(sourceRoot, 'asset.gltf', JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'textures/private.png' }] }));
  await write(outside, 'private.png', 'outside-private-file');
  await fs.symlink(outside, path.join(sourceRoot, 'textures'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await collectModelBundle(source);
  assert.equal(plan.files.length, 1); assert.deepEqual(plan.missing, ['textures/private.png']);
  assert.ok(plan.warnings.some(value => value.includes('符号链接')));
});
test('FBX ASCII references find nearby textures when author paths are obsolete', async t => {
  const root = await fixture(t);
  const source = await write(root, 'asset.fbx', '; FBX 7.4.0\nRelativeFilename: "textures/base.png"\nFileName: "Z:\\old-computer\\base.png"\n');
  await write(root, 'textures/base.png', 'color');
  const plan = await collectModelBundle(source);
  assert.equal(plan.files.length, 2); assert.deepEqual(plan.missing, []); assert.ok(plan.warnings.some(value => value.includes('附近')));
});
test('FBX binary node strings collect linked textures while embedded media stays in the original', async t => {
  const root = await fixture(t);
  const header = Buffer.alloc(27); header.write('Kaydara FBX Binary  \0\x1a\0', 'binary'); header.writeUInt32LE(7400, 23);
  const node = (offset, name, type, value) => {
    const nameBytes = Buffer.from(name), bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), output = Buffer.alloc(13 + nameBytes.length + 5 + bytes.length);
    output.writeUInt32LE(offset + output.length, 0); output.writeUInt32LE(1, 4); output.writeUInt32LE(bytes.length + 5, 8); output[12] = nameBytes.length;
    nameBytes.copy(output, 13); output[13 + nameBytes.length] = type.charCodeAt(0); output.writeUInt32LE(bytes.length, 14 + nameBytes.length); bytes.copy(output, 18 + nameBytes.length); return output;
  };
  const texture = node(27, 'RelativeFilename', 'S', 'tex/color.png');
  const content = node(27 + texture.length, 'Content', 'R', Buffer.from([1, 2, 3]));
  const source = await write(root, 'asset.fbx', Buffer.concat([header, texture, content, Buffer.alloc(13)]));
  await write(root, 'tex/color.png', 'image');
  const plan = await collectModelBundle(source);
  assert.equal(plan.files.length, 2); assert.deepEqual(plan.missing, []);
});
test('ASCII FBX embedded media satisfies its Texture aliases without hiding another missing texture', async t => {
  const root = await fixture(t);
  const source = await write(root, 'asset.fbx', `; FBX 7.4.0
Objects: {
  Texture: 9007199254740993, "Texture::Paint", "" { Media: "Video::Paint" RelativeFilename: "asset.fbm/paint.png" }
  Video: 9007199254740995, "Video::Paint", "Clip" {
    Filename: "Z:\\old\\paint.png"
    RelativeFilename: "asset.fbm/paint.png"
    Content: ,
      "YWJj"
  }
}
Connections: { C: "OO", 9007199254740995, 9007199254740993 }
`);
  let plan = await collectModelBundle(source);
  assert.deepEqual(plan.missing, []); assert.deepEqual(plan.warnings, []); assert.equal(plan.files.length, 1);
  await fs.appendFile(source, `
Objects: {
  Video: 3, "Video::Normal", "Clip" { RelativeFilename: "other/normal.png" }
  Texture: 4, "Texture::Normal", "" { Media: "Video::Normal" RelativeFilename: "other/normal.png" }
}
Connections: { C: "OO", 3, 4 }
`);
  plan = await collectModelBundle(source);
  assert.deepEqual(plan.missing, ['other/normal.png']);
  assert.deepEqual(plan.warnings, []);
});
test('ASCII FBX empty Content and unassociated same-name paths are still missing', async t => {
  const root = await fixture(t), source = await write(root, 'asset.fbx', `
Objects: {
  Video: 1, "Video::embedded", "Clip" { RelativeFilename: "inside/paint.png" Content: , "YWJj" }
  Video: 2, "Video::empty", "Clip" { RelativeFilename: "empty.png" Content: , "" }
  Texture: 3, "Texture::external", "" { RelativeFilename: "outside/paint.png" }
}
`);
  const plan = await collectModelBundle(source);
  assert.deepEqual(plan.missing, ['empty.png', 'outside/paint.png']);
});
for (const version of [7400, 7500]) {
  test(`binary FBX ${version} embedded Video connections and Media names resolve repeated Texture references`, async t => {
    const root = await fixture(t), source = await write(root, 'asset.fbx', binaryFbx(binaryMedia(), version));
    for (const connection of [true, false]) {
      await fs.writeFile(source, binaryFbx(binaryMedia({ connection }), version));
      const plan = await collectModelBundle(source);
      assert.deepEqual(plan.missing, []); assert.deepEqual(plan.warnings, []); assert.equal(plan.files.length, 1);
    }
  });
  test(`binary FBX ${version} mixed and empty embedded media report only real missing dependencies`, async t => {
    const root = await fixture(t), source = await write(root, 'asset.fbx', binaryFbx(binaryMedia({ external: true }), version));
    let plan = await collectModelBundle(source);
    assert.deepEqual(plan.missing, ['other/normal.png']); assert.deepEqual(plan.warnings, []);
    await fs.writeFile(source, binaryFbx(binaryMedia({ empty: true }), version));
    plan = await collectModelBundle(source);
    assert.deepEqual(plan.missing, ['asset.fbm/paint.png']);
    await write(root, 'tex/paint.png', 'external image');
    plan = await collectModelBundle(source);
    assert.deepEqual(plan.missing, []); assert.equal(plan.files.length, 2);
    assert.ok(plan.warnings.some(message => message.includes('附近')));
  });
}
test('malformed binary FBX embedded Content cannot suppress dependency diagnostics', async t => {
  const root = await fixture(t), bytes = binaryFbx(binaryMedia());
  const content = bytes.indexOf(Buffer.from('Content')) + 'Content'.length;
  bytes.writeUInt32LE(1024, content + 1);
  const source = await write(root, 'asset.fbx', bytes), plan = await collectModelBundle(source);
  assert.ok(plan.warnings.some(message => message.includes('FBX 贴图引用未能完整读取')));
});
test('native model projects keep nearby resources and a same-name preview sidecar', async t => {
  const root = await fixture(t), source = await write(root, 'object.c4d', 'native-project');
  await write(root, 'tex/image.png', 'image'); await write(root, 'object.glb', glb({ asset: { version: '2.0' } }));
  const plan = await collectModelBundle(source);
  assert.equal(plan.entry, 'object.c4d'); assert.equal(plan.previewEntry, 'object.glb'); assert.equal(plan.files.length, 3);
  assert.ok(plan.warnings.some(value => value.includes('私有依赖')));
  const metadata = await copyModelBundle(plan, path.join(root, 'managed')); assert.equal(metadata.previewEntry, 'object.glb');
});
test('native projects bundle loose neighboring textures and common DCC resource folders', async t => {
  const root = await fixture(t), source = await write(root, 'object.blend', 'native-project');
  const textures = ['basecolor.png', 'roughness.jpg', 'images/normal.tga', 'materials/paint/diffuse.exr', 'sourceimages/color.tif'];
  for (const filename of textures) await write(root, filename, filename);
  await write(root, 'private-document.txt', 'not-a-model-resource');
  const plan = await collectModelBundle(source);
  assert.deepEqual(plan.files.map(file => file.relative).sort(), ['object.blend', ...textures].sort());
  const metadata = await copyModelBundle(plan, path.join(root, 'managed'));
  assert.equal(metadata.files.length, textures.length + 1);
  assert.ok(metadata.warnings.some(message => message.includes('私有依赖')));
});
test('model bundle metadata rejects traversal, case collisions and inconsistent hashes', async t => {
  const root = await fixture(t), source = await write(root, 'object.stl', 'solid test\nendsolid');
  const metadata = await copyModelBundle(await collectModelBundle(source), path.join(root, 'managed'));
  for (const name of ['../a', '/a', 'a\\b', 'C:/a', 'a/./b', 'a/../b', 'a/NUL.txt']) assert.equal(isSafeBundlePath(name), false);
  assert.throws(() => validateModelBundle({ ...metadata, entry: '../bad.stl' }));
  assert.throws(() => validateModelBundle({ ...metadata, files: [...metadata.files, { ...metadata.files[0], path: 'OBJECT.STL' }] }));
  assert.throws(() => validateModelBundle({ ...metadata, hash: '0'.repeat(64) }));
  assert.throws(() => validateModelBundle({ ...metadata, size: metadata.size + 1 }));
});
