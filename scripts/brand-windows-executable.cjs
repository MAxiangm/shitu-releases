'use strict';

const fs = require('node:fs/promises');

const LANGUAGE_EN_US = 0x0409;
const ICON = 3;
const ICON_GROUP = 14;
const VERSION = 16;

function iconResources(ico) {
  const headerSize = 6, entrySize = 16, groupEntrySize = 14;
  if (ico.length < headerSize || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error('Application icon must be a Windows ICO file.');
  }
  const count = ico.readUInt16LE(4);
  const imageStart = headerSize + count * entrySize;
  if (count < 1 || count > 32 || imageStart > ico.length) throw new Error('Invalid application icon directory.');
  const group = Buffer.alloc(headerSize + count * groupEntrySize);
  ico.copy(group, 0, 0, headerSize);
  const resources = [];
  for (let i = 0; i < count; i++) {
    const entry = headerSize + i * entrySize, groupEntry = headerSize + i * groupEntrySize;
    const size = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    if (!size || offset < imageStart || offset + size > ico.length) throw new Error('Invalid frame in application icon.');
    const id = i + 1;
    ico.copy(group, groupEntry, entry, entry + 12);
    // PE icon groups refer to image resource IDs instead of file offsets.
    group.writeUInt16LE(id, groupEntry + 12);
    resources.push({ type: ICON, id, data: ico.subarray(offset, offset + size) });
  }
  return [...resources, { type: ICON_GROUP, id: 1, data: group }];
}

const align = buffer => Buffer.concat([buffer, Buffer.alloc((4 - buffer.length % 4) % 4)]);

function versionBlock(key, { type = 0, value = Buffer.alloc(0), children = [] } = {}) {
  const header = align(Buffer.concat([Buffer.alloc(6), Buffer.from(key + '\0', 'utf16le')]));
  const body = children.length ? [align(value), ...children.map((child, index) =>
    index + 1 < children.length ? align(child) : child)] : [value];
  const block = Buffer.concat([header, ...body]);
  block.writeUInt16LE(block.length, 0);
  block.writeUInt16LE(value.length / (type === 1 ? 2 : 1), 2);
  block.writeUInt16LE(type, 4);
  return block;
}

function versionResource({ productName, version, executableName }) {
  const parts = version.split(/[-+]/)[0].split('.').map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 65535)) {
    throw new Error('Invalid application version for the Windows executable.');
  }
  const [major, minor, patch] = parts;
  const versionHigh = (major * 65536) + minor, versionLow = patch * 65536;
  const fixed = Buffer.alloc(52);
  [
    0xfeef04bd, 0x10000, versionHigh, versionLow, versionHigh, versionLow,
    0x3f, 0, 0x40004, 1, 0, 0, 0
  ].forEach((value, index) => fixed.writeUInt32LE(value, index * 4));
  const labels = {
    FileDescription: productName, FileVersion: version, InternalName: productName,
    OriginalFilename: executableName, ProductName: productName, ProductVersion: version
  };
  const strings = Object.entries(labels).map(([key, value]) =>
    versionBlock(key, { type: 1, value: Buffer.from(value + '\0', 'utf16le') }));
  const translations = Buffer.alloc(4);
  translations.writeUInt16LE(LANGUAGE_EN_US, 0);
  translations.writeUInt16LE(1200, 2);
  return versionBlock('VS_VERSION_INFO', { value: fixed, children: [
    versionBlock('StringFileInfo', { type: 1, children: [versionBlock('040904B0', { type: 1, children: strings })] }),
    versionBlock('VarFileInfo', { type: 1, children: [versionBlock('Translation', { value: translations })] })
  ] });
}

async function brandWindowsExecutable(executablePath, iconPath, branding) {
  if (process.platform !== 'win32') throw new Error('Windows is required to brand the recovered executable.');
  const icon = await fs.readFile(iconPath);
  const resources = [...iconResources(icon), { type: VERSION, id: 1, data: versionResource(branding) }];
  const kernel = require('koffi').load('kernel32.dll');
  const begin = kernel.func('__stdcall', 'BeginUpdateResourceW', 'uintptr_t', ['str16', 'int']);
  const update = kernel.func('__stdcall', 'UpdateResourceW', 'int', ['uintptr_t', 'uintptr_t', 'uintptr_t', 'uint16_t', 'void *', 'uint32_t']);
  const end = kernel.func('__stdcall', 'EndUpdateResourceW', 'int', ['uintptr_t', 'int']);
  const handle = begin(executablePath, 0);
  if (!handle) throw new Error('Could not open the packaged executable resources.');
  try {
    // The pinned recovered Electron runtime stores its main icon and version
    // as resources #1 in English. Replace them without touching its manifest.
    for (const { type, id, data } of resources) {
      if (!update(handle, type, id, LANGUAGE_EN_US, data, data.length)) {
        throw new Error(`Could not update Windows resource ${type}/${id}.`);
      }
    }
  } catch (error) {
    end(handle, 1);
    throw error;
  }
  if (!end(handle, 0)) throw new Error('Could not save the packaged executable resources.');
}

module.exports = { brandWindowsExecutable };
