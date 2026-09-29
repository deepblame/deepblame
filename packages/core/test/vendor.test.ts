import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BIN_DIR, CAPTURE_STAMP, STATE_DIR } from '@deepblame/protocol';
import { describe, expect, it } from 'vitest';
import { init } from '../src/commands';
import { diagnose, type Check } from '../src/doctor';
import { installedCommands } from '../src/hooks';
import { openRepo } from '../src/repo';
import { capturePath, readStamp, sealerPath, vendorCapture } from '../src/vendor';
import { makeRepo, scratchDir } from './helpers';

/**
 * The bug these exist for, found by installing the published package and doing
 * exactly what the README says:
 *
 *   `npx deepblame init` puts the CLI on PATH for the length of that one
 *   command. A hook written to call it by name is checked while it is there,
 *   reported as installed, and resolves to nothing by the time an agent fires
 *   it. Capture never prints and always exits 0, so nothing is recorded and
 *   nothing says so.
 *
 * Two answers. The hooks call a copy inside the repository, which cannot go
 * away; and `doctor` checks that the command it finds installed actually
 * resolves, so the next member of this family is loud instead of silent.
 */

const NOW = new Date('2026-09-28T09:00:00.000Z');
const WINDOWS = process.platform === 'win32';

/** Exactly how the CLI spells a hook command, spaces in node's path and all. */
function hookFor(root: string): string {
  const quote = (path: string): string => (/[\s"']/.test(path) ? `"${path}"` : path);
  return `${quote(process.execPath)} ${quote(capturePath(root))}`;
}

/** Stands in for the capture bundle the CLI ships. */
function bundle(text = 'console.log("capture");\n'): string {
  const dir = scratchDir('dist');
  const file = join(dir, 'capture.cjs');
  writeFileSync(file, text);
  return file;
}

describe('the copy the hooks call', () => {
  it('puts the capture program inside the repository', () => {
    const root = makeRepo({ commits: true });
    const source = bundle();
    const result = vendorCapture(root, source, '0.3.0', NOW);

    expect(result.changed).toBe(true);
    expect(result.path).toBe(join(root, STATE_DIR, BIN_DIR, 'capture.cjs'));
    expect(readFileSync(result.path, 'utf8')).toBe(readFileSync(source, 'utf8'));
  });

  it('records which version it came from, so a stale copy can be spotted', () => {
    const root = makeRepo({ commits: true });
    vendorCapture(root, bundle(), '0.3.0', NOW);

    const stamp = readStamp(root);
    expect(stamp.exists).toBe(true);
    expect(stamp.version).toBe('0.3.0');
    expect(stamp.installedAt).toBe(NOW.toISOString());
  });

  it('does not rewrite a copy that is already the same', () => {
    const root = makeRepo({ commits: true });
    const source = bundle();
    vendorCapture(root, source, '0.3.0', NOW);
    const again = vendorCapture(root, source, '0.3.0', NOW);
    expect(again.changed).toBe(false);
  });

  it('replaces a copy from an older version', () => {
    const root = makeRepo({ commits: true });
    vendorCapture(root, bundle('old\n'), '0.2.0', NOW);
    const result = vendorCapture(root, bundle('new\n'), '0.3.0', NOW);

    expect(result.changed).toBe(true);
    expect(readFileSync(result.path, 'utf8')).toBe('new\n');
    expect(readStamp(root).version).toBe('0.3.0');
  });

  it('puts the sealer in beside it, so a turn does not wait for a command', () => {
    const root = makeRepo({ commits: true });
    const dir = scratchDir('dist');
    const capture = join(dir, 'capture.cjs');
    const cli = join(dir, 'deepblame.mjs');
    writeFileSync(capture, 'capture\n');
    writeFileSync(cli, 'cli\n');

    vendorCapture(root, { capture, cli }, '0.3.1', NOW);
    // Capture writes one line and exits; something else has to turn those lines
    // into the ledger, and it has to be findable from here too.
    expect(readFileSync(sealerPath(root), 'utf8')).toBe('cli\n');
  });

  it('still copies the capture program when the sealer is not there to copy', () => {
    const root = makeRepo({ commits: true });
    const result = vendorCapture(root, { capture: bundle(), cli: null }, '0.3.1', NOW);
    expect(result.changed).toBe(true);
    expect(existsSync(sealerPath(root))).toBe(false);
  });

  it('does nothing, and says so, when there is no bundle to copy', () => {
    const root = makeRepo({ commits: true });
    const result = vendorCapture(root, null, '0.3.0', NOW);
    expect(result.source).toBeNull();
    expect(result.changed).toBe(false);
    expect(existsSync(result.path)).toBe(false);
  });

  it('survives a stamp somebody has mangled', () => {
    const root = makeRepo({ commits: true });
    vendorCapture(root, bundle(), '0.3.0', NOW);
    writeFileSync(join(root, STATE_DIR, BIN_DIR, CAPTURE_STAMP), '{ not json');
    expect(readStamp(root).version).toBeNull();
    expect(readStamp(root).exists).toBe(true);
  });
});

describe('init wires the hook to the copy, not to a name', () => {
  it('writes a path that is still there after the install shell is gone', () => {
    const root = makeRepo({ commits: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    const source = bundle();

    init(root, {
      now: NOW,
      env: { PATH: '' },
      hookCommand: hookFor(root),
      captureSource: source,
      version: '0.3.0',
    });

    const installed = installedCommands(root);
    expect(installed).toHaveLength(1);
    expect(installed[0]?.command).toContain(capturePath(root));
    expect(existsSync(capturePath(root))).toBe(true);
  });

  it('leaves the state directory reported as newly created', () => {
    const root = makeRepo({ commits: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    const result = init(root, {
      now: NOW,
      hookCommand: hookFor(root),
      captureSource: bundle(),
    });
    // The copy must not land first and make `init` claim the directory was
    // already there.
    expect(result.stateDir.created).toBe(true);
    expect(existsSync(join(root, STATE_DIR, '.gitignore'))).toBe(true);
  });

  it('copies nothing when asked to leave the settings alone', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: NOW, noHooks: true, hookCommand: 'x', captureSource: bundle() });
    expect(existsSync(capturePath(root))).toBe(false);
  });
});

describe('doctor on a hook that no longer resolves', () => {
  const hooks = [{ file: 'x', installed: true }];

  function repoWithHook(command: string): string {
    const root = makeRepo({ commits: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
    );
    return root;
  }

  it('fails loudly on the npx trap: a name that was only ever briefly on PATH', () => {
    const root = repoWithHook('deepblame-capture');
    init(root, { now: NOW, noHooks: true });

    const checks = diagnose(openRepo(root), { now: NOW, hooks, env: { PATH: '' } }).checks;
    const hook = checks.find((check) => check.name === 'hook');
    expect(hook?.status).toBe('fail');
    expect(hook?.detail).toContain('nothing is being recorded');
    expect(hook?.fix).toBe('deepblame init');
  });

  it('says nothing when the copy is where the hook says it is', () => {
    const root = makeRepo({ commits: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    const source = bundle();
    init(root, {
      now: NOW,
      hookCommand: hookFor(root),
      captureSource: source,
      version: '0.3.0',
    });

    const checks = diagnose(openRepo(root), { now: NOW, hooks, env: { PATH: '' } }).checks;
    expect(checks.find((check) => check.name === 'hook')).toBeUndefined();
  });

  it('catches the copy being deleted afterwards', () => {
    const root = makeRepo({ commits: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    init(root, {
      now: NOW,
      hookCommand: hookFor(root),
      captureSource: bundle(),
      version: '0.3.0',
    });
    rmSync(capturePath(root));

    const checks = diagnose(openRepo(root), { now: NOW, hooks, env: { PATH: '' } }).checks;
    expect(checks.find((check) => check.name === 'hook')?.status).toBe('fail');
  });

  it('unpicks a command whose program has a space in its path', () => {
    // Node lives in "C:\\Program Files\\nodejs" on Windows, so a checker that
    // splits on spaces declares every healthy hook there broken — and one that
    // stops at the program never notices a deleted script anywhere.
    const home = scratchDir('Program Files');
    const node = join(home, 'node.exe');
    writeFileSync(node, '');
    const root = makeRepo({ commits: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    const script = capturePath(root);
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${node}" "${script}"` }] }] } }),
    );
    init(root, { now: NOW, noHooks: true });

    const check = (): Check | undefined =>
      diagnose(openRepo(root), { now: NOW, hooks, env: { PATH: '' } }).checks.find((one) => one.name === 'hook');

    mkdirSync(join(root, STATE_DIR, BIN_DIR), { recursive: true });
    writeFileSync(script, 'capture\n');
    expect(check()).toBeUndefined();

    rmSync(script);
    expect(check()?.status).toBe('fail');
  });

  it('catches a relative path, which passes by luck from the repository root', () => {
    // Found by looking at our own repository: a hook written on the first day
    // said `node packages/cli/dist/capture.cjs`. It had recorded nothing in
    // eight days, and doctor called it healthy — because doctor runs from the
    // top of the repository, where that path happens to resolve.
    const root = repoWithHook('node packages/cli/dist/capture.cjs');
    init(root, { now: NOW, noHooks: true });
    mkdirSync(join(root, 'packages', 'cli', 'dist'), { recursive: true });
    writeFileSync(join(root, 'packages', 'cli', 'dist', 'capture.cjs'), 'capture\n');

    // node has to be findable, or the check stops at the interpreter and never
    // reaches the argument this test is about.
    const check = diagnose(openRepo(root), { now: NOW, hooks, env: { PATH: dirname(process.execPath) } }).checks.find(
      (one) => one.name === 'hook',
    );
    // The file is right there, and it is still wrong.
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('relative path');
    expect(check?.detail).toContain('repository root');
  });

  it('says which command is missing, not just that something is', () => {
    const root = repoWithHook('/nowhere/at/all/capture.cjs');
    init(root, { now: NOW, noHooks: true });
    const check = diagnose(openRepo(root), { now: NOW, hooks, env: { PATH: '' } }).checks.find(
      (one) => one.name === 'hook',
    );
    expect(check?.detail).toContain('/nowhere/at/all/capture.cjs');
    expect(check?.detail).toContain('nothing is being recorded');
  });

  it('takes an npx command on trust rather than going to the network', () => {
    const root = repoWithHook('npx --yes --package=deepblame deepblame-capture');
    init(root, { now: NOW, noHooks: true });

    const checks = diagnose(openRepo(root), { now: NOW, hooks, env: { PATH: '' } }).checks;
    expect(checks.find((check) => check.name === 'hook')).toBeUndefined();
  });

  it('accepts a name that really is on PATH', () => {
    const dir = scratchDir('bin');
    // Windows finds a command by extension, and PATHEXT decides which.
    const fake = join(dir, WINDOWS ? 'deepblame-capture.cmd' : 'deepblame-capture');
    writeFileSync(fake, WINDOWS ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');
    if (!WINDOWS) chmodSync(fake, 0o755);
    const root = repoWithHook('deepblame-capture');
    init(root, { now: NOW, noHooks: true });

    const checks = diagnose(openRepo(root), { now: NOW, hooks, env: { PATH: dir } }).checks;
    expect(checks.find((check) => check.name === 'hook')).toBeUndefined();
  });
});
