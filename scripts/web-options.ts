// The browser uses Preact's React compatibility layer to keep the complete 3D
// console within its transfer budget. This does not add a Tower dependency.

import type { BuildOptions } from 'esbuild';
import { join } from 'node:path';

export function webOptions(root: string, outdir: string, watch = false): BuildOptions {
  return {
    entryPoints: [join(root, 'src/web/main.tsx')],
    bundle: true,
    outdir,
    entryNames: 'app-[hash]',
    assetNames: 'assets/[name]-[hash]',
    format: 'esm',
    target: ['es2022', 'chrome109', 'firefox115', 'safari16'],
    jsx: 'automatic',
    alias: {
      'react-dom/client': 'preact/compat/client',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
      'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
      react: 'preact/compat',
    },
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    legalComments: 'none',
    metafile: true,
    define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
    logLevel: 'info',
  };
}
