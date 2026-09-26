// Bundles the CLI and its internal packages into one dependency-free file,
// so `npx deepblame` downloads a single small package and starts fast.
// The output is deliberately not minified: people should be able to read
// exactly what a tool that watches their code does.
import { build } from 'esbuild';
import { chmodSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (path) => fileURLToPath(new URL(path, import.meta.url));

rmSync(at('../dist'), { recursive: true, force: true });

// Two bundles on purpose. The capture one runs inside every agent tool call,
// so it must not parse a line of the code the rest of the CLI needs.
const entries = [
  ['../src/bin.ts', '../dist/deepblame.mjs'],
  ['../src/capture-bin.ts', '../dist/capture.mjs'],
];

for (const [entry, output] of entries) {
  await build({
    entryPoints: [at(entry)],
    outfile: at(output),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    legalComments: 'none',
    logLevel: 'info',
  });
  chmodSync(at(output), 0o755);
}

copyFileSync(at('../../../LICENSE'), at('../LICENSE'));
