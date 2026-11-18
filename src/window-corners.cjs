'use strict';

const skins = require('./skins.js');

function createWindowCorners(window) {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const rect = koffi.struct({ left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const point = koffi.struct({ x: 'int32_t', y: 'int32_t' });
  const getWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int', ['uintptr_t', koffi.out(koffi.pointer(rect))]);
  const getClientRect = user32.func('__stdcall', 'GetClientRect', 'int', ['uintptr_t', koffi.out(koffi.pointer(rect))]);
  const clientToScreen = user32.func('__stdcall', 'ClientToScreen', 'int', ['uintptr_t', koffi.inout(koffi.pointer(point))]);
  const getDpiForWindow = user32.func('__stdcall', 'GetDpiForWindow', 'uint', ['uintptr_t']);
  const setWindowRgn = user32.func('int __stdcall SetWindowRgn(uintptr_t hwnd, void *region, int redraw)');
  const extCreateRegion = gdi32.func('void * __stdcall ExtCreateRegion(void *transform, uint size, const void *data)');
  const deleteObject = gdi32.func('int __stdcall DeleteObject(void *object)');
  const bytes = window.getNativeWindowHandle();
  const handle = bytes.length === 8 ? bytes.readBigUInt64LE() : bytes.readUInt32LE();

  let skin = skins.get();
  let applied = '';
  let pending = false;

  function update() {
    pending = false;
    if (window.isDestroyed() || window.isMinimized()) return;
    if (!skin.windowCorners.length || window.isMaximized() || window.isFullScreen() || window.isSnapped()) {
      if (applied && setWindowRgn(handle, null, 1)) applied = '';
      return;
    }

    const frame = {};
    const client = {};
    const origin = { x: 0, y: 0 };
    if (!getWindowRect(handle, frame) || !getClientRect(handle, client) || !clientToScreen(handle, origin)) return;
    const width = frame.right - frame.left;
    const height = frame.bottom - frame.top;
    const left = origin.x - frame.left;
    const top = origin.y - frame.top;
    const right = left + client.right;
    const bottom = top + client.bottom;
    const dpi = getDpiForWindow(handle);
    if (!dpi || width <= 0 || height <= 0 || right <= left || bottom <= top) return;
    const key = [skin.id, width, height, left, top, right, bottom, dpi].join(':');
    if (key === applied) return;

    const radiusLimit = Math.floor(Math.min(client.right, client.bottom) / 2);
    const radii = skin.windowCorners.map(radius => Math.min(Math.round(radius * dpi / 96), radiusLimit));
    const shape = cornerRegion(width, height, { left, top, right, bottom }, radii);
    const region = extCreateRegion(null, shape.length, shape);
    if (!region) return;
    // After SetWindowRgn succeeds, Windows owns the region.
    if (setWindowRgn(handle, region, 1)) applied = key;
    else deleteObject(region);
  }

  function scheduleUpdate() {
    if (pending) return;
    pending = true;
    setImmediate(update);
  }

  for (const event of ['resize', 'move', 'show', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
    window.on(event, scheduleUpdate);
  }
  window.hookWindowMessage(0x02e0, scheduleUpdate); // WM_DPICHANGED

  return id => {
    skin = skins.get(id);
    update();
  };
}

function cornerInset(radius, row) {
  if (row >= radius) return 0;
  const rise = radius - row - 0.5;
  return Math.round(radius - Math.sqrt(radius * radius - rise * rise));
}

function cornerRegion(width, height, bounds, [topLeft, topRight, bottomRight, bottomLeft]) {
  const { left, top, right, bottom } = bounds;
  const topRows = Math.max(topLeft, topRight);
  const bottomRows = Math.max(bottomLeft, bottomRight);
  const rows = [];

  // Measure the arcs from the painted client area, while retaining the native
  // resize margins along the straight parts of the window edges.
  function addCorner(y1, y2, row, leftRadius, rightRadius) {
    const insetLeft = cornerInset(leftRadius, row);
    const insetRight = cornerInset(rightRadius, row);
    rows.push([insetLeft ? left + insetLeft : 0, y1,
      insetRight ? right - insetRight : width, y2]);
  }
  for (let row = 0; row < topRows; row++) {
    addCorner(row === 0 ? 0 : top + row, top + row + 1, row, topLeft, topRight);
  }
  const centerTop = topRows ? top + topRows : 0;
  const centerBottom = bottomRows ? bottom - bottomRows : height;
  if (centerBottom > centerTop) rows.push([0, centerTop, width, centerBottom]);
  for (let row = bottomRows - 1; row >= 0; row--) {
    addCorner(bottom - row - 1, row === 0 ? height : bottom - row, row, bottomLeft, bottomRight);
  }

  // RGNDATAHEADER followed by top-to-bottom RECTs in physical window coordinates.
  const headerBytes = 32;
  const rectBytes = 16;
  const data = Buffer.alloc(headerBytes + rows.length * rectBytes);
  data.writeUInt32LE(headerBytes, 0);
  data.writeUInt32LE(1, 4); // RDH_RECTANGLES
  data.writeUInt32LE(rows.length, 8);
  data.writeUInt32LE(rows.length * rectBytes, 12);
  data.writeInt32LE(width, 24);
  data.writeInt32LE(height, 28);
  rows.forEach((row, index) => {
    row.forEach((value, field) => data.writeInt32LE(value, headerBytes + index * rectBytes + field * 4));
  });
  return data;
}

module.exports = { createWindowCorners };
