// Exercise the shipped build against the entire application: adding scenery
// must not silently restore a second UI runtime or break the transfer budget.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { webOptions } from '../scripts/web-options.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

test('complete production console fits 160 KiB with one browser UI runtime', async () => {
  const result = await build({ ...webOptions(root, join(root, 'dist/web')), write: false, logLevel: 'silent' });
  const assets = result.outputFiles!.filter((file) => /\.(js|css)$/.test(file.path));
  assert.equal(assets.length, 2, 'JS and CSS both count toward the transfer budget');
  const html = readFileSync(join(root, 'src/web/index.html'));
  const total = assets.reduce((bytes, file) => bytes + gzipSync(file.contents).length, gzipSync(html).length);
  assert.ok(total <= 160 * 1024, `console is ${(total / 1024).toFixed(1)} KiB gzipped`);
  const inputs = Object.keys(result.metafile!.inputs);
  assert.ok(inputs.some((file) => file.includes('node_modules/preact/')));
  assert.ok(!inputs.some((file) => /node_modules\/react(?:-dom)?\//.test(file)), 'compatibility must not bundle a second hook dispatcher');
});
