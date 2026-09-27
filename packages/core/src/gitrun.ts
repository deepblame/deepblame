import { createHash } from 'node:crypto';
import { SCHEMA_VERSION, type Run } from '@deepblame/protocol';
import { git, tryGit } from './git';
import { hostId, uuidV5, worktreeId } from './ids';
import type { Repo } from './repo';

/**
 * The fallback that works with everything. Most tools give us no hooks at
 * all — Cursor, Copilot, a cloud agent that opens a pull request — but every
 * one of them ends with a commit. A commit tells us which lines changed and
 * when; it cannot tell us which agent, or why. So this records what it can
 * and says what it does not know, rather than leaving the file blank.
 */

const INTENT_MAX = 120;

/** Builds a run from one commit. Null when the commit changed no file we can read. */
export function runFromCommit(repo: Repo, ref = 'HEAD', now: Date = new Date()): Run | null {
  const cwd = repo.root;
  const head = tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  if (head === null) return null;

  const meta = git(['show', '--no-patch', '--format=%H%x00%an%x00%aI%x00%B', head], { cwd, raw: true });
  const [, author = 'unknown', authored = now.toISOString(), message = ''] = meta.split('\u0000');
  const subject = message.split('\n')[0]?.trim() ?? '';

  const files_written: Run['files_written'] = [];
  // --root so the very first commit of a repository is not skipped.
  const listing = tryGit(['diff-tree', '-r', '--root', '--no-commit-id', '--no-renames', head], { cwd });
  for (const line of (listing ?? '').split('\n')) {
    const match = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*\t(.+)$/.exec(line);
    if (match === null) continue;
    const [, preRaw = '', postRaw = '', status = '', path = ''] = match;
    const pre = empty(preRaw) ? null : preRaw;
    const post = empty(postRaw) ? null : postRaw;
    if (status === 'D') {
      files_written.push({ path, pre_blob_sha: pre, post_blob_sha: null, hunks: [] });
      continue;
    }
    if (post === null) continue;
    files_written.push({ path, pre_blob_sha: pre, post_blob_sha: post, hunks: hunksBetween(repo, pre, post) });
  }
  if (files_written.length === 0) return null;

  return {
    schema_version: SCHEMA_VERSION,
    // Deterministic: the same commit recorded twice is the same run, on any machine.
    run_id: uuidV5(`commit:${head}`),
    session_id: uuidV5(`commit-session:${head}`),
    parent_run_id: null,
    harness: { name: 'git', version: null },
    model: null,
    // A commit names a person, never the tool that typed it.
    actor: { type: 'human', id: author },
    task: {
      prompt_sha256: createHash('sha256').update(message, 'utf8').digest('hex'),
      ...(subject === '' ? {} : { intent: subject.length > INTENT_MAX ? `${subject.slice(0, INTENT_MAX - 1)}…` : subject }),
    },
    started_at: new Date(authored).toISOString(),
    ended_at: new Date(authored).toISOString(),
    tool_calls: [],
    files_read: [],
    files_written,
    env: {
      branch: tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd }),
      head_commit: head,
      worktree_id: worktreeId(repo.root),
      host_id: hostId(),
    },
  };
}

/** Real line ranges, straight from git's own diff. */
function hunksBetween(repo: Repo, pre: string | null, post: string): Run['files_written'][number]['hunks'] {
  const out =
    pre === null
      ? tryGit(['diff', '--no-color', '--no-ext-diff', '--unified=0', emptyBlob(repo), post], { cwd: repo.root })
      : tryGit(['diff', '--no-color', '--no-ext-diff', '--unified=0', pre, post], { cwd: repo.root });
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

/** git's empty blob, so a new file diffs against nothing. */
function emptyBlob(repo: Repo): string {
  return git(['hash-object', '-w', '--stdin'], { cwd: repo.root, input: '' });
}

function empty(oid: string): boolean {
  return /^0+$/.test(oid);
}
