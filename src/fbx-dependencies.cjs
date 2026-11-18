'use strict';

const fs = require('node:fs/promises');

const MAX_TEXT = 64 * 1024 * 1024;
const MAX_NODES = 250000;
const MAX_DEPTH = 256;
const referenceNames = new Set(['RelativeFilename', 'FileName', 'Filename']);
const pathKey = value => value.replace(/\\/g, '/').normalize('NFC');

function collector() {
  const media = [], loose = [], connections = [];
  let remaining = MAX_NODES;
  function node(name, properties, owner, parent) {
    if (--remaining < 0) throw new Error('FBX 节点过多');
    if (name === 'Video' || name === 'Texture') {
      owner = { type: name, id: String(properties[0]?.value ?? ''), name: properties[1]?.value,
        references: [], embedded: false, mediaName: '' };
      media.push(owner);
    } else if (referenceNames.has(name) && typeof properties[0]?.value === 'string' && properties[0].value) {
      const reference = { value: properties[0].value, relative: name === 'RelativeFilename' };
      if (owner) owner.references.push(reference); else loose.push(reference);
    } else if (name === 'Content' && owner) {
      owner.embedded ||= properties.some(property => property.content);
    } else if (name === 'Media' && owner && typeof properties[0]?.value === 'string') {
      owner.mediaName = properties[0].value;
    } else if (name === 'C' && parent === 'Connections' && properties[0]?.value === 'OO') {
      connections.push(properties.slice(1, 3).map(property => String(property.value)));
    }
    return owner;
  }
  function finish() {
    const videos = media.filter(item => item.type === 'Video'), textures = media.filter(item => item.type === 'Texture');
    const groups = videos.map(video => ({ ...video, references: [...video.references] }));
    const byId = new Map(), byName = new Map(), byPath = new Map(), byConnection = new Map();
    function add(map, key, video) {
      if (!key) return;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(video);
    }
    for (const video of videos) {
      add(byId, video.id, video); add(byName, video.name, video);
      for (const reference of video.references) add(byPath, pathKey(reference.value), video);
    }
    for (const [source, target] of connections) for (const video of byId.get(source) || []) add(byConnection, target, video);
    const groupFor = new Map(videos.map((video, index) => [video, groups[index]]));
    for (const texture of textures) {
      let linked = [...byConnection.get(texture.id) || []];
      if (!linked.length && texture.mediaName) linked = [...byName.get(texture.mediaName) || []];
      // Older exporters omit the connection but repeat the exact Video path.
      // A basename match is deliberately insufficient to identify the payload.
      if (!linked.length) linked = [...new Set(texture.references.flatMap(reference => [...byPath.get(pathKey(reference.value)) || []]))];
      if (linked.length === 1) {
        groupFor.get(linked[0]).references.push(...texture.references);
      } else groups.push(texture);
    }
    groups.push(...loose.map(reference => ({ references: [reference], embedded: false })));
    return groups.map(group => ({ embedded: group.embedded,
      references: [...new Set([...group.references].sort((a, b) => Number(b.relative) - Number(a.relative)).map(reference => reference.value))] }));
  }
  return { node, finish };
}

function* asciiTokens(text) {
  for (let position = 0; position < text.length;) {
    const character = text[position];
    if (/\s/.test(character)) { position++; continue; }
    if (character === ';') { const end = text.indexOf('\n', position); position = end < 0 ? text.length : end + 1; continue; }
    if ('{},:'.includes(character)) { position++; yield { symbol: character }; continue; }
    if (character === '"') {
      const start = ++position;
      let end = position;
      for (;;) {
        end = text.indexOf('"', end);
        if (end < 0) throw new Error('FBX 字符串未结束');
        let slashes = 0;
        for (let index = end - 1; index >= start && text[index] === '\\'; index--) slashes++;
        if (!(slashes % 2)) break;
        end++;
      }
      const raw = text.slice(start, end);
      yield { value: raw.length <= 65536 ? raw.replace(/\\(["\\])/g, '$1') : undefined, content: /\S/.test(raw), quoted: true };
      position = end + 1; continue;
    }
    const start = position;
    while (position < text.length && !/[\s{},:;"]/.test(text[position])) position++;
    if (position === start) throw new Error('FBX 文本格式无效');
    yield { value: text.slice(start, position) };
  }
}
function asciiDependencies(text) {
  const collect = collector(), frames = [{ owner: null, name: '' }], iterator = asciiTokens(text);
  let current = iterator.next(), next = iterator.next(), statement;
  function finish() {
    if (!statement) return frames.at(-1).owner;
    const owner = collect.node(statement.name, statement.properties, frames.at(-1).owner, frames.at(-1).name);
    statement = null; return owner;
  }
  while (!current.done) {
    const token = current.value;
    if (!token.quoted && token.value !== undefined && next.value?.symbol === ':') {
      finish(); statement = { name: token.value, properties: [] };
      current = iterator.next(); next = iterator.next(); continue;
    }
    if (token.symbol === '{') {
      const name = statement?.name || '', owner = finish();
      if (frames.length > MAX_DEPTH) throw new Error('FBX 节点层级过深');
      frames.push({ owner, name });
    } else if (token.symbol === '}') {
      finish(); if (frames.length === 1) throw new Error('FBX 节点括号无效'); frames.pop();
    } else if (token.symbol !== ',' && statement && statement.properties.length < 16) statement.properties.push(token);
    current = next; next = iterator.next();
  }
  finish(); if (frames.length !== 1) throw new Error('FBX 节点未结束');
  return collect.finish();
}

async function readExact(handle, position, size) {
  const buffer = Buffer.alloc(size);
  if ((await handle.read(buffer, 0, size, position)).bytesRead !== size) throw new Error('FBX 数据不完整');
  return buffer;
}
async function binaryProperties(handle, start, length, count) {
  if (count > 64) throw new Error('FBX 元数据属性过多');
  const properties = [], end = start + length;
  let position = start;
  for (let index = 0; index < count; index++) {
    if (position >= end) throw new Error('FBX 属性长度无效');
    const type = (await readExact(handle, position++, 1)).toString('ascii');
    let value, content = false;
    const scalarSize = { Y: 2, C: 1, B: 1, I: 4, F: 4, D: 8, L: 8 }[type];
    if (scalarSize) {
      if (position + scalarSize > end) throw new Error('FBX 属性长度无效');
      const bytes = await readExact(handle, position, scalarSize); position += scalarSize;
      value = type === 'L' ? bytes.readBigInt64LE().toString() : type === 'I' ? String(bytes.readInt32LE()) : undefined;
    } else if (type === 'S' || type === 'R') {
      if (position + 4 > end) throw new Error('FBX 属性长度无效');
      const size = (await readExact(handle, position, 4)).readUInt32LE(); position += 4;
      if (position + size > end) throw new Error('FBX 属性长度无效');
      if (type === 'S') {
        if (size > 65536) throw new Error('FBX 元数据字符串过长');
        value = (await readExact(handle, position, size)).toString('utf8');
      } else content = size > 0;
      position += size;
    } else throw new Error('FBX 元数据属性类型无效');
    properties.push({ value, content });
  }
  if (position !== end) throw new Error('FBX 属性长度无效');
  return properties;
}
async function readFbxDependencies(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const header = Buffer.alloc(27), read = await handle.read(header, 0, header.length, 0);
    const length = (await handle.stat()).size;
    if (read.bytesRead < 23 || !header.subarray(0, 23).equals(Buffer.from('Kaydara FBX Binary  \0\x1a\0', 'binary'))) {
      if (length > MAX_TEXT) throw new Error('模型依赖描述文件过大');
      return asciiDependencies(await fs.readFile(filename, 'utf8'));
    }
    if (read.bytesRead < 27) throw new Error('FBX 文件头不完整');
    const wide = header.readUInt32LE(23) >= 7500, nodeLength = wide ? 25 : 13;
    const uint = (buffer, offset) => wide ? Number(buffer.readBigUInt64LE(offset)) : buffer.readUInt32LE(offset);
    const collect = collector(), stack = [{ position: 27, end: length, owner: null, name: '' }];
    let remaining = MAX_NODES;
    while (stack.length) {
      if (--remaining < 0) throw new Error('FBX 节点过多');
      const frame = stack.at(-1);
      if (frame.position + nodeLength > frame.end) { stack.pop(); continue; }
      const node = await readExact(handle, frame.position, nodeLength), end = uint(node, 0);
      if (!end) { stack.pop(); continue; }
      const count = uint(node, wide ? 8 : 4), propertyLength = uint(node, wide ? 16 : 8), nameLength = node[nodeLength - 1];
      const content = frame.position + nodeLength + nameLength, children = content + propertyLength;
      if (![end, count, children].every(Number.isSafeInteger) || end <= frame.position || end > frame.end || content > end || children > end) throw new Error('FBX 节点长度无效');
      const name = (await readExact(handle, frame.position + nodeLength, nameLength)).toString('utf8');
      const needed = referenceNames.has(name) || ['Video', 'Texture', 'Content', 'Media', 'C'].includes(name);
      const properties = needed ? await binaryProperties(handle, content, propertyLength, count) : [];
      const owner = collect.node(name, properties, frame.owner, frame.name);
      frame.position = end;
      if (children + nodeLength <= end) {
        if (stack.length > MAX_DEPTH) throw new Error('FBX 节点层级过深');
        stack.push({ position: children, end, owner, name });
      }
    }
    return collect.finish();
  } finally { await handle.close(); }
}

module.exports = { readFbxDependencies };
