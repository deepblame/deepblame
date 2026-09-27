import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '@deepblame/protocol';
import { git, tryGit } from './git';
import type { Repo } from './repo';
import { listRuns } from './runs';

/**
 * Line-level provenance. The ledger records which lines a run wrote *in the
 * file as it stood then*; the file has moved on since. So for every run we
 * diff the state it left against the file as it is now, carry its line ranges
 * through that diff, and drop the lines a later edit replaced.
 *
 * The rule the whole feature rests on: never claim a line we cannot prove.
 * A line we cannot follow is reported as unknown, not guessed at, and every
 * answer carries how sure we are.
 */

export type BlameReason =
  /** The file is byte for byte what the run left, so the mapping is exact. */
  | 'exact'
  /** The file changed elsewhere, but this line came through untouched. */
  | 'survived'
  /** Nobody we recorded wrote this line: a human, an unrecorded tool, or history. */
  | 'unknown';

export interface BlameSpan {
  /** 1-based and inclusive, in the file as it is now. */
  from: number;
  to: number;
  run: Run | null;
  confidence: number;
  reason: BlameReason;
}

export interface BlameResult {
  path: string;
  lines: number;
  spans: BlameSpan[];
  /** Share of the file's lines an agent is known to have written, 0 to 1. */
  agentShare: number;
  /** Share traced to any recorded change, including plain commits. */
  tracedShare: number;
  /** Runs that wrote this file but whose recorded content is no longer in the ledger. */
  unverifiable: number;
  /** Runs that touched the file at all. */
  runs: number;
}

export class FileNotTrackedError extends Error {
  override name = 'FileNotTrackedError';
  constructor(readonly path: string) {
    super(`no such file in this worktree: ${path}`);
  }
}

interface Attribution {
  run: Run;
  confidence: number;
  reason: BlameReason;
}

export function blameFile(repo: Repo, path: string): BlameResult {
  const file = join(repo.root, path);
  if (!existsSync(file)) throw new FileNotTrackedError(path);
  const current = readFileSync(file, 'utf8');
  const total = countLines(current);
  const currentOid = git(['hash-object', '-w', '--no-filters', '--', file], { cwd: repo.root });

  const touching = listRuns(repo)
    .map((entry) => entry.run)
    .filter((run) => run.files_written.some((written) => written.path === path))
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));

  const attributed = new Map<number, Attribution>();
  let unverifiable = 0;

  for (const run of touching) {
    const written = run.files_written.find((entry) => entry.path === path);
    const post = written?.post_blob_sha ?? null;
    if (written === undefined || post === null || written.hunks.length === 0) continue;

    // The state this run left is the state we can still prove things about.
    if (tryGit(['cat-file', '-e', `${post}^{blob}`], { cwd: repo.root }) === null) {
      unverifiable += 1;
      continue;
    }

    const exact = post === currentOid;
    const map = exact ? identity : lineMap(diffHunks(repo, post, currentOid));
    for (const hunk of written.hunks) {
      for (let line = hunk.new_start; line < hunk.new_start + Math.max(hunk.new_len, 1); line += 1) {
        const now = map(line);
        if (now === null || now < 1 || now > total) continue;
        // Runs are walked oldest first, so the last writer of a line wins —
        // except that a commit (the fallback for tools we cannot hook) never
        // takes a line away from the agent we actually watched writing it.
        const held = attributed.get(now);
        if (held !== undefined && run.harness.name === 'git' && held.run.harness.name !== 'git') continue;
        attributed.set(now, { run, confidence: exact ? 1 : 0.9, reason: exact ? 'exact' : 'survived' });
      }
    }
  }

  let byAgent = 0;
  for (const held of attributed.values()) if (held.run.actor.type === 'agent') byAgent += 1;

  return {
    path,
    lines: total,
    spans: spansOf(total, attributed),
    agentShare: total === 0 ? 0 : byAgent / total,
    tracedShare: total === 0 ? 0 : attributed.size / total,
    unverifiable,
    runs: touching.length,
  };
}

/** The run that wrote one line, with how sure we are. */
export function blameLine(repo: Repo, path: string, line: number): BlameSpan | null {
  return blameFile(repo, path).spans.find((span) => line >= span.from && line <= span.to) ?? null;
}

function spansOf(total: number, attributed: Map<number, Attribution>): BlameSpan[] {
  const spans: BlameSpan[] = [];
  for (let line = 1; line <= total; line += 1) {
    const found = attributed.get(line) ?? null;
    const last = spans[spans.length - 1];
    const sameAsLast =
      last !== undefined &&
      last.to === line - 1 &&
      (last.run?.run_id ?? null) === (found?.run.run_id ?? null) &&
      last.reason === (found?.reason ?? 'unknown');
    if (sameAsLast && last !== undefined) {
      last.to = line;
      continue;
    }
    spans.push({
      from: line,
      to: line,
      run: found?.run ?? null,
      confidence: found?.confidence ?? 0,
      reason: found?.reason ?? 'unknown',
    });
  }
  return spans;
}

interface DiffHunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
}

/** Where the file changed between two states, as git sees it. */
function diffHunks(repo: Repo, from: string, to: string): DiffHunk[] {
  const out = tryGit(['diff', '--no-color', '--no-ext-diff', '--unified=0', from, to], { cwd: repo.root });
  if (out === null) return [];
  const hunks: DiffHunk[] = [];
  for (const line of out.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match === null) continue;
    hunks.push({
      oldStart: Number(match[1]),
      oldLen: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLen: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks.sort((a, b) => a.oldStart - b.oldStart);
}

function identity(line: number): number {
  return line;
}

/**
 * Follows a line from an older state of the file into the current one.
 * Null means a later change replaced or deleted it, so nobody can claim it.
 */
function lineMap(hunks: readonly DiffHunk[]): (line: number) => number | null {
  return (line: number) => {
    let offset = 0;
    for (const hunk of hunks) {
      if (hunk.oldLen === 0) {
        // Pure insertion, recorded as happening after `oldStart`.
        if (line > hunk.oldStart) offset += hunk.newLen;
        continue;
      }
      if (line < hunk.oldStart) break;
      if (line <= hunk.oldStart + hunk.oldLen - 1) return null;
      offset += hunk.newLen - hunk.oldLen;
    }
    return line + offset;
  };
}

function countLines(text: string): number {
  if (text === '') return 0;
  let count = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count += 1;
  return text.endsWith('\n') ? count : count + 1;
}
