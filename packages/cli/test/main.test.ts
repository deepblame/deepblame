import { describe, expect, it } from 'vitest';
import { LEDGER_REF } from '@deepblame/protocol';
import { VERSION, main } from '../src/main';
import { makeRepo, scratchDir } from '../../core/test/helpers';

function run(args: string[], cwd: string, color = false) {
  let out = '';
  let err = '';
  const code = main(args, {
    cwd,
    env: { PATH: '' },
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    color,
  });
  return { code, out, err };
}

describe('deepblame cli', () => {
  it('prints its version', () => {
    expect(run(['--version'], scratchDir('v'))).toEqual({ code: 0, out: `${VERSION}\n`, err: '' });
  });

  it('prints help when called without a command', () => {
    const { code, out } = run([], scratchDir('h'));
    expect(code).toBe(0);
    expect(out).toContain('deepblame init');
    expect(out).toContain('deepblame status');
  });

  it('sets up a repository and reports on it', () => {
    const repo = makeRepo();
    const setUp = run(['init'], repo);
    expect(setUp.code).toBe(0);
    expect(setUp.out).toContain(`DeepBlame is set up in ${repo}`);

    const again = run(['init'], repo);
    expect(again.out).toContain('was already set up');

    const report = run(['status'], repo);
    expect(report.code).toBe(0);
    expect(report.out).toContain(LEDGER_REF);
    expect(report.out).toContain('0 runs recorded');
    expect(report.out).toContain('recording  off');
  });

  it('explains how to start when status runs before init', () => {
    const { code, out } = run(['status'], makeRepo());
    expect(code).toBe(0);
    expect(out).toContain('Run deepblame init to start.');
  });

  it('emits plain JSON with --json, even when color is on', () => {
    const repo = makeRepo();
    run(['init'], repo);
    const { code, out } = run(['status', '--json'], repo, true);

    expect(code).toBe(0);
    expect(out).not.toContain('\u001b[');
    const report = JSON.parse(out);
    expect(report.initialized).toBe(true);
    expect(report.ledger.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('uses color only when asked to', () => {
    const repo = makeRepo();
    expect(run(['init'], repo, true).out).toContain('\u001b[');
    expect(run(['status'], repo, false).out).not.toContain('\u001b[');
  });

  it('runs against another directory with -C', () => {
    const repo = makeRepo();
    expect(run(['-C', repo, 'init'], scratchDir('elsewhere')).code).toBe(0);
    expect(run(['status', '--json'], repo).out).toContain('"initialized": true');
  });

  it('fails clearly outside a git repository', () => {
    const { code, out, err } = run(['init'], scratchDir('plain'));
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('not inside a git repository');
  });

  it.each([
    [['launch'], "unknown command 'launch'"],
    [['init', 'now'], "unexpected argument 'now'"],
    [['status', '--verbose'], "Unknown option '--verbose'"],
  ])('rejects %j with exit code 2', (args, message) => {
    const { code, err } = run(args, scratchDir('usage'));
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(err).toContain("See 'deepblame --help'.");
  });
});
