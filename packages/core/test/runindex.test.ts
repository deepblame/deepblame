import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_INDEX_FILE, STATE_DIR } from '@deepblame/protocol';
import { describe, expect, it } from 'vitest';
import { appendEvents, captureClaudeCode, openCapture } from '../src/capture';
import { init } from '../src/commands';
import { openRepo } from '../src/repo';
import { findRun, indexedRuns, listRuns, runsMatching, runsTouching } from '../src/runs';
import { seal } from '../src/seal';
import { makeRepo } from './helpers';

/**
 * The index is a cache and has to behave like one: deleting it changes no
 * answer, and a damaged one is thrown away rather than believed.
 */

const SESSION = '2b3c4d5e-6f70-4812-9345-67890abcdef0';

function turn(root: string, file: string, text: string, prompt: string, at: Date): void {
  const path = join(root, file);
  const stop = new Date(at.getTime() + 5000);
  const feed = (event: Record<string, unknown>, now: Date): void => {
    const context = openCapture(root);
    if (context === null) throw new Error('not set up');
    appendEvents(context, captureClaudeCode({ session_id: SESSION, cwd: root, ...event }, context, now).events);
  };
  feed({ hook_event_name: 'UserPromptSubmit', prompt }, at);
  feed({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path } }, at);
  writeFileSync(path, text);
  feed({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path }, tool_response: {} }, at);
  feed({ hook_event_name: 'Stop' }, stop);
  seal(openRepo(root), { now: stop });
}

function setup(): string {
  const root = makeRepo({ commits: true });
  init(root, { now: new Date('2026-09-27T09:00:00.000Z') });
  turn(root, 'a.ts', 'one\n', 'first', new Date('2026-09-27T09:00:00.000Z'));
  turn(root, 'b.ts', 'two\n', 'second', new Date('2026-09-27T10:00:00.000Z'));
  turn(root, 'a.ts', 'three\n', 'third', new Date('2026-09-27T11:00:00.000Z'));
  return root;
}

function indexFile(root: string): string {
  return join(root, STATE_DIR, RUN_INDEX_FILE);
}

describe('the run index', () => {
  it('is written on the first read and lists runs newest first', () => {
    const root = setup();
    const repo = openRepo(root);
    expect(existsSync(indexFile(root))).toBe(false);

    const runs = indexedRuns(repo);
    expect(existsSync(indexFile(root))).toBe(true);
    expect(runs.map((run) => run.paths[0])).toEqual(['a.ts', 'b.ts', 'a.ts']);
    expect(runs[0]?.at).toBe('2026-09-27T11:00:00.000Z');
  });

  it('gives the same answers with it and without it', () => {
    const root = setup();
    const repo = openRepo(root);
    const withIndex = listRuns(repo).map((entry) => entry.run.run_id);
    rmSync(indexFile(root), { force: true });
    const rebuilt = listRuns(repo).map((entry) => entry.run.run_id);
    expect(rebuilt).toEqual(withIndex);
  });

  it('picks up a new run without rebuilding from scratch', () => {
    const root = setup();
    const repo = openRepo(root);
    expect(indexedRuns(repo)).toHaveLength(3);
    const before = readFileSync(indexFile(root), 'utf8');

    turn(root, 'c.ts', 'four\n', 'fourth', new Date('2026-09-27T12:00:00.000Z'));
    const after = indexedRuns(repo);
    expect(after).toHaveLength(4);
    expect(after[0]?.paths).toEqual(['c.ts']);
    // Appended, not rewritten: the old text is still the start of the file.
    expect(readFileSync(indexFile(root), 'utf8').startsWith(before)).toBe(true);
  });

  it('throws away an index it cannot read', () => {
    const root = setup();
    const repo = openRepo(root);
    expect(indexedRuns(repo)).toHaveLength(3);
    writeFileSync(indexFile(root), 'this is not the index you are looking for\n');
    expect(indexedRuns(repo)).toHaveLength(3);
  });

  it('ignores entries from a write that never finished', () => {
    const root = setup();
    const repo = openRepo(root);
    const runs = indexedRuns(repo);
    expect(runs).toHaveLength(3);
    // A crash between appending an entry and recording the new head.
    appendFileSync(indexFile(root), `${JSON.stringify({ ...runs[0], id: 'torn', at: '2030-01-01T00:00:00.000Z' })}\n`);
    expect(indexedRuns(repo).some((run) => run.id === 'torn')).toBe(false);
  });

  it('finds only the runs that wrote one file', () => {
    const root = setup();
    const repo = openRepo(root);
    const onA = runsTouching(repo, new Set(['a.ts']));
    expect(onA).toHaveLength(2);
    expect(onA.map((entry) => entry.run.task.intent)).toEqual(['third', 'first']);
  });

  it('filters by agent, id prefix and time', () => {
    const root = setup();
    const repo = openRepo(root);
    expect(runsMatching(repo, { agent: 'claude-code' })).toHaveLength(3);
    expect(runsMatching(repo, { agent: 'git' })).toHaveLength(0);
    expect(runsMatching(repo, { since: new Date('2026-09-27T10:30:00.000Z') })).toHaveLength(1);

    const id = indexedRuns(repo)[0]?.id ?? '';
    expect(runsMatching(repo, { ids: [id.replace(/-/g, '').slice(0, 7)] })).toHaveLength(1);
    expect(findRun(repo, id.slice(0, 8))?.run.run_id).toBe(id);
  });
});
