'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createTaskCenter } = require('../src/task-center.cjs');

function fixture() {
  const assets = [
    { id: 'video-1', name: '视频 A', hash: 'hash-a' },
    { id: 'video-2', name: '视频 B', hash: 'hash-b' },
    { id: 'project', name: 'AE 工程', hash: 'hash-c' },
    { id: 'model', name: 'FBX 模型', hash: 'hash-d' }
  ];
  const library = { root: path.resolve('library'), snapshot: () => ({ assets }) };
  let current = library;
  const tasks = createTaskCenter({ getLibrary: () => current });
  return { library, assets, tasks, reopen: () => { current = { ...library }; tasks.refresh(); } };
}

test('import reports individual failures and only retries a file with equivalent import scope', async () => {
  const { library, tasks } = fixture();
  const folder = path.resolve('project-sources');
  const video = path.join(folder, '坏视频.mov');
  const project = path.join(folder, '工程.aep');
  const retried = [];
  const report = await tasks.runImport(library, { paths: [folder], folderId: 'destination', retry: (...args) => retried.push(args) },
    async progress => {
      progress({ path: video, current: 1, total: 2 });
      assert.equal(tasks.state().tasks[0].progress, 0.5);
      assert.equal(tasks.state().tasks[0].status, 'running');
      return { imported: 2, errors: [{ path: video, message: '无法读取文件' }, { path: project, message: 'AE 不可用' }] };
    });
  assert.equal(report.imported, 2);
  const rows = tasks.state().tasks;
  const videoRow = rows.find(row => row.title === '坏视频.mov');
  const projectRow = rows.find(row => row.kind === 'ae-package');
  assert.equal(videoRow.note, '无法读取文件');
  assert.equal(videoRow.retryable, true);
  assert.equal(projectRow.retryable, false);
  await tasks.retry(videoRow.id);
  assert.deepEqual(retried, [[video, 'destination']]);
  assert.ok(!tasks.state().tasks.some(row => row.id === videoRow.id));
});

test('transcodes report queued/running and retry only an unsaved failure with its original settings', async () => {
  const { library, assets, tasks } = fixture();
  const base = { id: 'batch', root: library.root, total: 2, completed: 0, status: 'running', failed: 0, format: 'mp4', bitrateMbps: 24 };
  const requests = [];
  const retry = request => requests.push(request);
  tasks.transcode(base, retry);
  assert.equal(tasks.state().tasks[0].status, 'queued');
  tasks.transcode({ ...base, runningItems: [{ name: '视频 A' }], progress: 21 }, retry);
  const running = tasks.state().tasks[0];
  assert.equal(running.status, 'running');
  assert.equal(running.progress, 0.21);
  assert.match(running.note, /视频 A.+1 项排队/);
  tasks.transcode({ ...base, status: 'completed', completed: 2, failed: 2,
    errors: assets.slice(0, 2).map(item => ({ ...item, error: '转码失败' })),
    results: [{ id: 'video-1', assetIds: [] }, { id: 'video-2', assetIds: ['已收录'] }] }, retry);
  const safe = tasks.state().tasks.find(row => row.title === '视频 A');
  assert.equal(safe.retryable, true);
  assert.equal(tasks.state().tasks.find(row => row.title === '视频 B').retryable, false);
  await tasks.retry(safe.id);
  assert.deepEqual(requests, [{ ids: ['video-1'], expectedRoot: library.root, format: 'mp4', bitrateMbps: 24 }]);
});

test('AE tasks track the requested composition throughout the render and revoke retries on a library switch', async () => {
  const { library, tasks, reopen } = fixture();
  const input = { id: 'project', root: library.root, requestedCompositionId: null };
  tasks.projectPreview(library, { ...input, status: 'queued' });
  const id = tasks.state().tasks[0].id;
  tasks.projectPreview(library, { ...input, status: 'rendering', compositionId: 13 });
  tasks.projectPreview(library, { ...input, status: 'ready', compositionId: 13, progress: 1 });
  assert.equal(tasks.state().tasks.length, 1);
  assert.equal(tasks.state().tasks[0].id, id);
  assert.equal(tasks.state().tasks[0].status, 'done');
  const calls = [];
  tasks.projectPreview(library, { ...input, status: 'error', requestedCompositionId: 23, error: '渲染失败' },
    (...args) => calls.push(args));
  await tasks.retry(tasks.state().tasks.find(row => row.retryable).id);
  assert.deepEqual(calls, [['project', 23]]);
  tasks.projectPreview(library, { ...input, status: 'error' }, () => {});
  reopen();
  assert.equal(tasks.state().tasks.length, 0);
  await assert.rejects(tasks.retry(id), /无法重试/);
});

test('model rendering propagates the source result/error and a cancelled task does not offer retry', async () => {
  const { library, tasks } = fixture();
  const error = new Error('预览失败');
  const render = () => tasks.runModel(library, 'model', () => Buffer.from('预览'), {});
  await assert.rejects(tasks.runModel(library, 'model', () => { throw error; }, { retry: render }), error);
  const id = tasks.state().tasks[0].id;
  assert.equal(tasks.state().tasks[0].retryable, true);
  await tasks.retry(id);
  assert.equal(tasks.state().tasks[0].status, 'done');
  await assert.rejects(tasks.runModel(library, 'model', () => { throw new DOMException('已取消', 'AbortError'); }, { retry: render }), { name: 'AbortError' });
  assert.equal(tasks.state().tasks[0].status, 'cancelled');
  assert.equal(tasks.state().tasks[0].retryable, false);
  assert.deepEqual(tasks.clear().tasks, []);
});
