// Packs the CLI exactly as npm would publish it, runs it through `npm exec` in
// a brand-new repository, records one agent turn the way a hook would, and
// checks that the run lands in the ledger and nothing else is touched.
// Plain Node on purpose, so the same check runs on Windows, macOS and Linux.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = fileURLToPath(new URL('..', import.meta.url));
const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'deepblame-smoke-')));
const windows = process.platform === 'win32';
const SESSION = '11111111-2222-4333-8444-555555555555';

function npm(args, cwd, input) {
  // npm is a .cmd file on Windows, which Node can only start through a shell.
  const options = { cwd, input, encoding: 'utf8' };
  const result = windows
    ? spawnSync(`npm.cmd ${args.map(quote).join(' ')}`, { ...options, shell: true })
    : spawnSync('npm', args, options);
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

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

try {
  npm(['pack', '--pack-destination', work], cliDir);
  const tarball = readdirSync(work).find((file) => file.endsWith('.tgz'));
  check(tarball !== undefined, 'npm pack produced a tarball');

  const repo = join(work, 'repo');
  mkdirSync(repo);
  git(['init', '-q'], repo);
  writeFileSync(join(repo, 'index.js'), 'export const answer = 1;\n');
  git(['add', '.'], repo);
  git(['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-q', '--no-gpg-sign', '-m', 'first'], repo);
  const head = git(['rev-parse', 'HEAD'], repo);

  const pack = `--package=${join(work, tarball)}`;
  const deepblame = (...args) => npm(['exec', '--yes', pack, '--', 'deepblame', ...args], repo);
  const hook = (event) =>
    npm(['exec', '--yes', pack, '--', 'deepblame-capture'], repo, JSON.stringify({ session_id: SESSION, cwd: repo, ...event }));

  process.stdout.write(deepblame('init'));
  const started = JSON.parse(deepblame('status', '--json'));
  check(started.initialized === true, 'status reports the repository as set up');
  check(/^[0-9a-f]{40}$/.test(started.ledger.head ?? ''), 'the ledger ref points at a commit');

  // One agent turn: a prompt, an edit, and the stop that ends it.
  const file = join(repo, 'index.js');
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'make the answer bigger' });
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } });
  writeFileSync(file, 'export const answer = 42;\n');
  hook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: '1', new_string: '42' },
    tool_response: {},
  });
  hook({ hook_event_name: 'Stop' });

  // The stop hook seals in the background; `log` seals too, so one of them wins.
  let log = { runs: [] };
  for (let attempt = 0; attempt < 10 && log.runs.length === 0; attempt += 1) {
    if (attempt > 0) sleep(500);
    log = JSON.parse(deepblame('log', '--json'));
  }
  check(log.runs.length === 1, 'the turn was sealed into exactly one run');
  const run = log.runs[0].run;
  check(run.harness.name === 'claude-code', 'the run names the agent that did the work');
  check(run.task.intent === 'make the answer bigger', 'the run remembers what it was asked to do');
  check(run.files_written.length === 1 && run.files_written[0].path === 'index.js', 'the edited file is recorded');
  check(run.files_written[0].pre_blob_sha !== run.files_written[0].post_blob_sha, 'before and after differ');
  check(run.tool_calls.length === 1, 'the tool call is recorded');

  check(git(['rev-parse', 'HEAD'], repo) === head, 'HEAD is untouched');
  const porcelain = git(['status', '--porcelain'], repo);
  check(porcelain.includes('M index.js'), 'the agent edit is the only change to tracked files');
  check(!porcelain.includes('.deepblame'), 'the state directory never shows up in git status');
  console.log(`smoke: all checks passed on ${process.platform}`);
} catch (error) {
  console.error(`smoke: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
