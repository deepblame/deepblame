import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUEUE_FILE, STATE_DIR } from '@deepblame/protocol';
import { appendEvents, captureClaudeCode, gitBlobOid, openCapture } from '../src/capture';
import { cost, init, status } from '../src/commands';
import { hooksInstalled, installClaudeCode, uninstallClaudeCode } from '../src/hooks';
import { openRepo } from '../src/repo';
import { listRuns } from '../src/runs';
import { seal } from '../src/seal';
import { makeRepo, sh } from './helpers';

const SESSION = '7b6a4f2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const T0 = new Date('2026-09-26T10:00:00.000Z');
const T1 = new Date('2026-09-26T10:00:05.000Z');
const T2 = new Date('2026-09-26T10:00:09.000Z');

function feed(root: string, event: Record<string, unknown>, now: Date): { seal: boolean; events: number } {
  const context = openCapture(root);
  if (context === null) throw new Error('not set up');
  const result = captureClaudeCode({ session_id: SESSION, cwd: root, ...event }, context, now);
  return { seal: result.seal, events: appendEvents(context, result.events) };
}

function queue(root: string): string[] {
  const text = readFileSync(join(root, STATE_DIR, QUEUE_FILE), 'utf8');
  return text.split('\n').filter((line) => line.trim() !== '');
}

/** One complete Claude Code turn that edits app.ts. */
function editTurn(root: string, prompt: string, from: string, to: string): void {
  const file = join(root, 'app.ts');
  feed(root, { hook_event_name: 'SessionStart', source: 'startup', transcript_path: '/tmp/t.jsonl' }, T0);
  feed(root, { hook_event_name: 'UserPromptSubmit', prompt }, T0);
  feed(root, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } }, T1);
  writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));
  feed(
    root,
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: file, old_string: from, new_string: to },
      tool_response: { filePath: file },
    },
    T1,
  );
  feed(root, { hook_event_name: 'Stop', stop_hook_active: false }, T2);
}

describe('capture', () => {
  it('records a whole turn and seals it into one run', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    editTurn(root, 'give the answer a name', 'answer', 'theAnswer');

    const result = seal(openRepo(root), { now: T2 });
    expect(result.sealed).toBe(1);
    expect(result.pending).toBe(0);
    expect(result.rejected).toEqual([]);

    const [entry] = listRuns(openRepo(root));
    const run = entry?.run;
    expect(run?.harness.name).toBe('claude-code');
    expect(run?.session_id).toBe(SESSION);
    expect(run?.task.intent).toBe('give the answer a name');
    expect(run?.task.prompt_text).toBeUndefined();
    expect(run?.started_at).toBe(T0.toISOString());
    expect(run?.ended_at).toBe(T2.toISOString());
    expect(run?.tool_calls.map((call) => call.name)).toEqual(['Edit']);
    expect(run?.files_written.map((file) => file.path)).toEqual(['app.ts']);
    expect(run?.env.branch).toBe('main');
  });

  it('pairs the file state before and after the edit', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    const before = sh(root, ['hash-object', 'app.ts']);
    editTurn(root, 'rename it', 'answer', 'theAnswer');
    const after = sh(root, ['hash-object', 'app.ts']);

    seal(openRepo(root), { now: T2 });
    const written = listRuns(openRepo(root))[0]?.run.files_written[0];
    expect(written?.pre_blob_sha).toBe(before);
    expect(written?.post_blob_sha).toBe(after);
    expect(written?.hunks).toEqual([{ old_start: 1, old_len: 1, new_start: 1, new_len: 1 }]);
  });

  it('points a hunk at the line the edit changed', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    const file = join(root, 'app.ts');
    writeFileSync(file, 'one\ntwo\nthree\nfour\n');

    feed(root, { hook_event_name: 'UserPromptSubmit', prompt: 'replace the third line' }, T0);
    feed(root, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } }, T1);
    writeFileSync(file, 'one\ntwo\nTHREE\nthird and a half\nfour\n');
    feed(
      root,
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'three', new_string: 'THREE\nthird and a half' },
        tool_response: {},
      },
      T1,
    );
    feed(root, { hook_event_name: 'Stop' }, T2);

    seal(openRepo(root), { now: T2 });
    const written = listRuns(openRepo(root))[0]?.run.files_written[0];
    expect(written?.hunks).toEqual([{ old_start: 3, old_len: 1, new_start: 3, new_len: 2 }]);
  });

  it('keeps an unfinished turn in the queue', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    feed(root, { hook_event_name: 'UserPromptSubmit', prompt: 'start something' }, T0);
    feed(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }, T1);

    const result = seal(openRepo(root), { now: T2 });
    expect(result.sealed).toBe(0);
    expect(result.pending).toBe(2);
    expect(queue(root)).toHaveLength(2); // the prompt and the Bash call, still waiting
    expect(listRuns(openRepo(root))).toEqual([]);
  });

  it('splits one session into a run per turn', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    feed(root, { hook_event_name: 'UserPromptSubmit', prompt: 'first job' }, T0);
    feed(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {} }, T0);
    feed(root, { hook_event_name: 'UserPromptSubmit', prompt: 'second job' }, T1);
    feed(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {} }, T1);
    feed(root, { hook_event_name: 'Stop' }, T2);

    expect(seal(openRepo(root), { now: T2 }).sealed).toBe(2);
    const intents = listRuns(openRepo(root)).map((entry) => entry.run.task.intent);
    expect(intents).toContain('first job');
    expect(intents).toContain('second job');
  });

  it('never records a file outside the worktree', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    feed(root, { hook_event_name: 'UserPromptSubmit', prompt: 'touch the outside' }, T0);
    feed(root, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/etc/hosts' } }, T1);
    feed(
      root,
      { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/etc/hosts' }, tool_response: {} },
      T1,
    );
    feed(root, { hook_event_name: 'Stop' }, T2);

    seal(openRepo(root), { now: T2 });
    expect(listRuns(openRepo(root))[0]?.run.files_written).toEqual([]);
  });

  it('does nothing at all until the repository is set up', () => {
    const root = makeRepo({ commits: true });
    expect(openCapture(root)).toBeNull();
  });

  it('swallows a payload that makes no sense', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    const context = openCapture(root);
    if (context === null) throw new Error('not set up');
    expect(captureClaudeCode(null, context, T0).events).toEqual([]);
    expect(captureClaudeCode({ hook_event_name: 'PostToolUse' }, context, T0).events).toEqual([]);
    expect(captureClaudeCode({ session_id: SESSION, hook_event_name: 'Nonsense' }, context, T0).events).toEqual([]);
    expect(queue(root)).toEqual([]);
  });

  it('leaves the working tree, the index and HEAD alone', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    const head = sh(root, ['rev-parse', 'HEAD']);
    editTurn(root, 'change one word', 'answer', 'theAnswer');
    sh(root, ['add', 'app.ts']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'the agent edit']);
    const after = sh(root, ['rev-parse', 'HEAD']);

    seal(openRepo(root), { now: T2 });
    expect(sh(root, ['rev-parse', 'HEAD'])).toBe(after);
    expect(after).not.toBe(head);
    expect(sh(root, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(root, STATE_DIR, 'seal.index'))).toBe(false);
  });

  it('sealing again writes nothing new', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    editTurn(root, 'one edit', 'answer', 'theAnswer');
    expect(seal(openRepo(root), { now: T2 }).sealed).toBe(1);
    expect(seal(openRepo(root), { now: T2 }).sealed).toBe(0);
    expect(listRuns(openRepo(root))).toHaveLength(1);
  });

  it('hashes blobs exactly as git does, in both object formats', () => {
    for (const objectFormat of ['sha1', 'sha256'] as const) {
      const root = makeRepo({ commits: true, objectFormat });
      writeFileSync(join(root, 'sample.txt'), 'hello deepblame\n');
      const expected = sh(root, ['hash-object', 'sample.txt']);
      expect(gitBlobOid(Buffer.from('hello deepblame\n'), objectFormat)).toBe(expected);
    }
  });

  it('records against a sha256 repository too', () => {
    const root = makeRepo({ commits: true, objectFormat: 'sha256' });
    init(root, { now: T0 });
    editTurn(root, 'sha256 please', 'answer', 'theAnswer');
    expect(seal(openRepo(root), { now: T2 }).sealed).toBe(1);
    expect(listRuns(openRepo(root))[0]?.run.files_written[0]?.post_blob_sha).toHaveLength(64);
  });
});

describe('cost', () => {
  const MODEL = 'claude-opus-4-5-20260114';

  function transcript(root: string, entries: Record<string, unknown>[]): string {
    const file = join(root, 'transcript.jsonl');
    writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    return file;
  }

  function assistant(at: Date, model: string, usage: Record<string, number>): Record<string, unknown> {
    return { type: 'assistant', timestamp: at.toISOString(), message: { role: 'assistant', model, usage } };
  }

  /** A turn that ran while the transcript was being written. */
  function turnWithTranscript(root: string, file: string): void {
    feed(root, { hook_event_name: 'SessionStart', source: 'startup', transcript_path: file }, T0);
    feed(root, { hook_event_name: 'UserPromptSubmit', prompt: 'make it faster' }, T0);
    feed(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {} }, T1);
    feed(root, { hook_event_name: 'Stop' }, T2);
  }

  it('prices a turn from the usage the harness recorded', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    const file = transcript(root, [
      { type: 'user', timestamp: T0.toISOString() },
      assistant(T1, MODEL, { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 50_000 }),
      assistant(T1, MODEL, { input_tokens: 500, output_tokens: 1000 }),
      // A message from a later turn must not be counted in this one.
      assistant(new Date('2026-09-26T12:00:00.000Z'), MODEL, { input_tokens: 9_999_999, output_tokens: 9_999_999 }),
    ]);
    turnWithTranscript(root, file);

    seal(openRepo(root), { now: T2 });
    const run = listRuns(openRepo(root))[0]?.run;
    expect(run?.model).toEqual({ provider: 'anthropic', name: MODEL, version: null });
    expect(run?.cost?.input_tokens).toBe(1500);
    expect(run?.cost?.output_tokens).toBe(3000);
    expect(run?.cost?.cache_read_tokens).toBe(50_000);
    // 1500 in at $15/M + 3000 out at $75/M + 50k cached reads at $1.50/M.
    expect(run?.cost?.usd).toBeCloseTo(0.0225 + 0.225 + 0.075, 6);
    expect(run?.cost?.source).toBe('rates');
  });

  it('records the tokens but no money when the model has no known rate', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turnWithTranscript(root, transcript(root, [assistant(T1, 'some-new-model-2027', { input_tokens: 10, output_tokens: 20 })]));

    seal(openRepo(root), { now: T2 });
    const run = listRuns(openRepo(root))[0]?.run;
    expect(run?.cost?.input_tokens).toBe(10);
    expect(run?.cost?.usd).toBeNull();
  });

  it('uses a rate the repository wrote into its own config', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    const config = join(root, STATE_DIR, 'config.json');
    const current: Record<string, unknown> = JSON.parse(readFileSync(config, 'utf8'));
    writeFileSync(config, JSON.stringify({ ...current, pricing: { 'some-new-model': { input: 2, output: 10 } } }, null, 2));
    turnWithTranscript(root, transcript(root, [assistant(T1, 'some-new-model-2027', { input_tokens: 1_000_000, output_tokens: 100_000 })]));

    seal(openRepo(root), { now: T2 });
    expect(listRuns(openRepo(root))[0]?.run.cost?.usd).toBeCloseTo(2 + 1, 6);
  });

  it('believes the harness when it reports the money itself', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    const entry = assistant(T1, MODEL, { input_tokens: 10, output_tokens: 10 });
    turnWithTranscript(root, transcript(root, [{ ...entry, costUSD: 0.42 }]));

    seal(openRepo(root), { now: T2 });
    const run = listRuns(openRepo(root))[0]?.run;
    expect(run?.cost?.usd).toBe(0.42);
    expect(run?.cost?.source).toBe('harness');
  });

  it('survives a transcript that is missing, empty or nonsense', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    writeFileSync(join(root, 'broken.jsonl'), 'not json\n{"type":"assistant"}\n\n');
    turnWithTranscript(root, join(root, 'broken.jsonl'));
    expect(seal(openRepo(root), { now: T2 }).sealed).toBe(1);
    expect(listRuns(openRepo(root))[0]?.run.cost).toBeUndefined();

    const other = makeRepo({ commits: true });
    init(other, { now: T0 });
    turnWithTranscript(other, join(other, 'does-not-exist.jsonl'));
    expect(seal(openRepo(other), { now: T2 }).sealed).toBe(1);
    expect(listRuns(openRepo(other))[0]?.run.model).toBeNull();
  });

  it('adds the spend up by model and by agent', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turnWithTranscript(root, transcript(root, [assistant(T1, MODEL, { input_tokens: 1_000_000, output_tokens: 0 })]));
    seal(openRepo(root), { now: T2 });

    const report = cost(root, { now: T2, seal: false });
    expect(report.runs).toBe(1);
    expect(report.totals.usd).toBeCloseTo(15, 6);
    expect(report.byModel[0]?.key).toBe(MODEL);
    expect(report.byAgent[0]?.key).toBe('claude-code');
    // A window that ends before the run started leaves nothing to count.
    expect(cost(root, { now: new Date('2026-10-30T00:00:00.000Z'), days: 1, seal: false }).runs).toBe(0);
  });
});

describe('hooks', () => {
  it('installs into the project settings and leaves the rest of the file alone', () => {
    const root = makeRepo({ commits: true });
    writeFileSync(join(root, '.claude-settings-seed'), '');
    const file = join(root, '.claude', 'settings.json');
    installClaudeCode(root, 'deepblame capture --agent claude-code');
    const settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    expect(Object.keys(settings.hooks)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ]);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain('deepblame capture');
  });

  it('keeps the settings a team already had', () => {
    const root = makeRepo({ commits: true });
    const file = join(root, '.claude', 'settings.json');
    writeFileSync(
      join(root, '.claude-placeholder'),
      '', // keeps the repo from being empty; the settings file is written below
    );
    const original = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    };
    installClaudeCode(root, 'deepblame capture --agent claude-code');
    writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`);
    installClaudeCode(root, 'deepblame capture --agent claude-code');

    const settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    expect(settings.permissions.allow).toEqual(['Bash(npm test)']);
    expect(settings.hooks.PostToolUse[0].hooks.map((hook: { command: string }) => hook.command)).toEqual([
      'echo mine',
      'deepblame capture --agent claude-code',
    ]);

    uninstallClaudeCode(root);
    const after = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    expect(after.permissions.allow).toEqual(['Bash(npm test)']);
    expect(after.hooks.PostToolUse[0].hooks).toEqual([{ type: 'command', command: 'echo mine' }]);
  });

  it('recognises its own hook however the command is spelled', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    for (const command of [
      'deepblame-capture',
      'deepblame capture --agent claude-code',
      'node packages/cli/dist/capture.cjs',
      '"/opt/node/bin/node" "/usr/lib/node_modules/deepblame/dist/capture.mjs"',
    ]) {
      installClaudeCode(root, command, { local: true });
      expect(status(root, { env: { PATH: '' } }).recording).toBe(true);
      uninstallClaudeCode(root, { local: true });
      expect(status(root, { env: { PATH: '' } }).recording).toBe(false);
    }
  });

  it('turns recording on in status once a hook is installed', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    expect(status(root, { env: { PATH: '' } }).recording).toBe(false);
    installClaudeCode(root, 'deepblame capture --agent claude-code', { local: true });
    const report = status(root, { env: { PATH: '' } });
    expect(report.recording).toBe(true);
    expect(hooksInstalled(root).filter((hook) => hook.installed)).toHaveLength(1);
  });

  it('installs on request during init and can be kept out of it', () => {
    const root = makeRepo({ commits: true });
    const withHooks = init(root, { now: T0, env: { PATH: '' }, hookCommand: 'deepblame capture --agent claude-code' });
    // No Claude Code in this repository yet, so nothing was touched.
    expect(withHooks.hooks).toEqual([]);

    writeFileSync(join(root, 'CLAUDE.md'), '# project\n');
    const detected = init(root, { now: T0, env: { PATH: '' }, hookCommand: 'deepblame capture --agent claude-code' });
    expect(detected.hooks[0]?.changed).toBe(true);
    expect(status(root, { env: { PATH: '' } }).recording).toBe(true);

    uninstallClaudeCode(root);
    const skipped = init(root, {
      now: T0,
      env: { PATH: '' },
      hookCommand: 'deepblame capture --agent claude-code',
      noHooks: true,
    });
    expect(skipped.hooks).toEqual([]);
  });
});
