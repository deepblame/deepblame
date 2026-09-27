import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blameFile } from '../src/blame';
import { appendEvents, captureCursor, openCapture } from '../src/capture';
import { hooks, init } from '../src/commands';
import { cursorHooksInstalled, cursorHooksPath } from '../src/hooks';
import { openRepo } from '../src/repo';
import { applyRevert, planRevert } from '../src/revert';
import { listRuns } from '../src/runs';
import { seal } from '../src/seal';
import { makeRepo, sh } from './helpers';

/**
 * Cursor reports as much as Claude Code does, with one difference: it has no
 * hook before an edit, so the state the file was in beforehand is worked out
 * from the strings the edit replaced.
 */

const CONVERSATION = 'conv_9fJ2kQ';
const START = new Date('2026-09-27T09:00:00.000Z');

function hook(root: string, event: Record<string, unknown>, now = START): void {
  const context = openCapture(root);
  if (context === null) throw new Error('not set up');
  const payload = { conversation_id: CONVERSATION, workspace_roots: [root], cursor_version: '1.7.0', ...event };
  appendEvents(context, captureCursor(payload, context, now).events);
}

const SOURCE = 'function go() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n';

function setup(): { root: string; file: string } {
  const root = makeRepo({ commits: true });
  init(root, { now: START });
  const file = 'go.js';
  writeFileSync(join(root, file), SOURCE);
  sh(root, ['add', file]);
  sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'base']);
  return { root, file };
}

/** One Cursor turn: prompt, edit, stop. */
function turn(root: string, file: string, from: string, to: string, prompt = 'bump the constant'): void {
  const path = join(root, file);
  hook(root, { hook_event_name: 'beforeSubmitPrompt', prompt });
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  hook(root, {
    hook_event_name: 'afterFileEdit',
    file_path: path,
    edits: [{ old_string: from, new_string: to }],
  });
  const stop = new Date(START.getTime() + 6000);
  hook(root, { hook_event_name: 'stop', status: 'completed' }, stop);
  seal(openRepo(root), { now: stop });
}

describe('recording Cursor', () => {
  it('turns one turn into one run, with the prompt', () => {
    const { root, file } = setup();
    turn(root, file, 'const b = 2;', 'const b = 22;');

    const runs = listRuns(openRepo(root));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.run.harness.name).toBe('cursor');
    expect(runs[0]?.run.task.intent).toBe('bump the constant');
    expect(runs[0]?.run.files_written.map((w) => w.path)).toEqual([file]);
  });

  it('works out the state before the edit from the strings it replaced', () => {
    const { root, file } = setup();
    turn(root, file, 'const b = 2;', 'const b = 22;');

    const written = listRuns(openRepo(root))[0]?.run.files_written[0];
    expect(written?.pre_blob_sha).not.toBeNull();
    expect(written?.post_blob_sha).not.toBeNull();
    // The reconstructed pre-image is the committed file, byte for byte.
    const base = sh(root, ['rev-parse', 'HEAD:go.js']);
    expect(written?.pre_blob_sha).toBe(base);
  });

  it('blames the line it wrote', () => {
    const { root, file } = setup();
    turn(root, file, 'const b = 2;', 'const b = 22;');

    const claimed = blameFile(openRepo(root), file).spans.filter((span) => span.run !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.from).toBe(3);
    expect(claimed[0]?.run?.harness.name).toBe('cursor');
  });

  it('can be reverted, keeping what a person wrote afterwards', () => {
    const { root, file } = setup();
    turn(root, file, 'const b = 2;', 'const b = 22;');
    writeFileSync(join(root, file), `${readFileSync(join(root, file), 'utf8')}// mine\n`);

    const repo = openRepo(root);
    applyRevert(repo, planRevert(repo, { agent: 'cursor' }));
    expect(readFileSync(join(root, file), 'utf8')).toBe(`${SOURCE}// mine\n`);
  });

  it('records several edits in one turn', () => {
    const { root, file } = setup();
    const path = join(root, file);
    hook(root, { hook_event_name: 'beforeSubmitPrompt', prompt: 'rename both' });
    writeFileSync(path, readFileSync(path, 'utf8').replace('const a = 1;', 'const alpha = 1;'));
    hook(root, {
      hook_event_name: 'afterFileEdit',
      file_path: path,
      edits: [{ old_string: 'const a = 1;', new_string: 'const alpha = 1;' }],
    });
    writeFileSync(path, readFileSync(path, 'utf8').replace('const b = 2;', 'const beta = 2;'));
    hook(root, {
      hook_event_name: 'afterFileEdit',
      file_path: path,
      edits: [{ old_string: 'const b = 2;', new_string: 'const beta = 2;' }],
    });
    const stop = new Date(START.getTime() + 6000);
    hook(root, { hook_event_name: 'stop' }, stop);
    seal(openRepo(root), { now: stop });

    const run = listRuns(openRepo(root))[0]?.run;
    expect(run?.files_written).toHaveLength(1);
    const repo = openRepo(root);
    applyRevert(repo, planRevert(repo, { agent: 'cursor' }));
    expect(readFileSync(path, 'utf8')).toBe(SOURCE);
  });

  it('records a read', () => {
    const { root, file } = setup();
    hook(root, { hook_event_name: 'beforeSubmitPrompt', prompt: 'have a look' });
    hook(root, { hook_event_name: 'beforeReadFile', file_path: join(root, file) });
    const stop = new Date(START.getTime() + 2000);
    hook(root, { hook_event_name: 'stop' }, stop);
    seal(openRepo(root), { now: stop });

    expect(listRuns(openRepo(root))[0]?.run.files_read.map((r) => r.path)).toEqual([file]);
  });

  it('refuses to invent a pre-image when the edit cannot be located', () => {
    const { root, file } = setup();
    const context = openCapture(root);
    if (context === null) throw new Error('not set up');
    const result = captureCursor(
      {
        conversation_id: CONVERSATION,
        hook_event_name: 'afterFileEdit',
        file_path: join(root, file),
        edits: [{ old_string: 'nothing', new_string: 'not in this file either' }],
      },
      context,
      START,
    );
    const pre = result.events.find((event) => event.k === 'write-pre');
    expect(pre?.k === 'write-pre' ? pre.blob : 'missing').toBeNull();
  });

  it('ignores a payload with no conversation id', () => {
    const { root } = setup();
    const context = openCapture(root);
    if (context === null) throw new Error('not set up');
    expect(captureCursor({ hook_event_name: 'stop' }, context, START).events).toHaveLength(0);
  });

  it('closes the turn on stop and on session end', () => {
    const { root } = setup();
    const context = openCapture(root);
    if (context === null) throw new Error('not set up');
    const of = (name: string) =>
      captureCursor({ conversation_id: CONVERSATION, hook_event_name: name }, context, START).seal;
    expect(of('stop')).toBe(true);
    expect(of('sessionEnd')).toBe(true);
    expect(of('beforeSubmitPrompt')).toBe(false);
  });
});

describe('Cursor hook installation', () => {
  it('writes the events Cursor knows, and takes them back out', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: START });
    expect(cursorHooksInstalled(root)).toBe(false);

    hooks(root, 'install', { agent: 'cursor', cursorCommand: 'deepblame-capture --agent cursor' });
    const file = cursorHooksPath(root);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.version).toBe(1);
    expect(Object.keys(written.hooks).sort()).toEqual(
      ['afterFileEdit', 'beforeReadFile', 'beforeSubmitPrompt', 'sessionStart', 'stop'].sort(),
    );
    expect(written.hooks.afterFileEdit[0].command).toBe('deepblame-capture --agent cursor');
    expect(cursorHooksInstalled(root)).toBe(true);

    // Installing twice changes nothing.
    expect(hooks(root, 'install', { agent: 'cursor', cursorCommand: 'deepblame-capture --agent cursor' }).changes[0]?.changed).toBe(false);

    hooks(root, 'uninstall', {});
    expect(existsSync(file)).toBe(false);
  });

  it('leaves somebody else\'s Cursor hooks alone', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: START });
    const file = cursorHooksPath(root);
    hooks(root, 'install', { agent: 'cursor', cursorCommand: 'deepblame-capture --agent cursor' });

    const settings = JSON.parse(readFileSync(file, 'utf8'));
    settings.hooks.afterFileEdit.push({ command: './scripts/lint.sh' });
    settings.hooks.beforeShellExecution = [{ command: './scripts/audit.sh' }];
    writeFileSync(file, JSON.stringify(settings, null, 2));

    hooks(root, 'uninstall', {});
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.hooks.afterFileEdit).toEqual([{ command: './scripts/lint.sh' }]);
    expect(after.hooks.beforeShellExecution).toEqual([{ command: './scripts/audit.sh' }]);
    expect(after.hooks.stop).toBeUndefined();
  });
});
