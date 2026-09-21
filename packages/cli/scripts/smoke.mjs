// Packs the CLI exactly as npm would publish it, runs it through `npm exec` in a
// brand-new repository, and checks that init and status work and touch nothing.
// Plain Node on purpose, so the same check runs on Windows, macOS and Linux.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = fileURLToPath(new URL('..', import.meta.url));
const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'deepblame-smoke-')));
const windows = process.platform === 'win32';

function npm(args, cwd) {
  // npm is a .cmd file on Windows, which Node can only start through a shell.
  const result = windows
    ? spawnSync(`npm.cmd ${args.map(quote).join(' ')}`, { cwd, encoding: 'utf8', shell: true })
    : spawnSync('npm', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed\n${result.stderr || result.stdout || result.error}`);
  }
  return result.stdout;
}

function quote(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
  console.log(`ok  ${message}`);
}

try {
  npm(['pack', '--pack-destination', work], cliDir);
  const tarball = readdirSync(work).find((file) => file.endsWith('.tgz'));
  check(tarball !== undefined, 'npm pack produced a tarball');

  const repo = join(work, 'repo');
  mkdirSync(repo);
  git(['init', '-q'], repo);
  writeFileSync(join(repo, 'index.js'), 'console.log(1)\n');
  git(['add', '.'], repo);
  git(['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-q', '--no-gpg-sign', '-m', 'first'], repo);
  const head = git(['rev-parse', 'HEAD'], repo);

  const deepblame = (...args) => npm(['exec', '--yes', `--package=${join(work, tarball)}`, '--', 'deepblame', ...args], repo);

  process.stdout.write(deepblame('init'));
  const report = JSON.parse(deepblame('status', '--json'));
  check(report.initialized === true, 'status reports the repository as set up');
  check(/^[0-9a-f]{40}$/.test(report.ledger.head ?? ''), 'the ledger ref points at a commit');
  check(git(['rev-parse', 'HEAD'], repo) === head, 'HEAD is untouched');
  check(git(['status', '--porcelain'], repo) === '', 'the working tree is clean');
  console.log(`smoke: all checks passed on ${process.platform}`);
} catch (error) {
  console.error(`smoke: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
