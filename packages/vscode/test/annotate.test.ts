import type { BlameResult, BlameSpan } from '@deepblame/core';
import type { Run } from '@deepblame/protocol';
import { describe, expect, it } from 'vitest';
import {
  agentName,
  agentNotes,
  ago,
  applyEdit,
  bands,
  explain,
  fileSummary,
  hover,
  label,
  noteAt,
  summaryTooltip,
  undoPrompt,
  undoResult,
  type UndoPlan,
} from '../src/annotate';

/**
 * The editor layer is thin and cannot be run from here, so everything it says
 * is decided in these functions and checked here instead. The wording is the
 * feature: what matters is that a mark never claims more than the ledger knows.
 */

const NOW = new Date('2026-09-27T12:00:00.000Z');

function run(overrides: Partial<Run> = {}): Run {
  return {
    schema_version: 1,
    run_id: '11111111-1111-4111-8111-111111111111',
    session_id: '22222222-2222-4222-8222-222222222222',
    parent_run_id: null,
    harness: { name: 'claude-code', version: '1.0.0' },
    model: { provider: 'anthropic', name: 'claude-opus-5', version: null },
    actor: { type: 'agent', id: 'claude-code' },
    task: { prompt_sha256: null, intent: 'make the retry back off' },
    started_at: '2026-09-27T10:00:00.000Z',
    ended_at: '2026-09-27T10:00:30.000Z',
    tool_calls: [],
    files_read: [],
    files_written: [],
    cost: { input_tokens: 100, output_tokens: 20, usd: 0.031 },
    env: { branch: 'main', head_commit: null, worktree_id: 'w', host_id: 'h' },
    ...overrides,
  } as Run;
}

function span(from: number, to: number, on: Run | null, reason: BlameSpan['reason'] = 'exact'): BlameSpan {
  const confidence = reason === 'exact' ? 1 : reason === 'survived' ? 0.9 : reason === 'reformatted' ? 0.7 : 0;
  return { from, to, run: on, confidence, reason };
}

function file(spans: BlameSpan[], overrides: Partial<BlameResult> = {}): BlameResult {
  const lines = spans.reduce((most, one) => Math.max(most, one.to), 0);
  const claimed = spans
    .filter((one) => one.run?.actor.type === 'agent')
    .reduce((sum, one) => sum + (one.to - one.from + 1), 0);
  return {
    path: 'src/app.ts',
    lines,
    spans,
    agentShare: lines === 0 ? 0 : claimed / lines,
    tracedShare: 0,
    unverifiable: 0,
    runs: spans.filter((one) => one.run !== null).length,
    renamedFrom: [],
    ...overrides,
  };
}

describe('which lines get marked', () => {
  it('marks what an agent wrote, counting from zero as the editor does', () => {
    const notes = agentNotes(file([span(1, 2, run()), span(3, 4, null)]));
    expect(notes.map((note) => note.line)).toEqual([0, 1]);
  });

  it('leaves a colleague\'s commit alone', () => {
    const person = run({
      harness: { name: 'git', version: null },
      actor: { type: 'human', id: 'ayse' },
    });
    expect(agentNotes(file([span(1, 3, person)]))).toEqual([]);
  });

  it('has nothing to say when the file is not in the ledger', () => {
    expect(agentNotes(null)).toEqual([]);
  });

  it('finds the note under the cursor', () => {
    const notes = agentNotes(file([span(1, 2, run())]));
    expect(noteAt(notes, 0)?.run.run_id).toBe(run().run_id);
    expect(noteAt(notes, 5)).toBeNull();
  });
});

describe('collapsing into bands', () => {
  it('joins consecutive lines from one run', () => {
    const bounds = bands(agentNotes(file([span(1, 40, run())])));
    expect(bounds).toHaveLength(1);
    expect(bounds[0]).toMatchObject({ from: 0, to: 39 });
  });

  it('breaks where a different run takes over', () => {
    const other = run({ run_id: '33333333-3333-4333-8333-333333333333' });
    const bounds = bands(agentNotes(file([span(1, 2, run()), span(3, 4, other)])));
    expect(bounds.map((band) => [band.from, band.to])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('breaks across a gap the same run did not write', () => {
    const bounds = bands(agentNotes(file([span(1, 1, run()), span(2, 2, null), span(3, 3, run())])));
    expect(bounds.map((band) => [band.from, band.to])).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });

  it('carries the weakest confidence in the band, not the strongest', () => {
    const spans = [span(1, 1, run(), 'exact'), span(2, 2, run(), 'reformatted')];
    expect(bands(agentNotes(file(spans)))[0]?.confidence).toBe(0.7);
  });
});

describe('what the line says', () => {
  it('names the agent and what it was asked for', () => {
    expect(label(span(1, 1, run()))).toBe('Claude Code · make the retry back off');
  });

  it('names just the agent when no prompt was recorded', () => {
    expect(label(span(1, 1, run({ task: { prompt_sha256: null } })))).toBe('Claude Code');
  });

  it('marks a line a formatter has been through, so it does not read as certain', () => {
    expect(label(span(1, 1, run(), 'reformatted')).startsWith('~ Claude Code')).toBe(true);
  });

  it('keeps out of the way of the code', () => {
    const wordy = run({ task: { prompt_sha256: null, intent: 'a'.repeat(200) } });
    const text = label(span(1, 1, wordy));
    expect(text.length).toBeLessThanOrEqual(68);
    expect(text.endsWith('…')).toBe(true);
  });

  it('flattens a prompt written over several lines', () => {
    const wrapped = run({ task: { prompt_sha256: null, intent: 'fix the\n  retry  loop' } });
    expect(label(span(1, 1, wrapped))).toBe('Claude Code · fix the retry loop');
  });
});

describe('what the hover says', () => {
  it('gives the agent, the model, the prompt, the cost and how sure it is', () => {
    const text = hover(span(1, 1, run()), { now: NOW });
    expect(text).toContain('**Claude Code**');
    expect(text).toContain('claude\\-opus\\-5');
    expect(text).toContain('make the retry back off');
    expect(text).toContain('$0.03');
    expect(text).toContain('100% sure');
    expect(text).toContain('the file is exactly as the run left it');
  });

  it('says how sure it is, and why, when the file has moved on', () => {
    expect(hover(span(1, 1, run(), 'survived'), { now: NOW })).toContain('90% sure — the file changed elsewhere');
  });

  it('leaves the cost out rather than guessing at it', () => {
    const free = run({ cost: undefined });
    expect(hover(span(1, 1, free), { now: NOW })).not.toContain('$');
  });

  it('does not let a prompt smuggle markdown into the hover', () => {
    const sneaky = run({ task: { prompt_sha256: null, intent: '[click](command:workbench.action.terminal.new)' } });
    const text = hover(span(1, 1, sneaky), { now: NOW });
    expect(text).not.toContain('[click](command:workbench.action.terminal.new)');
    expect(text).toContain('\\[click\\]');
  });

  it('offers the two actions only when asked, since plain markdown cannot run them', () => {
    expect(hover(span(1, 1, run()), { now: NOW })).not.toContain('command:deepblame');
    const withLinks = hover(span(1, 1, run()), { now: NOW, commands: true });
    expect(withLinks).toContain('command:deepblame.undoRun?%5B%2211111111-1111-4111-8111-111111111111%22%5D');
    expect(withLinks).toContain('command:deepblame.showRun?');
  });
});

describe('the one line in the status bar', () => {
  it('says how much of the file is not the person\'s own', () => {
    expect(fileSummary(file([span(1, 1, run()), span(2, 4, null)]))).toBe('25% agent-written');
  });

  it('stays quiet about a file no agent ever touched', () => {
    expect(fileSummary(file([span(1, 4, null)], { runs: 0 }))).toBeNull();
  });

  it('says so when an agent wrote here but nothing of it is left', () => {
    expect(fileSummary(file([span(1, 4, null)], { runs: 2 }))).toBe('No agent lines left');
  });

  it('explains what the number leaves out', () => {
    const result = file([span(1, 1, run()), span(2, 4, null)], { unverifiable: 1, renamedFrom: ['src/old.ts'] });
    const text = summaryTooltip(result);
    expect(text).toContain('1 line of 4 lines written by an agent');
    expect(text).toContain('the stored copy was cleared');
    expect(text).toContain('Followed from src/old.ts');
    expect(text).toContain('Lines nobody claims are yours');
  });
});

describe('carrying the marks through an unsaved edit', () => {
  const notes = agentNotes(file([span(1, 5, run())]));

  it('pushes the marks below an inserted line down', () => {
    // Two lines typed where one stood, at line 0.
    const after = applyEdit(notes, { from: 0, to: 0, lines: 2 });
    expect(after.map((note) => note.line)).toEqual([2, 3, 4, 5]);
  });

  it('pulls them up when lines are deleted above', () => {
    // Lines 0 to 2 became one line, so the marks that were on 3 and 4 slide up
    // by two and the three touched lines let go.
    const after = applyEdit(notes, { from: 0, to: 2, lines: 1 });
    expect(after.map((note) => note.line)).toEqual([1, 2]);
  });

  it('drops the mark on a line the person has just edited', () => {
    const after = applyEdit(notes, { from: 2, to: 2, lines: 1 });
    expect(after.map((note) => note.line)).toEqual([0, 1, 3, 4]);
  });

  it('leaves marks above an edit exactly where they were', () => {
    const after = applyEdit(notes, { from: 4, to: 4, lines: 3 });
    expect(after.map((note) => note.line)).toEqual([0, 1, 2, 3]);
  });

  it('survives a run of edits in the order the editor sends them', () => {
    let carried = notes;
    for (const edit of [
      { from: 0, to: 0, lines: 3 },
      { from: 6, to: 6, lines: 1 },
    ]) {
      carried = applyEdit(carried, edit);
    }
    expect(carried.map((note) => note.line)).toEqual([3, 4, 5]);
  });
});

describe('naming the agent', () => {
  it('uses the name people say out loud, not the id in the ledger', () => {
    expect(agentName(run())).toBe('Claude Code');
    expect(agentName(run({ harness: { name: 'opencode', version: null } }))).toBe('OpenCode');
  });

  it('names the person behind a plain commit', () => {
    const person = run({ harness: { name: 'git', version: null }, actor: { type: 'human', id: 'ayse' } });
    expect(agentName(person)).toBe('git (ayse)');
  });
});

describe('explaining one line', () => {
  it('says plainly that nobody recorded wrote it, rather than guessing', () => {
    const text = explain(null, 'src/app.ts', 11, NOW);
    expect(text).toContain('No recorded agent wrote src/app.ts:12');
    expect(text).toContain('a later edit replaced what an agent left');
  });

  it('gives the whole picture for a line an agent wrote', () => {
    const text = explain(span(1, 1, run()), 'src/app.ts', 0, NOW);
    expect(text).toContain('src/app.ts:1 was written by Claude Code (claude-opus-5)');
    expect(text).toContain('Asked for: make the retry back off');
    expect(text).toContain('2 hours ago');
    expect(text).toContain('Confidence: 100%');
    expect(text).toContain('Run: 1111111');
  });
});

describe('before undoing anything', () => {
  const plan = (files: UndoPlan['files'], rest: Partial<UndoPlan> = {}): UndoPlan => ({
    files,
    written: [],
    skipped: [],
    dirty: false,
    ...rest,
  });
  const todo = (path: string, status: string, changed: number): UndoPlan['files'][number] => ({
    path,
    status,
    changed,
    write: { kind: 'restore', oid: 'a'.repeat(40) },
  });

  it('lists the files, says how much moves, and promises nothing else does', () => {
    const ask = undoPrompt(plan([todo('src/app.ts', 'clean', 12)]), run());
    expect(ask?.message).toBe('Undo what Claude Code did in 1 file?');
    expect(ask?.detail).toContain('· src/app.ts');
    expect(ask?.detail).toContain('12 lines go back to what was there before');
    expect(ask?.detail).toContain('Nothing else in these files is touched');
  });

  it('marks the part that cannot be put back, instead of trying', () => {
    const ask = undoPrompt(plan([todo('src/app.ts', 'clean', 3), todo('src/web.ts', 'conflicted', 9)]), run());
    expect(ask?.detail).toContain('! src/web.ts  (conflicted)');
    expect(ask?.detail).toContain('1 file changed too much since to undo on its own');
  });

  it('says to commit first when the worktree is dirty', () => {
    const ask = undoPrompt(plan([todo('src/app.ts', 'clean', 3)], { dirty: true }), run());
    expect(ask?.detail).toContain('commit or stash first');
  });

  it('does not ask at all when there is nothing left to undo', () => {
    const nothing = plan([{ path: 'src/app.ts', status: 'unchanged', changed: 0, write: null }]);
    expect(undoPrompt(nothing, run())).toBeNull();
  });

  it('reports afterwards what it wrote and what it left, by name', () => {
    const done = plan([], { written: ['a.ts'], skipped: ['b.ts'] });
    expect(undoResult(done)).toBe('Put 1 file back. 1 file left alone: b.ts moved on too far to undo safely.');
    expect(undoResult(plan([], { written: ['a.ts', 'b.ts'] }))).toBe('Put 2 files back.');
  });
});

describe('telling the time in words', () => {
  it('reads the way a person would say it', () => {
    expect(ago('2026-09-27T11:59:50.000Z', NOW)).toBe('just now');
    expect(ago('2026-09-27T11:55:00.000Z', NOW)).toBe('5 minutes ago');
    expect(ago('2026-09-27T11:00:00.000Z', NOW)).toBe('1 hour ago');
    expect(ago('2026-09-25T12:00:00.000Z', NOW)).toBe('2 days ago');
    expect(ago('2026-09-06T12:00:00.000Z', NOW)).toBe('3 weeks ago');
  });

  it('hands back a timestamp it cannot read rather than inventing one', () => {
    expect(ago('not a date', NOW)).toBe('not a date');
  });
});
