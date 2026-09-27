import type { BlameResult, BlameSpan } from '@deepblame/core';
import type { Run } from '@deepblame/protocol';

/**
 * Everything the extension draws, worked out without touching the editor API.
 *
 * The VS Code layer is deliberately thin — it asks this module what the text
 * should say and where it goes, then hands that to the editor. Keeping the two
 * apart is what lets the part that decides be tested, which matters here
 * because the wording is the feature: an annotation that overclaims is worse
 * than none at all.
 *
 * Lines are 0-based throughout, the way VS Code counts them. The ledger counts
 * from 1, so the conversion happens once, at the door.
 */

/** One line of the open file, and the run that wrote it. */
export interface LineNote {
  /** 0-based, as VS Code counts. */
  line: number;
  span: BlameSpan;
  run: Run;
}

/** A stretch of consecutive lines written by the same run. */
export interface Band {
  /** 0-based and inclusive. */
  from: number;
  to: number;
  run: Run;
  confidence: number;
}

/**
 * The lines an agent wrote, and only those.
 *
 * A plain commit is in the ledger too, but it names the person who made it,
 * and marking up a colleague's lines is not what this is for.
 */
export function agentNotes(result: BlameResult | null): LineNote[] {
  if (result === null) return [];
  const notes: LineNote[] = [];
  for (const span of result.spans) {
    const { run } = span;
    if (run === null || run.actor.type !== 'agent') continue;
    for (let line = span.from; line <= span.to; line += 1) notes.push({ line: line - 1, span, run });
  }
  return notes;
}

/** The note on one line, or null when nothing recorded wrote it. */
export function noteAt(notes: readonly LineNote[], line: number): LineNote | null {
  return notes.find((note) => note.line === line) ?? null;
}

/** One replacement in the open buffer: lines `from` to `to` became `lines` lines. */
export interface Edit {
  /** 0-based and inclusive, the range that was replaced. */
  from: number;
  to: number;
  /** How many lines the replacement spans. */
  lines: number;
}

/**
 * Carries the marks through an unsaved edit.
 *
 * Blame reads the file from disk, so the moment someone types the buffer and
 * the answer disagree. Rather than freeze or, worse, leave the marks pointing
 * at whatever moved under them, each change shifts the lines below it and drops
 * the lines it touched: a line somebody has just edited by hand is no longer
 * provably the agent's, and saying otherwise is the one mistake this tool
 * cannot afford. Dropped marks come back on save, when the record catches up.
 */
export function applyEdit(notes: readonly LineNote[], edit: Edit): LineNote[] {
  const delta = edit.lines - (edit.to - edit.from + 1);
  const out: LineNote[] = [];
  for (const note of notes) {
    if (note.line >= edit.from && note.line <= edit.to) continue;
    out.push(note.line > edit.to ? { ...note, line: note.line + delta } : note);
  }
  return out;
}

/**
 * Consecutive lines from one run, collapsed.
 *
 * A file an agent generated is thousands of separate lines and one band. The
 * editor is told about ranges either way, but a hundred thousand of them is
 * slow enough to feel, and bands cost nothing to compute.
 */
export function bands(notes: readonly LineNote[]): Band[] {
  const ordered = [...notes].sort((a, b) => a.line - b.line);
  const out: Band[] = [];
  for (const note of ordered) {
    const last = out[out.length - 1];
    if (last !== undefined && last.run.run_id === note.run.run_id && note.line === last.to + 1) {
      last.to = note.line;
      last.confidence = Math.min(last.confidence, note.span.confidence);
      continue;
    }
    out.push({ from: note.line, to: note.line, run: note.run, confidence: note.span.confidence });
  }
  return out;
}

/**
 * The grey text that sits at the end of the line the cursor is on.
 *
 * Short on purpose: it shares the line with the code, and the detail is one
 * hover away. What it says is who, and what they were asked for — the second
 * being the thing `git blame` cannot tell you.
 */
export function label(span: BlameSpan, width = 68): string {
  const { run } = span;
  if (run === null) return '';
  const intent = run.task.intent?.trim();
  const said = intent === undefined || intent === '' ? null : oneLine(intent);
  const soft = span.reason === 'reformatted' ? '~ ' : '';
  const head = `${soft}${agentName(run)}`;
  if (said === null) return head;
  return clip(`${head} · ${said}`, Math.max(width, head.length));
}

/** What to show on hover: who, why, what it cost, and how sure we are. */
export function hover(span: BlameSpan, options: HoverOptions = {}): string {
  const { run } = span;
  if (run === null) return 'No recorded agent wrote this line.';
  const rows: string[] = [];

  const model = run.model === null ? '' : ` · ${escape(run.model.name)}`;
  rows.push(`**${escape(agentName(run))}**${model}`, '');

  const intent = run.task.intent?.trim();
  if (intent !== undefined && intent !== '') rows.push(`> ${escape(oneLine(intent))}`, '');

  const facts = [ago(run.started_at, options.now ?? new Date()), turnSize(run)].filter((fact) => fact !== null);
  rows.push(facts.join(' · '));
  rows.push('');
  rows.push(`${Math.round(span.confidence * 100)}% sure — ${why(span.reason)}`);

  if (options.commands === true) {
    const id = encodeURIComponent(JSON.stringify([run.run_id]));
    rows.push(
      '',
      `[Undo this run](command:deepblame.undoRun?${id}) · [Everything it did](command:deepblame.showRun?${id})`,
    );
  }
  return rows.join('\n');
}

export interface HoverOptions {
  /** Include the action links. They only work on a trusted markdown string. */
  commands?: boolean;
  now?: Date;
}

/** The one line in the status bar: how much of this file is not ours. */
export function fileSummary(result: BlameResult | null): string | null {
  if (result === null || result.lines === 0) return null;
  const percent = Math.round(result.agentShare * 100);
  if (percent === 0) return result.runs === 0 ? null : 'No agent lines left';
  return `${percent}% agent-written`;
}

/** The tooltip under that, which says what the number does and does not cover. */
export function summaryTooltip(result: BlameResult | null): string {
  if (result === null) return 'Nothing recorded for this file.';
  const rows = [
    `${count(Math.round(result.agentShare * result.lines), 'line')} of ${count(result.lines, 'line')} written by an agent.`,
    `${count(result.runs, 'run')} touched this file.`,
  ];
  if (result.unverifiable > 0) {
    rows.push(`${count(result.unverifiable, 'run')} can no longer be checked: the stored copy was cleared.`);
  }
  if (result.renamedFrom.length > 0) rows.push(`Followed from ${result.renamedFrom.join(', ')}.`);
  rows.push('Lines nobody claims are yours, predate recording, or were replaced since.');
  return rows.join('\n');
}

/** The heading of the detail view for one line. */
export function explain(span: BlameSpan | null, path: string, line: number, now = new Date()): string {
  const where = `${path}:${line + 1}`;
  if (span === null || span.run === null) {
    return [
      `No recorded agent wrote ${where}.`,
      '',
      'It is yours, it predates recording, or a later edit replaced what an agent left.',
    ].join('\n');
  }
  const { run } = span;
  const rows = [
    `${where} was written by ${agentName(run)}${run.model === null ? '' : ` (${run.model.name})`}.`,
    '',
    `Asked for: ${run.task.intent ?? 'not recorded'}`,
    `When: ${ago(run.started_at, now)} (${run.started_at})`,
    `Confidence: ${Math.round(span.confidence * 100)}% — ${why(span.reason)}`,
  ];
  const size = turnSize(run);
  if (size !== null) rows.push(`The turn: ${size}`);
  rows.push(`Run: ${shortId(run.run_id)}`);
  return rows.join('\n');
}

/**
 * What the dialog says before a single byte is written.
 *
 * It names every file, marks the ones that cannot be put back on their own,
 * and says how much would change — because the promise the product makes is
 * that nothing else moves, and a person can only check that promise if they
 * are told what to expect.
 */
export function undoPrompt(plan: UndoPlan, run: Run): { message: string; detail: string } | null {
  const todo = plan.files.filter((file) => file.write !== null);
  if (todo.length === 0) return null;
  const stuck = todo.filter((file) => file.status !== 'clean');
  const lines = todo.reduce((sum, file) => sum + file.changed, 0);
  const rows = [
    ...todo.map((file) => `${file.status === 'clean' ? '·' : '!'} ${file.path}${mark(file.status)}`),
    '',
    stuck.length === 0
      ? `${count(lines, 'line')} go back to what was there before. Nothing else in these files is touched.`
      : `${count(stuck.length, 'file')} changed too much since to undo on its own, and will be left alone.`,
  ];
  if (plan.dirty) rows.push('', 'You have uncommitted changes, so commit or stash first if you want a way back.');
  return {
    message: `Undo what ${agentName(run)} did in ${count(todo.length, 'file')}?`,
    detail: rows.join('\n'),
  };
}

/** Only the parts of a revert plan the wording needs. */
export interface UndoPlan {
  files: readonly { path: string; status: string; changed: number; write: unknown }[];
  /** Files written, once applied. */
  written: readonly string[];
  /** Files left alone because they could not be put back cleanly. */
  skipped: readonly string[];
  dirty: boolean;
}

/** What to say once the files are back. */
export function undoResult(plan: UndoPlan): string {
  const head = `Put ${count(plan.written.length, 'file')} back.`;
  if (plan.skipped.length === 0) return head;
  return `${head} ${count(plan.skipped.length, 'file')} left alone: ${plan.skipped.join(', ')} moved on too far to undo safely.`;
}

function mark(status: string): string {
  return status === 'clean' ? '' : `  (${status})`;
}

/** `claude-code` is the id in the ledger; nobody says that out loud. */
export function agentName(run: Run): string {
  const named: Record<string, string> = {
    'claude-code': 'Claude Code',
    cursor: 'Cursor',
    codex: 'Codex',
    opencode: 'OpenCode',
    git: 'git',
  };
  const name = named[run.harness.name] ?? run.harness.name;
  return run.harness.name === 'git' && run.actor.type === 'human' ? `${name} (${run.actor.id})` : name;
}

/** A score with no explanation is noise, so the reason travels with it. */
function why(reason: BlameSpan['reason']): string {
  if (reason === 'exact') return 'the file is exactly as the run left it';
  if (reason === 'survived') return 'the file changed elsewhere, this line came through untouched';
  if (reason === 'reformatted') return 'only the spacing has changed since, so probably still theirs';
  return 'nothing recorded claims this line';
}

function turnSize(run: Run): string | null {
  const parts: string[] = [];
  if (run.tool_calls.length > 0) parts.push(count(run.tool_calls.length, 'tool call'));
  const usd = run.cost?.usd;
  if (usd !== null && usd !== undefined) parts.push(usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** Plain words for a timestamp, because nobody reads ISO dates at a glance. */
export function ago(at: string, now: Date): string {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return at;
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 0) return 'just now';
  // Each step is how many of the unit so far make one of the next.
  const steps: [number, string][] = [
    [60, 'minute'],
    [60, 'hour'],
    [24, 'day'],
    [7, 'week'],
    [4.35, 'month'],
    [12, 'year'],
  ];
  let value = seconds;
  let unit = 'second';
  for (const [size, next] of steps) {
    if (value < size) break;
    value /= size;
    unit = next;
  }
  const whole = Math.floor(value);
  if (unit === 'second' && whole < 45) return 'just now';
  return `${count(whole, unit)} ago`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function shortId(runId: string): string {
  return runId.replace(/-/g, '').slice(0, 7);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1)).trimEnd()}…`;
}

/** A prompt is arbitrary text, and it is about to be rendered as markdown. */
function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (char) => `\\${char}`);
}
