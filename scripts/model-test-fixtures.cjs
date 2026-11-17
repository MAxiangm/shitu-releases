'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const crypto = require('node:crypto');

async function createModelFixtures(directory) {
  await fs.mkdir(directory, { recursive: true });
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#39d58a' } }).png().toBuffer();
  const geometry = Buffer.alloc(104);
  Buffer.from(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]).buffer).copy(geometry);
  Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]).buffer).copy(geometry, 36);
  Buffer.from(new Float32Array([0, 0, 1, 0, 0.5, 1]).buffer).copy(geometry, 72);
  geometry.writeUInt16LE(0, 96); geometry.writeUInt16LE(1, 98); geometry.writeUInt16LE(2, 100);
  const document = {
    asset: { version: '2.0', generator: 'Shitu isolated regression fixture' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.7 } }],
    textures: [{ source: 0 }], images: [{ uri: 'textures/green.png' }],
    buffers: [{ uri: 'mesh.bin', byteLength: geometry.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 24 }, { buffer: 0, byteOffset: 96, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' }]
  };
  const gltfDirectory = path.join(directory, 'gltf');
  await fs.mkdir(path.join(gltfDirectory, 'textures'), { recursive: true });
  await fs.writeFile(path.join(gltfDirectory, 'triangle.gltf'), JSON.stringify(document));
  await fs.writeFile(path.join(gltfDirectory, 'mesh.bin'), geometry);
  await fs.writeFile(path.join(gltfDirectory, 'textures', 'green.png'), png);
  const embedded = structuredClone(document);
  const binary = Buffer.concat([geometry, png, Buffer.alloc((4 - png.length % 4) % 4)]);
  embedded.buffers = [{ byteLength: binary.length }];
  embedded.bufferViews.push({ buffer: 0, byteOffset: geometry.length, byteLength: png.length });
  embedded.images = [{ bufferView: 4, mimeType: 'image/png' }];
  const json = Buffer.from(JSON.stringify(embedded));
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const glb = Buffer.alloc(12 + 8 + paddedJson.length + 8 + binary.length);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(paddedJson.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); paddedJson.copy(glb, 20);
  glb.writeUInt32LE(binary.length, 20 + paddedJson.length); glb.writeUInt32LE(0x004e4942, 24 + paddedJson.length); binary.copy(glb, 28 + paddedJson.length);
  await fs.writeFile(path.join(directory, 'embedded.glb'), glb);
  const objDirectory = path.join(directory, 'obj');
  await fs.mkdir(path.join(objDirectory, 'textures'), { recursive: true });
  await fs.writeFile(path.join(objDirectory, 'triangle.obj'), 'mtllib triangle.mtl\nv -1 -1 0\nv 1 -1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt .5 1\nvn 0 0 1\nusemtl green\nf 1/1/1 2/2/1 3/3/1\n');
  await fs.writeFile(path.join(objDirectory, 'triangle.mtl'), 'newmtl green\nKd 1 1 1\nmap_Kd textures/green.png\n');
  await fs.writeFile(path.join(objDirectory, 'textures', 'green.png'), png);
  await fs.writeFile(path.join(directory, 'triangle.stl'), 'solid triangle\nfacet normal 0 0 1\nouter loop\nvertex -1 -1 0\nvertex 1 -1 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle\n');
  await fs.writeFile(path.join(directory, 'triangle.ply'), 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n-1 -1 0\n1 -1 0\n0 1 0\n3 0 1 2\n');
  const fixture = { formats: ['glb', 'gltf', 'obj', 'stl', 'ply'], count: 5 };
  const officialFbx = path.resolve(__dirname, '..', '.recovery', 'samples', 'models', 'monkey_embedded_texture.fbx');
  try {
    const bytes = await fs.readFile(officialFbx);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== '3294f519234496ef6db3f0ca4d8c43f2b6f54ca2083910d4b05b2a2f5d564973') throw new Error('FBX fixture hash mismatch');
    await fs.writeFile(path.join(directory, 'embedded.fbx'), bytes);
    fixture.formats.push('fbx'); fixture.count++;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return fixture;
}
module.exports = { createModelFixtures };
