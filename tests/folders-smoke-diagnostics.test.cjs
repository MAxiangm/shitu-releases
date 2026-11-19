'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { executeRendererStep } = require('../scripts/folders-smoke-bootstrap.cjs');

function renderer() {
  const context = vm.createContext({ window: {} });
  return { executeJavaScript: code => vm.runInContext(code, context) };
}

test('folder smoke preserves the asynchronous renderer error and the failing phase', async () => {
  await assert.rejects(executeRendererStep(renderer(), `(async () => {
    window.__folderSmokeStep = 'details folder destinations';
    await Promise.resolve();
    throw new Error('Missing selected folder options');
  })()`), /Folder renderer \(details folder destinations\): Missing selected folder options/);
});

test('folder smoke returns successful script results and reports synchronous missing globals', async () => {
  const contents = renderer();
  assert.equal(await executeRendererStep(contents, '(async () => 42)()'), 42);
  assert.equal(await executeRendererStep(contents, 'window.visible = true'), true);
  await assert.rejects(executeRendererStep(contents, 'missingFolderHelper()'), /missingFolderHelper is not defined/);
});
