import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvents, captureClaudeCode, openCapture } from '../src/capture';
import { init, recordCommit, revert } from '../src/commands';
import { openRepo } from '../src/repo';
import { applyRevert, planRevert } from '../src/revert';
import { seal } from '../src/seal';
import { makeRepo, sh } from './helpers';

const SESSION = '5f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const START = new Date('2026-09-27T09:00:00.000Z');
const STOP = new Date('2026-09-27T09:00:10.000Z');

function feed(root: string, event: Record<string, unknown>, now: Date): void {
  const context = openCapture(root);
  if (context === null) throw new Error('not set up');
  const result = captureClaudeCode({ session_id: SESSION, cwd: root, ...event }, context, now);
  appendEvents(context, result.events);
}

/** One agent turn that leaves `file` holding `after`. */
function turn(root: string, file: string, after: string | null, prompt = 'do the thing', at = START): void {
  const path = join(root, file);
  const stop = new Date(at.getTime() + 10_000);
  feed(root, { hook_event_name: 'UserPromptSubmit', prompt }, at);
  feed(root, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path } }, at);
  if (after === null) rmSync(path, { force: true });
  else writeFileSync(path, after);
  feed(
    root,
    { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path }, tool_response: {} },
    at,
  );
  feed(root, { hook_event_name: 'Stop' }, stop);
  seal(openRepo(root), { now: stop });
}

function setup(contents = 'one\ntwo\nthree\nfour\n'): { root: string; file: string } {
  const root = makeRepo({ commits: true });
  init(root, { now: START });
  const file = 'app.ts';
  writeFileSync(join(root, file), contents);
  sh(root, ['add', file]);
  sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'base']);
  return { root, file };
}

function read(root: string, file: string): string {
  return readFileSync(join(root, file), 'utf8');
}

describe('revert', () => {
  it('puts the file back exactly when nothing else has touched it', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nAGENT\nfour\n');

    const repo = openRepo(root);
    const plan = planRevert(repo, { agent: 'claude-code' });
    expect(plan.runs).toHaveLength(1);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.status).toBe('clean');
    expect(plan.files[0]?.write?.kind).toBe('restore');
    // A plan is only a plan.
    expect(read(root, file)).toContain('AGENT');

    applyRevert(repo, plan);
    expect(read(root, file)).toBe('one\ntwo\nthree\nfour\n');
  });

  it('keeps what somebody wrote after the agent', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nAGENT\nfour\n');
    // A human adds a line at the top, nowhere near the agent's line.
    writeFileSync(join(root, file), `zero\n${read(root, file)}`);

    const repo = openRepo(root);
    const plan = planRevert(repo, { agent: 'claude-code' });
    expect(plan.files[0]?.status).toBe('clean');
    expect(plan.files[0]?.write?.kind).toBe('merge');

    applyRevert(repo, plan);
    expect(read(root, file)).toBe('zero\none\ntwo\nthree\nfour\n');
  });

  it('stops at a conflict instead of choosing for you', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nAGENT\nfour\n');
    // Someone edits the very line the agent wrote.
    writeFileSync(join(root, file), read(root, file).replace('AGENT', 'MINE, ACTUALLY'));

    const repo = openRepo(root);
    const done = applyRevert(repo, planRevert(repo, { agent: 'claude-code' }));
    expect(done.files[0]?.status).toBe('conflicted');
    expect(done.written).toHaveLength(0);
    expect(done.skipped).toEqual([file]);
    expect(read(root, file)).toContain('MINE, ACTUALLY');
  });

  it('writes the conflict out with markers when asked', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nAGENT\nfour\n');
    writeFileSync(join(root, file), read(root, file).replace('AGENT', 'MINE, ACTUALLY'));

    const repo = openRepo(root);
    const done = applyRevert(repo, planRevert(repo, { agent: 'claude-code' }), { conflicts: true });
    expect(done.written).toEqual([file]);
    const after = read(root, file);
    expect(after).toContain('<<<<<<<');
    expect(after).toContain('MINE, ACTUALLY');
    expect(after).toContain('three');
  });

  it('removes a file the agent created', () => {
    const { root } = setup();
    turn(root, 'new.ts', 'export const fresh = true;\n');

    const repo = openRepo(root);
    const plan = planRevert(repo, { agent: 'claude-code' });
    expect(plan.files[0]?.write?.kind).toBe('delete');
    expect(plan.files[0]?.status).toBe('clean');

    applyRevert(repo, plan);
    expect(existsSync(join(root, 'new.ts'))).toBe(false);
  });

  it('never deletes a file the agent created but you have edited since', () => {
    const { root } = setup();
    turn(root, 'new.ts', 'export const fresh = true;\n');
    writeFileSync(join(root, 'new.ts'), 'export const fresh = true;\nexport const mine = 1;\n');

    const repo = openRepo(root);
    // Even with --conflicts: there is no such thing as half a deleted file.
    const done = applyRevert(repo, planRevert(repo, { agent: 'claude-code' }), { conflicts: true });
    expect(done.files[0]?.status).toBe('conflicted');
    expect(done.skipped).toEqual(['new.ts']);
    expect(existsSync(join(root, 'new.ts'))).toBe(true);
  });

  it('brings back a file the agent deleted', () => {
    const { root, file } = setup();
    turn(root, file, null);
    expect(existsSync(join(root, file))).toBe(false);

    const repo = openRepo(root);
    applyRevert(repo, planRevert(repo, { agent: 'claude-code' }));
    expect(read(root, file)).toBe('one\ntwo\nthree\nfour\n');
  });

  it('unwinds several turns on one file, newest first', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nFIRST\nfour\n', 'first pass', START);
    turn(root, file, 'one\ntwo\nFIRST\nSECOND\n', 'second pass', new Date('2026-09-27T10:00:00.000Z'));

    const repo = openRepo(root);
    const plan = planRevert(repo, { agent: 'claude-code' });
    expect(plan.runs).toHaveLength(2);
    expect(plan.runs[0]?.task.intent).toBe('second pass');

    applyRevert(repo, plan);
    expect(read(root, file)).toBe('one\ntwo\nthree\nfour\n');
  });

  it('undoes one run without touching the other', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nFIRST\nfour\n', 'first pass', START);
    const second = new Date('2026-09-27T10:00:00.000Z');
    turn(root, file, 'one\ntwo\nFIRST\nSECOND\n', 'second pass', second);

    const repo = openRepo(root);
    const runs = planRevert(repo, { agent: 'claude-code' }).runs;
    const older = runs[1];
    if (older === undefined) throw new Error('expected two runs');

    applyRevert(repo, planRevert(repo, { runs: [older.run_id] }));
    // The older turn's line is gone; the newer turn's line stays.
    expect(read(root, file)).toBe('one\ntwo\nthree\nSECOND\n');
  });

  it('leaves another agent alone', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nAGENT\nfour\n');
    // A commit by someone else, recorded through the git fallback.
    writeFileSync(join(root, 'notes.md'), 'by hand\n');
    sh(root, ['add', 'notes.md']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'notes']);
    recordCommit(root, { now: STOP });

    const repo = openRepo(root);
    expect(planRevert(repo, {}).runs).toHaveLength(2);
    const plan = planRevert(repo, { agent: 'claude-code' });
    expect(plan.runs).toHaveLength(1);
    expect(plan.files.map((entry) => entry.path)).toEqual([file]);

    applyRevert(repo, plan);
    expect(read(root, 'notes.md')).toBe('by hand\n');
  });

  it('takes a run id prefix, like git does', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nAGENT\nfour\n');
    const repo = openRepo(root);
    const id = planRevert(repo, { agent: 'claude-code' }).runs[0]?.run_id ?? '';

    const plan = planRevert(repo, { runs: [id.replace(/-/g, '').slice(0, 7)] });
    expect(plan.runs).toHaveLength(1);
  });

  it('only goes back as far as --hours says', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nAGENT\nfour\n', 'old news', new Date('2026-09-26T09:00:00.000Z'));

    const repo = openRepo(root);
    const now = new Date('2026-09-27T09:00:00.000Z');
    expect(planRevert(repo, { agent: 'claude-code', hours: 2, now }).runs).toHaveLength(0);
    expect(planRevert(repo, { agent: 'claude-code', hours: 48, now }).runs).toHaveLength(1);
  });

  it('says nothing to do when the file is already back', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nAGENT\nfour\n');
    writeFileSync(join(root, file), 'one\ntwo\nthree\nfour\n');

    const plan = planRevert(openRepo(root), { agent: 'claude-code' });
    expect(plan.files[0]?.status).toBe('unchanged');
    expect(plan.files[0]?.write).toBeNull();
  });

  it('refuses to guess when the content is no longer in the repository', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nAGENT\nfour\n');
    const repo = openRepo(root);
    const pre = planRevert(repo, { agent: 'claude-code' }).runs[0]?.files_written[0]?.pre_blob_sha;
    if (pre === undefined || pre === null) throw new Error('expected a pre-image');

    // Take the object away, the way an aggressive gc or a bad clone would.
    rmSync(join(root, '.git', 'objects', pre.slice(0, 2), pre.slice(2)), { force: true });

    const plan = planRevert(openRepo(root), { agent: 'claude-code' });
    expect(plan.files[0]?.status).toBe('unverifiable');
    expect(plan.files[0]?.write).toBeNull();
    applyRevert(openRepo(root), plan);
    expect(read(root, file)).toContain('AGENT');
  });

  it('reports through the command layer without writing anything', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nAGENT\nfour\n');

    const report = revert(root, { agent: 'claude-code' });
    expect(report.initialized).toBe(true);
    expect(report.plan?.applied).toBe(false);
    expect(read(root, file)).toContain('AGENT');

    const applied = revert(root, { agent: 'claude-code', apply: true });
    expect(applied.plan?.written).toEqual([file]);
    expect(read(root, file)).toBe('one\ntwo\nthree\nfour\n');
  });

  it('matches nothing rather than everything when the id is unknown', () => {
    const { root, file } = setup();
    turn(root, file, 'one\ntwo\nAGENT\nfour\n');
    const report = revert(root, { runs: ['ffffff0'], apply: true });
    expect(report.plan?.runs).toHaveLength(0);
    expect(read(root, file)).toContain('AGENT');
  });
});
