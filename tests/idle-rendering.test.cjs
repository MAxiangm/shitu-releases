'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function scheduler() {
  let sequence = 0;
  const frames = new Map();
  return { frames, request: callback => { const id = ++sequence; frames.set(id, callback); return id; }, cancel: id => frames.delete(id),
    tick(time) { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(time); } };
}
function context2d() {
  const gradient = { addColorStop() {} };
  return { draws: 0, transforms: 0, lost: false, isContextLost() { return this.lost; },
    setTransform() { this.transforms++; }, clearRect() { this.draws++; }, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, drawImage() {}, save() {}, restore() {}, createRadialGradient: () => gradient };
}
function particles({ width = 1920, height = 1080, dpr = 1.5, motion = true } = {}) {
  const schedule = scheduler(), win = new EventTarget(), doc = new EventTarget(), canvas = new EventTarget(), button = new EventTarget();
  let drawing = context2d();
  Object.assign(canvas, { width: 0, height: 0, dataset: {}, getContext: () => drawing });
  Object.assign(button, { setAttribute() {} });
  doc.hidden = false;
  doc.getElementById = id => ({ ambientParticles: canvas, backgroundMotionButton: button, backgroundMotionLabel: {} })[id];
  doc.createElement = () => ({ width: 0, height: 0, getContext: () => context2d() });
  let nativeVisibility;
  win.shitu = { onWindowVisibility: callback => { nativeVisibility = callback; } };
  const sandbox = { window: win, document: doc, localStorage: { getItem: () => motion ? 'on' : 'off', setItem() {} },
    innerWidth: width, innerHeight: height, devicePixelRatio: dpr, performance: { now: () => 0 },
    requestAnimationFrame: schedule.request, cancelAnimationFrame: schedule.cancel,
    addEventListener: win.addEventListener.bind(win) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/particle-background.js'), 'utf8'), sandbox);
  return { canvas, doc, win, schedule, sandbox, nativeVisibility: value => nativeVisibility(value), context: () => drawing, replaceContext() { drawing = context2d(); return drawing; } };
}

test('decorative canvas bounds its backing surface on large HiDPI displays', () => {
  const f = particles({ width: 7680, height: 4320, dpr: 2 });
  assert.ok(f.canvas.width * f.canvas.height <= 4_000_000);
  assert.ok(f.canvas.width > 0 && f.canvas.height > 0);
  assert.equal(f.canvas.dataset.particleCount, '3200');
  assert.equal(f.schedule.frames.size, 1);
});

test('Canvas2D context loss stops drawing and restoration rebuilds state without cancelling browser recovery', () => {
  const f = particles(), original = f.context();
  const loss = new Event('contextlost', { cancelable: true }); original.lost = true;
  f.canvas.dispatchEvent(loss);
  assert.equal(loss.defaultPrevented, false);
  assert.equal(f.canvas.dataset.status, 'context-lost');
  assert.equal(f.schedule.frames.size, 0);
  const restored = f.replaceContext(); f.canvas.dispatchEvent(new Event('contextrestored'));
  assert.ok(restored.transforms > 0 && restored.draws > 0);
  assert.equal(f.canvas.dataset.status, 'running');
  assert.equal(f.schedule.frames.size, 1);
  f.schedule.tick(100); assert.equal(f.schedule.frames.size, 1);
});

test('background visibility and page lifecycle stop all loops and resume only one loop', () => {
  const f = particles();
  f.nativeVisibility(false); assert.equal(f.schedule.frames.size, 0);
  const count = f.canvas.dataset.frame;
  f.schedule.tick(1000); assert.equal(f.canvas.dataset.frame, count);
  f.nativeVisibility(true); f.nativeVisibility(true); assert.equal(f.schedule.frames.size, 1);
  f.doc.hidden = true; f.doc.dispatchEvent(new Event('visibilitychange')); assert.equal(f.schedule.frames.size, 0);
  f.win.dispatchEvent(new Event('resize')); f.win.dispatchEvent(new Event('resize')); assert.equal(f.schedule.frames.size, 1);
  f.win.dispatchEvent(new Event('pagehide')); assert.equal(f.schedule.frames.size, 0);
  f.doc.hidden = false; f.doc.dispatchEvent(new Event('visibilitychange')); assert.equal(f.schedule.frames.size, 0);
  f.win.dispatchEvent(new Event('pageshow')); assert.equal(f.schedule.frames.size, 1);
  const off = particles({ motion: false }); off.canvas.dispatchEvent(new Event('contextlost')); off.replaceContext(); off.canvas.dispatchEvent(new Event('contextrestored'));
  assert.equal(off.canvas.dataset.status, 'paused'); assert.equal(off.schedule.frames.size, 0); assert.ok(off.context().draws > 0);
});

function cylinder() {
  const schedule = scheduler(), doc = { hidden: false }, win = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/cylinder-preview.js'), 'utf8'), { window: win, document: doc, requestAnimationFrame: schedule.request, cancelAnimationFrame: schedule.cancel });
  const preview = Object.create(win.ShituCylinderPreview.prototype);
  Object.assign(preview, { opened: true, singleMode: false, frame: 0, lastFrameDraw: 0, appVisible: true, pageActive: true,
    ambientMotion: true, rotation: null, targetColumn: 3, position: 2, suspendedVideos: new Map(), media: [], ring: { dataset: {} }, draws: 0,
    draw() { this.draws++; }, endPan() {}, resize() { this.draw(); } });
  return { preview, schedule, doc };
}
test('cylinder suspends hidden preview animation and resumes only the same paused video', async () => {
  const { preview, schedule, doc } = cylinder();
  const video = { tagName: 'VIDEO', currentSrc: 'shitu://one', paused: false, plays: 0, pause() { this.paused = true; }, play() { this.plays++; this.paused = false; return Promise.resolve(); } };
  preview.media = [video]; preview.ensureFrame(); preview.ensureFrame(); assert.equal(schedule.frames.size, 1);
  doc.hidden = true; preview.syncVisibility();
  assert.equal(schedule.frames.size, 0); assert.equal(video.paused, true); assert.equal(preview.position, 3);
  doc.hidden = false; preview.syncVisibility();
  assert.equal(video.plays, 1); assert.equal(schedule.frames.size, 1);
  preview.appVisible = false; preview.syncVisibility(); video.currentSrc = 'shitu://two'; preview.appVisible = true; preview.syncVisibility();
  assert.equal(video.plays, 1, 'A different source must not be auto-started');
  preview.appVisible = false; preview.syncVisibility(); preview.opened = false; preview.appVisible = true; preview.syncVisibility();
  assert.equal(schedule.frames.size, 0); assert.equal(preview.suspendedVideos.size, 0);
});

test('idle cylinder floating avoids sixty DOM redraws per second while rotation remains smooth', () => {
  const { preview, schedule } = cylinder(); preview.ensureFrame();
  for (let time = 100; time < 1100; time += 1000 / 60) schedule.tick(time);
  assert.ok(preview.draws <= 31 && preview.draws >= 20);
  const count = preview.draws; preview.rotation = { from: 0, to: 1, start: 1100, duration: 300 };
  for (let time = 1100; time < 1250; time += 1000 / 60) schedule.tick(time);
  assert.ok(preview.draws - count >= 8);
  preview.pageActive = false; preview.syncVisibility(); assert.equal(schedule.frames.size, 0);
});
