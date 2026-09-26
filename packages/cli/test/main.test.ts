import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEDGER_REF } from '@deepblame/protocol';
import { capture } from '../src/capture';
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

const SESSION = '3c9a71e4-55d2-4f8b-9a11-0b2c3d4e5f60';

/** One hook call, exactly as the installed command receives it. */
function hook(repo: string, event: Record<string, unknown>): number {
  return capture(['--agent', 'claude-code'], {
    cwd: repo,
    env: { PATH: '' },
    stdin: () => JSON.stringify({ session_id: SESSION, cwd: repo, ...event }),
  });
}

describe('recording through the cli', () => {
  it('captures a turn, seals it on log and shows it in full', () => {
    const repo = makeRepo({ commits: true });
    run(['init'], repo);
    const file = join(repo, 'app.ts');

    expect(hook(repo, { hook_event_name: 'UserPromptSubmit', prompt: 'rename the answer' })).toBe(0);
    hook(repo, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } });
    writeFileSync(file, 'export const theAnswer = 42;\n');
    hook(repo, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: file, old_string: 'answer', new_string: 'theAnswer' },
      tool_response: {},
    });
    hook(repo, { hook_event_name: 'Stop' });

    const listed = run(['log'], repo);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('rename the answer');
    expect(listed.out).toContain('claude-code');
    expect(listed.out).toContain('1 run shown');

    const asJson = JSON.parse(run(['log', '--json'], repo).out);
    const id = asJson.runs[0].run.run_id;
    const shown = run(['show', id], repo);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`run ${id}`);
    expect(shown.out).toContain('app.ts');
    expect(shown.out).toContain('Edit ×1');

    expect(run(['status'], repo).out).toContain('1 run recorded');
  });

  it('says so when there is nothing recorded or nothing to seal', () => {
    const repo = makeRepo({ commits: true });
    run(['init'], repo);
    expect(run(['log'], repo).out).toContain('No agent runs recorded yet.');
    expect(run(['seal'], repo).out).toContain('Nothing to seal');
  });

  it('installs and removes capture hooks', () => {
    const repo = makeRepo({ commits: true });
    run(['init'], repo);

    const installed = run(['hooks', 'install'], repo);
    expect(installed.code).toBe(0);
    expect(installed.out).toContain('.claude/settings.json');
    expect(run(['hooks', 'status'], repo).out).toContain('capture  on');
    expect(run(['status'], repo).out).toContain('recording  on');

    expect(run(['hooks', 'uninstall'], repo).out).toContain('removed');
    expect(run(['hooks', 'status'], repo).out).toContain('capture  off');
  });

  it('reports a run id nobody has', () => {
    const repo = makeRepo({ commits: true });
    run(['init'], repo);
    const { code, err } = run(['show', 'deadbeef'], repo);
    expect(code).toBe(1);
    expect(err).toContain("no run matches 'deadbeef'");
  });

  it.each([
    [['show'], 'deepblame show needs a run id'],
    [['hooks'], 'deepblame hooks needs install, uninstall or status'],
    [['hooks', 'fly'], "unknown hooks action 'fly'"],
    [['log', '--limit', 'ten'], '--limit needs a positive number'],
  ])('rejects %j with exit code 2', (args, message) => {
    const repo = makeRepo({ commits: true });
    run(['init'], repo);
    const { code, err } = run(args, repo);
    expect(code).toBe(2);
    expect(err).toContain(message);
  });
});
