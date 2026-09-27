import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_IDS, SCHEMA_VERSION, STATE_DIR, type HarnessId, type Run } from '@deepblame/protocol';
import { git, tryGit } from './git';
import { hostId, uuidV5, worktreeId } from './ids';
import type { Repo } from './repo';

/**
 * The adapter for tools that will not tell us anything. Codex only reports
 * that a turn ended; Cursor reports nothing at all. For those we take a
 * picture of the worktree at the end of every turn and compare it with the
 * last one: whatever changed in between is what that turn did.
 *
 * It is coarser than a hook — a human edit in the same window lands in the
 * agent's lap — so it is never used for an agent we can hook properly, and
 * the runs it writes say which way they were made.
 */

const SNAPSHOT_FILE = 'worktree.json';
const INTENT_MAX = 120;

interface Snapshot {
  taken_at: string;
  /** Repository-relative path to blob id, for everything that differs from HEAD. */
  files: Record<string, string>;
}

export interface TurnOptions {
  agent: HarnessId;
  /** What the user asked for, when the harness passes it along. */
  intent?: string | null;
  now?: Date;
}

/**
 * Records what changed since the previous snapshot as one run, then moves the
 * snapshot forward. Null when nothing changed: an idle turn is not a record.
 */
export function recordWorktreeTurn(repo: Repo, options: TurnOptions): Run | null {
  const now = options.now ?? new Date();
  const previous = readSnapshot(repo);
  const current = takeSnapshot(repo);
  writeSnapshot(repo, { taken_at: now.toISOString(), files: current });
  // The first scan only establishes the baseline; it cannot know who did what.
  if (previous === null) return null;

  const files_written: Run['files_written'] = [];
  for (const path of new Set([...Object.keys(previous.files), ...Object.keys(current)])) {
    const before = previous.files[path] ?? headBlob(repo, path);
    const after = current[path] ?? headBlob(repo, path);
    if (before === after) continue;
    files_written.push({
      path,
      pre_blob_sha: before,
      post_blob_sha: after,
      hunks: before === null || after === null ? [] : hunksBetween(repo, before, after),
    });
  }
  if (files_written.length === 0) return null;

  const intent = options.intent?.trim() ?? '';
  return {
    schema_version: SCHEMA_VERSION,
    run_id: uuidV5(`turn:${repo.root}:${now.toISOString()}`),
    session_id: uuidV5(`turn-session:${repo.root}:${previous.taken_at}`),
    parent_run_id: null,
    harness: { name: known(options.agent), version: null },
    model: null,
    actor: { type: 'agent', id: known(options.agent) },
    task: {
      prompt_sha256: intent === '' ? null : createHash('sha256').update(intent, 'utf8').digest('hex'),
      ...(intent === '' ? {} : { intent: intent.length > INTENT_MAX ? `${intent.slice(0, INTENT_MAX - 1)}…` : intent }),
    },
    started_at: previous.taken_at,
    ended_at: now.toISOString(),
    tool_calls: [],
    files_read: [],
    files_written,
    env: {
      branch: tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo.root }),
      head_commit: tryGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: repo.root }),
      worktree_id: worktreeId(repo.root),
      host_id: hostId(),
    },
  };
}

/** Starts the clock without recording anything, for the beginning of a session. */
export function markWorktree(repo: Repo, now: Date = new Date()): void {
  writeSnapshot(repo, { taken_at: now.toISOString(), files: takeSnapshot(repo) });
}

/**
 * Everything that differs from HEAD right now, by object id. Writing the blobs
 * as we go means blame can prove what it says later.
 */
function takeSnapshot(repo: Repo): Record<string, string> {
  const files: Record<string, string> = {};
  const listing = tryGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], {
    cwd: repo.root,
    raw: true,
  });
  if (listing === null) return files;
  for (const entry of listing.split('\u0000')) {
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    const full = join(repo.root, path);
    if (!existsSync(full)) continue;
    const oid = tryGit(['hash-object', '-w', '--no-filters', '--', full], { cwd: repo.root });
    if (oid !== null) files[path] = oid;
  }
  return files;
}

function headBlob(repo: Repo, path: string): string | null {
  return tryGit(['rev-parse', '--verify', '--quiet', `HEAD:${path}`], { cwd: repo.root });
}

function hunksBetween(repo: Repo, pre: string, post: string): Run['files_written'][number]['hunks'] {
  const out = tryGit(['diff', '--no-color', '--no-ext-diff', '--unified=0', pre, post], { cwd: repo.root });
  if (out === null) return [];
  const hunks: Run['files_written'][number]['hunks'] = [];
  for (const line of out.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match === null) continue;
    hunks.push({
      old_start: Number(match[1]),
      old_len: match[2] === undefined ? 1 : Number(match[2]),
      new_start: Number(match[3]),
      new_len: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}

function snapshotPath(repo: Repo): string {
  return join(repo.root, STATE_DIR, SNAPSHOT_FILE);
}

function readSnapshot(repo: Repo): Snapshot | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(snapshotPath(repo), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const value = raw as Partial<Snapshot>;
    if (typeof value.taken_at !== 'string' || typeof value.files !== 'object' || value.files === null) return null;
    return { taken_at: value.taken_at, files: value.files as Record<string, string> };
  } catch {
    return null;
  }
}

function writeSnapshot(repo: Repo, snapshot: Snapshot): void {
  try {
    writeFileSync(snapshotPath(repo), `${JSON.stringify(snapshot)}\n`);
  } catch {
    // Without a snapshot the next turn just starts a new baseline.
  }
}

function known(agent: string): HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(agent) ? (agent as HarnessId) : 'git';
}
