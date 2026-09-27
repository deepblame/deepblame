import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '@deepblame/protocol';
import { diffBlobs, lineMap } from './diffmap';
import { git, tryGit } from './git';
import { aliasesOf, readRenames } from './rename';
import type { Repo } from './repo';
import { runsTouching } from './runs';

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
  /** The line only differs in spacing now: a formatter has been through. */
  | 'reformatted'
  /** Nobody we recorded wrote this line: a human, an unrecorded tool, or history. */
  | 'unknown';

/** How sure each way of finding a line makes us. */
const CONFIDENCE: Record<Exclude<BlameReason, 'unknown'>, number> = {
  exact: 1,
  survived: 0.9,
  reformatted: 0.7,
};

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
  /** Names this file used to have, newest first. Empty when it never moved. */
  renamedFrom: string[];
}

export class FileNotTrackedError extends Error {
  override name = 'FileNotTrackedError';
  constructor(readonly path: string) {
    super(`no such file in this worktree: ${path}`);
  }
}

/** Follows one line from an older state of the file into the current one. */
type Follow = (line: number) => number | null;

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

  // A file that has been renamed is still the same file, and the runs that
  // wrote it recorded the name it had at the time.
  const names = aliasesOf(readRenames(repo), path);
  const known = new Set(names);

  // Newest first. Every line belongs to whoever wrote it last, so the first
  // run that claims a line is the answer and we can stop as soon as the whole
  // file is accounted for — which matters on a file with a long history,
  // because each remaining run costs a git process.
  const touching = runsTouching(repo, known).map((entry) => entry.run);

  const attributed = new Map<number, Attribution>();
  /** Lines held by an agent we actually watched. A commit's claim is weaker. */
  let settled = 0;
  let unverifiable = 0;
  /** Line followers, kept by the state the run left, so no diff is run twice. */
  const strict = new Map<string, Follow | null>();
  const loose = new Map<string, Follow | null>();

  // One git process to find out which recorded states still exist, rather than
  // one per run. What we can prove about a line depends on having the content
  // the run left, so this is asked about every run before anything else.
  const present = blobsPresent(
    repo,
    touching
      .map((run) => run.files_written.find((entry) => known.has(entry.path))?.post_blob_sha)
      .filter((oid): oid is string => oid !== undefined && oid !== null),
  );

  for (const run of touching) {
    if (settled >= total) break;
    const written = run.files_written.find((entry) => known.has(entry.path));
    const post = written?.post_blob_sha ?? null;
    if (written === undefined || post === null || written.hunks.length === 0) continue;

    // The state this run left is the state we can still prove things about.
    if (!present.has(post)) {
      unverifiable += 1;
      continue;
    }

    const exact = post === currentOid;
    // Two runs that left the file in the same state share a diff, and a diff
    // is a git process, so they are remembered by the state they left.
    let map = strict.get(post);
    if (map === undefined) {
      const moved = exact ? [] : diffBlobs(repo, post, currentOid);
      map = moved === null ? null : exact ? identity : lineMap(moved);
      strict.set(post, map);
    }
    if (map === null) {
      unverifiable += 1;
      continue;
    }
    const follow = map;
    // The whitespace-blind pass is only built if a line goes missing from the
    // strict one, because most files never see a formatter.
    const looseMap = (): Follow | null => {
      const found = loose.get(post);
      if (found !== undefined) return found;
      const hunks = diffBlobs(repo, post, currentOid, { ignoreWhitespace: true });
      const built = hunks === null ? null : lineMap(hunks);
      loose.set(post, built);
      return built;
    };

    for (const hunk of written.hunks) {
      for (let line = hunk.new_start; line < hunk.new_start + Math.max(hunk.new_len, 1); line += 1) {
        let reason: BlameReason = exact ? 'exact' : 'survived';
        let now = follow(line);
        if (now === null && !exact) {
          // The line is gone as far as a strict diff is concerned. Ask again
          // ignoring spacing: a reindent is not a rewrite, and saying "nobody
          // knows" after a formatter runs would make blame useless in practice.
          now = looseMap()?.(line) ?? null;
          reason = 'reformatted';
        }
        if (now === null || now < 1 || now > total) continue;
        // Newest first, so the first claim on a line stands — with one
        // exception: a commit (the fallback for tools we cannot hook) names a
        // person, never a tool, so an agent we actually watched writing the
        // line takes it back off the commit, however much older it is.
        const held = attributed.get(now);
        const watched = run.harness.name !== 'git';
        if (held !== undefined && !(watched && held.run.harness.name === 'git')) continue;
        attributed.set(now, { run, confidence: CONFIDENCE[reason], reason });
        if (watched) settled += 1;
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
    renamedFrom: names.slice(1),
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

function identity(line: number): number {
  return line;
}

/** Which of these object ids the repository still holds, in one git process. */
function blobsPresent(repo: Repo, oids: readonly string[]): Set<string> {
  const unique = [...new Set(oids)];
  if (unique.length === 0) return new Set();
  const out = tryGit(['cat-file', '--batch-check'], {
    cwd: repo.root,
    input: `${unique.map((oid) => `${oid}^{blob}`).join('\n')}\n`,
  });
  if (out === null) return new Set();
  const found = new Set<string>();
  for (const line of out.split('\n')) {
    // "<oid> blob <size>" when it is there, "<what you asked> missing" when not.
    const match = /^([0-9a-f]+) blob \d+$/.exec(line.trim());
    if (match?.[1] !== undefined) found.add(match[1]);
  }
  return found;
}

function countLines(text: string): number {
  if (text === '') return 0;
  let count = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count += 1;
  return text.endsWith('\n') ? count : count + 1;
}
