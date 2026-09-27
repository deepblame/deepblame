import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blameFile } from '../src/blame';
import { appendEvents, captureClaudeCode, openCapture } from '../src/capture';
import { init } from '../src/commands';
import { collect } from '../src/gc';
import { openRepo } from '../src/repo';
import { planRevert } from '../src/revert';
import { listRuns } from '../src/runs';
import { seal } from '../src/seal';
import { makeRepo, sh } from './helpers';

/**
 * Pruning drops what a run left behind, never the run. After it, the ledger
 * still says who wrote what and why; it just can no longer prove it or put it
 * back, and it says so rather than pretending otherwise.
 */

const SESSION = '8c7d6e5f-4a3b-4291-8071-2f3e4d5c6b7a';
const LONG_AGO = new Date('2026-01-10T09:00:00.000Z');
const RECENTLY = new Date('2026-09-26T09:00:00.000Z');
const NOW = new Date('2026-09-27T09:00:00.000Z');

function turn(root: string, file: string, from: string, to: string, at: Date, prompt: string): void {
  const path = join(root, file);
  const stop = new Date(at.getTime() + 5000);
  const feed = (event: Record<string, unknown>, when: Date): void => {
    const context = openCapture(root);
    if (context === null) throw new Error('not set up');
    appendEvents(context, captureClaudeCode({ session_id: SESSION, cwd: root, ...event }, context, when).events);
  };
  feed({ hook_event_name: 'UserPromptSubmit', prompt }, at);
  feed({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path } }, at);
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  feed(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path, old_string: from, new_string: to },
      tool_response: {},
    },
    at,
  );
  feed({ hook_event_name: 'Stop' }, stop);
  seal(openRepo(root), { now: stop });
}

function setup(): { root: string; file: string } {
  const root = makeRepo({ commits: true });
  init(root, { now: LONG_AGO });
  const file = 'app.ts';
  writeFileSync(join(root, file), 'one\ntwo\nthree\nfour\n');
  sh(root, ['add', file]);
  sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'base']);
  turn(root, file, 'two', 'TWO', LONG_AGO, 'an old turn');
  turn(root, file, 'four', 'FOUR', RECENTLY, 'a recent turn');
  return { root, file };
}

describe('ageing contents out of the ledger', () => {
  it('reports what it would drop, and writes nothing', () => {
    const { root } = setup();
    const repo = openRepo(root);
    const plan = collect(repo, { days: 90, now: NOW });

    expect(plan.runs).toBe(1);
    expect(plan.kept).toBe(1);
    expect(plan.blobs).toBeGreaterThan(0);
    expect(plan.bytes).toBeGreaterThan(0);
    expect(plan.applied).toBe(false);
    // Still there: nothing was asked for.
    expect(collect(repo, { days: 90, now: NOW }).blobs).toBe(plan.blobs);
  });

  it('lets go of the old contents and keeps every run record', () => {
    const { root } = setup();
    const before = listRuns(openRepo(root)).map((entry) => entry.run.task.intent);
    const dropped = collect(openRepo(root), { days: 90, apply: true, now: NOW });

    const after = listRuns(openRepo(root));
    expect(after.map((entry) => entry.run.task.intent)).toEqual(before);
    expect(after).toHaveLength(2);
    expect(dropped.blobs).toBeGreaterThan(0);
    // One commit, no parent: an append-only chain would keep every old tree,
    // and with it every blob this was meant to release.
    expect(sh(root, ['rev-list', '--count', 'refs/deepblame/ledger'])).toBe('1');
  });

  it('after git collects, blame says unverifiable and revert refuses', () => {
    // A state nothing else refers to: an old turn's result, overwritten by a
    // person and never committed, so the ledger is the only place it lived.
    const root = makeRepo({ commits: true });
    init(root, { now: LONG_AGO });
    writeFileSync(join(root, 'old.ts'), 'alpha\nbeta\n');
    writeFileSync(join(root, 'app.ts'), 'one\ntwo\n');
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'base']);
    turn(root, 'old.ts', 'beta', 'BETA-BY-THE-AGENT', LONG_AGO, 'an old turn');
    turn(root, 'app.ts', 'two', 'TWO', RECENTLY, 'a recent turn');
    writeFileSync(join(root, 'old.ts'), 'alpha\nmine now\n');

    const old = listRuns(openRepo(root)).find((entry) => entry.run.task.intent === 'an old turn');
    if (old === undefined) throw new Error('expected the old run');

    collect(openRepo(root), { days: 90, apply: true, now: NOW });
    sh(root, ['gc', '--prune=now', '--quiet']);

    const result = blameFile(openRepo(root), 'old.ts');
    expect(result.runs).toBe(1);
    expect(result.unverifiable).toBe(1);
    expect(result.spans.filter((span) => span.run !== null)).toHaveLength(0);

    const plan = planRevert(openRepo(root), { runs: [old.run.run_id] });
    expect(plan.files[0]?.status).toBe('unverifiable');
    expect(plan.files[0]?.write).toBeNull();

    // The recent run is untouched.
    expect(planRevert(openRepo(root), { agent: 'claude-code', hours: 48, now: NOW }).files[0]?.status).toBe('clean');
  });

  it('keeps a state that a newer run still relies on', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: LONG_AGO });
    writeFileSync(join(root, 'app.ts'), 'one\ntwo\n');
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'base']);
    // The old run's post-image is the new run's pre-image, so it has to stay.
    turn(root, 'app.ts', 'two', 'TWO', LONG_AGO, 'old');
    turn(root, 'app.ts', 'TWO', 'THREE', RECENTLY, 'new');

    const repo = openRepo(root);
    const shared = listRuns(repo).find((e) => e.run.task.intent === 'old')?.run.files_written[0]?.post_blob_sha;
    expect(shared).toBeTruthy();
    collect(repo, { days: 90, apply: true, now: NOW });
    sh(root, ['gc', '--prune=now', '--quiet']);
    // The newer run can still be reverted, which needs that shared state.
    const plan = planRevert(openRepo(root), { agent: 'claude-code', hours: 48, now: NOW });
    expect(plan.files[0]?.status).not.toBe('unverifiable');
  });

  it('does nothing when every run is recent', () => {
    const { root } = setup();
    const plan = collect(openRepo(root), { days: 3650, now: NOW });
    expect(plan.runs).toBe(0);
    expect(plan.blobs).toBe(0);
    expect(plan.applied).toBe(false);
  });
});
