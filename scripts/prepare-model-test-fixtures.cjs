'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { root } = require('./runtime.cjs');
const manifest = require('./model-viewer-test-fixtures.json');
const samplesRoot = path.join(root, '.recovery', 'samples', 'models');

async function prepareModelTestFixtures({ download = true } = {}) {
  const verified = [];
  await fs.mkdir(samplesRoot, { recursive: true });
  for (const sample of manifest.samples) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(sample.name) || sample.name === '.' || sample.name === '..' ||
        !/^[a-f0-9]{64}$/.test(sample.sha256) || !(sample.bytes > 0 && sample.bytes < 16 * 1024 * 1024))
      throw new Error('Invalid model test fixture manifest');
    const filename = path.join(samplesRoot, sample.name);
    let bytes = await fs.readFile(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const matches = value => value?.length === sample.bytes && crypto.createHash('sha256').update(value).digest('hex') === sample.sha256;
    if (!matches(bytes)) {
      if (!download) throw new Error(`Missing or changed model sample ${sample.name}. Run node scripts/prepare-model-test-fixtures.cjs first; the smoke test never downloads fixtures.`);
      const url = new URL(sample.url);
      if (url.origin !== 'https://raw.githubusercontent.com' || !url.pathname.startsWith(`/mrdoob/three.js/${manifest.upstreamCommit}/examples/`))
        throw new Error('Model sample must come from the fixed upstream commit');
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Model sample download returned HTTP ${response.status}: ${sample.name}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (!matches(bytes)) throw new Error(`Model sample size/SHA-256 mismatch: ${sample.name}`);
      const temporary = path.join(samplesRoot, `.${sample.name}.${crypto.randomUUID()}.tmp`);
      try { await fs.writeFile(temporary, bytes, { flag: 'wx' }); await fs.rename(temporary, filename); }
      finally { await fs.unlink(temporary).catch(() => {}); }
    }
    verified.push({ ...sample, filename });
  }
  return { samplesRoot, samples: verified };
}

if (require.main === module) prepareModelTestFixtures().then(result => {
  console.log(JSON.stringify({ verified: result.samples.map(sample => ({ name: sample.name, bytes: sample.bytes, sha256: sample.sha256 })), directory: samplesRoot }, null, 2));
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { prepareModelTestFixtures, samplesRoot };
