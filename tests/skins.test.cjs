'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Skins = require('../src/skins.js');
test('skin catalog includes the requested eight styles and the preserved default', () => {
  assert.deepEqual(Skins.catalog.map(skin => skin.id), ['default', 'famicom', 'psp', 'gameboy', 'switch', 'win97', 'win98', 'winxp', 'mac']);
  assert.equal(new Set(Skins.catalog.map(skin => skin.id)).size, 9);
  assert.equal(Object.isFrozen(Skins.catalog), true); assert.equal(Object.isFrozen(Skins.catalog[0]), true);
  assert.equal(Skins.normalize('invalid-theme'), 'default');
});
test('restoring a saved skin applies it before UI creation without rewriting preferences', () => {
  const document = { documentElement: { dataset: {} } }, events = [], writes = [];
  const controller = Skins.create({ document, getStorage: () => ({ getItem: key => { assert.equal(key, 'shitu-skin'); return 'gameboy'; }, setItem: (...args) => writes.push(args) }), onChange: value => events.push(value) });
  controller.restore(); assert.equal(document.documentElement.dataset.skin, 'gameboy'); assert.equal(controller.current().name, 'Game Boy');
  assert.deepEqual(writes, []); assert.equal(events[0].id, 'gameboy');
});
test('skin switching stores only known IDs and emits one event for a real change', () => {
  const document = { documentElement: { dataset: {} } }, events = [], writes = [];
  const controller = Skins.create({ document, getStorage: () => ({ setItem: (...args) => writes.push(args) }), onChange: value => events.push(value) });
  controller.apply('mac'); controller.apply('mac');
  assert.equal(events.length, 1); assert.deepEqual(writes[0], ['shitu-skin', 'mac']);
  controller.apply('<script>'); assert.equal(document.documentElement.dataset.skin, 'default'); assert.equal(writes.at(-1)[1], 'default');
});
test('blocked browser storage cannot prevent the user from switching appearance', () => {
  const document = { documentElement: { dataset: {} } };
  const controller = Skins.create({ document, getStorage: () => { throw new Error('blocked'); } });
  assert.equal(controller.restore().id, 'default'); assert.equal(controller.apply('win98').id, 'win98');
  assert.equal(document.documentElement.dataset.skin, 'win98');
});
