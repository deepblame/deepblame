import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blameFile } from '../src/blame';
import { diagnose } from '../src/doctor';
import { appendEvents, captureClaudeCode, openCapture } from '../src/capture';
import { init } from '../src/commands';
import { openRepo } from '../src/repo';
import { reportRange } from '../src/report';
import { applyRevert, planRevert } from '../src/revert';
import { listRuns } from '../src/runs';
import { seal } from '../src/seal';
import { makeRepo, sh } from './helpers';

/**
 * The one promise: never claim a line it cannot prove.
 *
 * These exist because the tool broke that promise for the commonest case there
 * is. An agent that rewrites a file — `Write`, or any editor that applies a
 * model's answer as a new version of the file — reports no line ranges at all,
 * and the sealer used to fill that in with "the whole file". Rewrite ten lines
 * to change one and the ledger said the agent wrote ten. Rewrite a file and
 * change nothing and it still said ten.
 *
 * The evidence was in the ledger the whole time: the file before and the file
 * after, both stored. `revert` read them and offered to put one line back
 * while `blame` said the agent wrote all ten — the two halves of one tool
 * disagreeing in front of the user. Found by stress-testing the published
 * package rather than by any test here, which is why these are blunt.
 */

const SESSION = '3f2a1b0c-9d8e-4f6a-8b7c-1d2e3f4a5b6c';
const T0 = new Date('2026-10-02T09:00:00.000Z');
const T1 = new Date('2026-10-02T09:00:04.000Z');
const T2 = new Date('2026-10-02T09:00:08.000Z');

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join('');

function feed(root: string, event: Record<string, unknown>, now: Date): void {
  const context = openCapture(root);
  if (context === null) throw new Error('not set up');
  const result = captureClaudeCode({ session_id: SESSION, cwd: root, ...event }, context, now);
  appendEvents(context, result.events);
}

/** A turn that replaces the whole file, the way `Write` does. */
function rewrite(root: string, prompt: string, path: string, content: string): void {
  const file = join(root, path);
  feed(root, { hook_event_name: 'UserPromptSubmit', prompt }, T0);
  feed(root, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file } }, T1);
  writeFileSync(file, content);
  feed(
    root,
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: file, content },
      tool_response: { filePath: file },
    },
    T1,
  );
  feed(root, { hook_event_name: 'Stop', stop_hook_active: false }, T2);
}

function tenLineRepo(): string {
  const root = makeRepo();
  writeFileSync(join(root, 'a.txt'), TEN);
  sh(root, ['add', 'a.txt']);
  sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'ten lines by hand']);
  init(root, { now: T0 });
  return root;
}

function claimedLines(root: string, path: string): number[] {
  const result = blameFile(openRepo(root), path);
  const lines: number[] = [];
  for (const span of result.spans) {
    if (span.run === null) continue;
    for (let line = span.from; line <= span.to; line += 1) lines.push(line);
  }
  return lines;
}

describe('a whole-file rewrite is credited with what it changed, not with the file', () => {
  it('claims one line when a ten-line rewrite changed one line', () => {
    const root = tenLineRepo();
    rewrite(root, 'rename line five', 'a.txt', TEN.replace('line 5\n', 'line FIVE\n'));
    seal(openRepo(root), { now: T2 });

    expect(claimedLines(root, 'a.txt')).toEqual([5]);
  });

  it('leaves the other nine lines to whoever wrote them', () => {
    const root = tenLineRepo();
    rewrite(root, 'rename line five', 'a.txt', TEN.replace('line 5\n', 'line FIVE\n'));
    seal(openRepo(root), { now: T2 });

    const unclaimed = blameFile(openRepo(root), 'a.txt')
      .spans.filter((span) => span.run === null)
      .reduce((total, span) => total + (span.to - span.from + 1), 0);
    expect(unclaimed).toBe(9);
  });

  it('claims nothing when the rewrite changed nothing at all', () => {
    const root = tenLineRepo();
    rewrite(root, 'tidy it up', 'a.txt', TEN);
    seal(openRepo(root), { now: T2 });

    expect(claimedLines(root, 'a.txt')).toEqual([]);
    const [entry] = listRuns(openRepo(root));
    expect(entry?.run.files_written[0]?.hunks).toEqual([]);
  });

  it('still claims the whole of a file it created', () => {
    const root = tenLineRepo();
    rewrite(root, 'add a new file', 'new.txt', 'one\ntwo\nthree\n');
    seal(openRepo(root), { now: T2 });

    expect(claimedLines(root, 'new.txt')).toEqual([1, 2, 3]);
    expect(listRuns(openRepo(root))[0]?.run.files_written[0]?.pre_blob_sha).toBeNull();
  });

  it('records the hunk git would, not the one the tool implies', () => {
    const root = tenLineRepo();
    rewrite(root, 'rename line five', 'a.txt', TEN.replace('line 5\n', 'line FIVE\n'));
    seal(openRepo(root), { now: T2 });

    expect(listRuns(openRepo(root))[0]?.run.files_written[0]?.hunks).toEqual([
      { old_start: 5, old_len: 1, new_start: 5, new_len: 1 },
    ]);
  });
});

describe('blame and revert agree', () => {
  it('blames as many lines as revert offers to put back', () => {
    const root = tenLineRepo();
    rewrite(root, 'rename line five', 'a.txt', TEN.replace('line 5\n', 'line FIVE\n'));
    seal(openRepo(root), { now: T2 });
    const repo = openRepo(root);
    const [entry] = listRuns(repo);

    const plan = planRevert(repo, { runs: [entry?.run.run_id ?? ''] });
    const offered = plan.files.reduce((total, file) => total + file.changed, 0);
    // These two numbers are the same question asked of the same evidence. When
    // they disagree the user is told two different stories about one run.
    expect(offered).toBe(claimedLines(root, 'a.txt').length);
  });

  it('puts the file back exactly, having only touched the line it changed', () => {
    const root = tenLineRepo();
    rewrite(root, 'rename line five', 'a.txt', TEN.replace('line 5\n', 'line FIVE\n'));
    seal(openRepo(root), { now: T2 });
    const repo = openRepo(root);
    const [entry] = listRuns(repo);

    applyRevert(repo, planRevert(repo, { runs: [entry?.run.run_id ?? ''] }));
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(TEN);
  });
});

describe('the number that goes in a pull request', () => {
  it('counts one line of the agent, not the ten it rewrote', () => {
    const root = tenLineRepo();
    const base = sh(root, ['rev-parse', 'HEAD']);
    rewrite(root, 'rename line five', 'a.txt', TEN.replace('line 5\n', 'line FIVE\n'));
    seal(openRepo(root), { now: T2 });
    sh(root, ['add', 'a.txt']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'the agent change']);

    const result = reportRange(openRepo(root), base);
    expect(result.changed).toBe(1);
    expect(result.byAgents).toBe(1);
  });
});

describe('things that were reported as fine when they were not', () => {
  it('calls out a ledger ref pointing at ordinary history', () => {
    const root = tenLineRepo();
    // A mistyped update-ref, a push of the wrong branch, a tool that rewrote
    // refs: the ref exists, so this was reported as "created, nothing recorded
    // yet" and the whole check passed.
    sh(root, ['update-ref', 'refs/deepblame/ledger', sh(root, ['rev-parse', 'HEAD'])]);

    const check = diagnose(openRepo(root), { now: T2, hooks: [] }).checks.find((one) => one.name === 'ledger');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('not a ledger');
  });

  it('refuses a base ref that does not exist instead of saying nothing changed', () => {
    const root = tenLineRepo();
    // In CI the base is a variable somebody else fills in. "No lines changed"
    // reads as "no agent wrote any of this", which is a different claim.
    expect(() => reportRange(openRepo(root), 'origin/nonexistent')).toThrow(/no such commit/);
  });
});
