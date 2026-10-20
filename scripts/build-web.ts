// Bundles the console: one hashed JS file, one hashed CSS file, index.html.
// Usage: node scripts/build-web.ts [--watch]

import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webOptions } from './web-options.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'dist/web');
const watch = process.argv.includes('--watch');

const options = webOptions(root, out, watch);

function writeHtml(files: string[]) {
  const js = files.find((f) => /^app-.*\.js$/.test(f));
  const css = files.find((f) => /^app-.*\.css$/.test(f));
  if (!js || !css) throw new Error('bundle output missing');
  const html = readFileSync(join(root, 'src/web/index.html'), 'utf8').replace('/__JS__', `/${js}`).replace('/__CSS__', `/${css}`);
  writeFileSync(join(out, 'index.html'), html);
  copyFileSync(join(root, 'src/web/favicon.svg'), join(out, 'favicon.svg'));
  copyFileSync(join(root, 'node_modules/preact/LICENSE'), join(out, 'PREACT-LICENSE.txt'));
  writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nAllow: /\n');
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (watch) {
  const ctx = await context({
    ...options,
    entryNames: 'app-dev',
    plugins: [{ name: 'html', setup(b) { b.onEnd(() => writeHtml(readdirSync(out))); } }],
  });
  await ctx.watch();
} else {
  const result = await build(options);
  writeHtml(readdirSync(out));
  const bytes = Object.values(result.metafile!.outputs).reduce((a, o) => a + o.bytes, 0);
  console.log(`console bundle: ${(bytes / 1024).toFixed(1)} KB before compression`);
}
