// Bundles the CLI and its internal packages into one dependency-free file,
// so `npx deepblame` downloads a single small package and starts fast.
// The output is deliberately not minified: people should be able to read
// exactly what a tool that watches their code does.
import { build } from 'esbuild';
import { chmodSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const outfile = at('../dist/deepblame.mjs');

rmSync(at('../dist'), { recursive: true, force: true });

await build({
  entryPoints: [at('../src/bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'info',
});

chmodSync(outfile, 0o755);
copyFileSync(at('../../../LICENSE'), at('../LICENSE'));
