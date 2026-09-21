import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// Every test runs against an empty global git config: no identity, no signing,
// no hooks path. That is the hardest environment the CLI has to survive.
// realpath matters: git reports canonical paths, but the temp dir is behind a
// symlink on macOS (/var -> /private/var) and an 8.3 short name on Windows CI.
const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'deepblame-test-')));
writeFileSync(join(sandbox, 'empty-gitconfig'), '');
process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'empty-gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_') && key !== 'GIT_CONFIG_GLOBAL' && key !== 'GIT_CONFIG_NOSYSTEM') delete process.env[key];
}

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

let counter = 0;

/** git with a throwaway identity, for setting up fixtures only. Throws on non-zero exit. */
export function sh(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

export function makeRepo(options: { commits?: boolean; objectFormat?: 'sha1' | 'sha256' } = {}): string {
  const dir = scratchDir('repo');
  const format = options.objectFormat === 'sha256' ? ['--object-format=sha256'] : [];
  sh(dir, ['init', '-q', '-b', 'main', ...format]);
  if (options.commits) {
    writeFileSync(join(dir, 'app.ts'), 'export const answer = 42;\n');
    sh(dir, ['add', 'app.ts']);
    sh(dir, ['commit', '-q', '--no-gpg-sign', '-m', 'first']);
  }
  return dir;
}

export function scratchDir(prefix: string): string {
  const dir = join(sandbox, `${prefix}-${++counter}`);
  mkdirSync(dir);
  return dir;
}
