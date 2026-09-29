// Bundles the extension and the DeepBlame core it reads the ledger with into
// one CommonJS file, which is what VS Code loads.
//
// Core is bundled rather than shelled out to on purpose: the extension answers
// on every file you open, and spawning `npx deepblame` for that would cost
// more than reading the ledger does. It also means the extension works in a
// repository where nobody installed the CLI.
import { build } from 'esbuild';
import { copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (path) => fileURLToPath(new URL(path, import.meta.url));

rmSync(at('../dist'), { recursive: true, force: true });

await build({
  entryPoints: [at('../src/extension.ts')],
  outfile: at('../dist/extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Supplied by the editor at runtime, never bundled.
  external: ['vscode'],
  legalComments: 'none',
  logLevel: 'info',
});

copyFileSync(at('../../../LICENSE'), at('../LICENSE'));
copyFileSync(at('../../../NOTICE'), at('../NOTICE'));
