import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_DIR, type Run } from '@deepblame/protocol';
import { diffBlobs, joinLines, lineMap, splitLines } from './diffmap';
import { git, tryGit } from './git';
import { currentNameOf, readRenames } from './rename';
import type { Repo } from './repo';
import { runsMatching } from './runs';

/**
 * Taking one agent's work back out, and nobody else's.
 *
 * The obvious version — put the file back the way it was before the agent
 * touched it — throws away everything written since. So this is a three-way
 * merge run backwards: the state the agent left is the base, the state before
 * it is the side we want, and the file as it stands now is ours. Changes made
 * after the agent survive; only the agent's own change is undone.
 *
 * Nothing is written until asked. A revert that surprises you once is a
 * revert nobody runs again.
 */

export type RevertStatus =
  /** The agent's change comes out cleanly. */
  | 'clean'
  /** Someone changed the same lines afterwards; both cannot hold. */
  | 'conflicted'
  /** Nothing to undo: the file no longer carries this run's change. */
  | 'unchanged'
  /** The ledger no longer holds the content this needs, so we will not guess. */
  | 'unverifiable'
  /** Not text, and changed since, so there is nothing sane to merge. */
  | 'binary';

export type RevertWrite =
  /** Byte-for-byte, straight out of the ledger. Safe for binary files. */
  | { kind: 'restore'; oid: string }
  /** The result of the three-way merge, conflict markers and all. */
  | { kind: 'merge'; content: string }
  /** The run created this file, so undoing it removes the file. */
  | { kind: 'delete' };

export interface RevertFile {
  /** Where the file lives now, which is where a revert would write. */
  path: string;
  /** The name in the ledger, when the file has been renamed since. */
  recordedAs: string | null;
  status: RevertStatus;
  /** What applying would do. Null when there is nothing to do. */
  write: RevertWrite | null;
  /** Lines this would change, so the plan can say how big it is. */
  changed: number;
}

export interface RevertPlan {
  /** The runs being undone, newest first. */
  runs: Run[];
  files: RevertFile[];
  /** True when the worktree has uncommitted changes of its own. */
  dirty: boolean;
  applied: boolean;
  /** Files actually written, once applied. */
  written: string[];
  /** Files skipped on apply because they were conflicted. */
  skipped: string[];
}

export interface RevertSelection {
  /** Run ids, or any unambiguous prefix of one, as git accepts. */
  runs?: readonly string[];
  /** Everything one harness did: every Claude Code turn, say. */
  agent?: string;
  /** Only runs that started within this many hours. */
  hours?: number;
  now?: Date;
}

/** What undoing these runs would do. Touches nothing. */
export function planRevert(repo: Repo, selection: RevertSelection): RevertPlan {
  const runs = select(repo, selection);
  const renames = readRenames(repo);
  const files = new Map<string, RevertFile>();
  const state = new Map<string, Current>();
  const scratch = mkdtempSync(join(stateDir(repo), 'revert-'));

  try {
    // Newest first, so a later change is undone before the one it sat on.
    for (const run of runs) {
      // An imported Agent Trace says which lines an agent wrote and nothing
      // about what stood there before, so there is nothing to put back. It
      // also leaves `pre_blob_sha` null, which for a run we watched means the
      // file was created — undoing that would delete a file nobody asked us
      // to delete. Reported work is reported, never reverted.
      if (run.harness.name === 'external') {
        for (const written of run.files_written) {
          const path = currentNameOf(renames, written.path);
          if (files.has(path)) continue;
          files.set(path, {
            path,
            recordedAs: path === written.path ? null : written.path,
            status: 'unverifiable',
            write: null,
            changed: 0,
          });
        }
        continue;
      }
      for (const written of run.files_written) {
        // The ledger holds the name the file had then; put the change back
        // where the file lives now.
        const path = currentNameOf(renames, written.path);
        const before = state.get(path) ?? currentOf(repo, path);
        const step = undoOne(repo, scratch, { ...written, path }, before);
        if (path !== written.path) step.file.recordedAs = written.path;
        state.set(path, step.after);
        files.set(path, merge(files.get(path), step.file));
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  return {
    runs,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    dirty: (tryGit(['status', '--porcelain=v1', '--untracked-files=no'], { cwd: repo.root }) ?? '') !== '',
    applied: false,
    written: [],
    skipped: [],
  };
}

export interface ApplyOptions {
  /**
   * Write conflicted files too, with the usual `<<<<<<<` markers, the way a
   * merge leaves them. Off by default: a conflict is a decision, not a chore.
   */
  conflicts?: boolean;
}

/** Writes the plan out. Returns the plan again, saying what it did. */
export function applyRevert(repo: Repo, plan: RevertPlan, options: ApplyOptions = {}): RevertPlan {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of plan.files) {
    if (file.write === null) continue;
    // A file the agent created but somebody has edited since is never removed
    // for you: there are no merge markers for "should this exist at all".
    const undecidable = file.status === 'conflicted' && file.write.kind === 'delete';
    if (file.status === 'conflicted' && (options.conflicts !== true || undecidable)) {
      skipped.push(file.path);
      continue;
    }
    if (file.status === 'binary' || file.status === 'unverifiable') {
      skipped.push(file.path);
      continue;
    }
    const full = join(repo.root, file.path);
    if (file.write.kind === 'delete') {
      rmSync(full, { force: true });
    } else if (file.write.kind === 'restore') {
      mkdirSync(dirname(full), { recursive: true });
      const bytes = execFileSync('git', ['cat-file', 'blob', file.write.oid], {
        cwd: repo.root,
        maxBuffer: 256 * 1024 * 1024,
      });
      writeFileSync(full, bytes);
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, file.write.content);
    }
    written.push(file.path);
  }
  return { ...plan, applied: true, written, skipped };
}

type Written = Run['files_written'][number];

/** The file as it stands, or as an earlier step of this plan would leave it. */
interface Current {
  /** Null when the file is not there. */
  oid: string | null;
  /** Null when absent or not text. */
  text: string | null;
}

interface Step {
  file: RevertFile;
  after: Current;
}

function select(repo: Repo, selection: RevertSelection): Run[] {
  const now = selection.now ?? new Date();
  return runsMatching(repo, {
    ids: selection.runs,
    agent: selection.agent,
    since: selection.hours === undefined ? undefined : new Date(now.getTime() - selection.hours * 3_600_000),
  }).map((entry) => entry.run);
}

/** Undoes one file's worth of one run. */
function undoOne(repo: Repo, scratch: string, written: Written, current: Current): Step {
  const unchanged = (): Step => ({
    file: { path: written.path, recordedAs: null, status: 'unchanged', write: null, changed: 0 },
    after: current,
  });
  const unverifiable = (): Step => ({
    file: { path: written.path, recordedAs: null, status: 'unverifiable', write: null, changed: 0 },
    after: current,
  });

  // The run created this file. Undoing it means the file should not be here.
  if (written.pre_blob_sha === null) {
    if (current.oid === null) return unchanged();
    const touchedSince = current.oid !== written.post_blob_sha;
    return {
      file: {
        path: written.path,
        recordedAs: null,
        status: touchedSince ? 'conflicted' : 'clean',
        write: { kind: 'delete' },
        changed: current.text === null ? 0 : countLines(current.text),
      },
      after: touchedSince ? current : { oid: null, text: null },
    };
  }

  // The ledger has to still hold what came before, or there is nothing to restore.
  if (!hasBlob(repo, written.pre_blob_sha)) return unverifiable();

  // The run deleted this file. Undoing it puts the file back.
  if (written.post_blob_sha === null) {
    if (current.oid !== null && current.oid !== written.pre_blob_sha) {
      // Someone has already recreated it, differently. Theirs wins.
      return { file: { path: written.path, recordedAs: null, status: 'conflicted', write: null, changed: 0 }, after: current };
    }
    if (current.oid === written.pre_blob_sha) return unchanged();
    const restored = blobText(repo, written.pre_blob_sha);
    return {
      file: {
        path: written.path,
        recordedAs: null,
        status: 'clean',
        write: { kind: 'restore', oid: written.pre_blob_sha },
        changed: restored === null ? 0 : countLines(restored),
      },
      after: { oid: written.pre_blob_sha, text: restored },
    };
  }

  if (current.oid === null) return unchanged(); // Deleted since; nothing left to undo.
  if (current.oid === written.pre_blob_sha) return unchanged(); // Already back where it was.

  // Nothing has touched the file since the run, so the revert is exact —
  // and exact means we can do it byte for byte, binary files included.
  if (current.oid === written.post_blob_sha) {
    const restored = blobText(repo, written.pre_blob_sha);
    return {
      file: {
        path: written.path,
        recordedAs: null,
        status: 'clean',
        write: { kind: 'restore', oid: written.pre_blob_sha },
        changed: restored === null || current.text === null ? 0 : changedLines(current.text, restored),
      },
      after: { oid: written.pre_blob_sha, text: restored },
    };
  }

  // The file moved on after the run, so the agent's change has to be picked
  // back out of it.
  if (!hasBlob(repo, written.post_blob_sha)) return unverifiable();
  const left = blobText(repo, written.post_blob_sha);
  const before = blobText(repo, written.pre_blob_sha);
  if (left === null || before === null || current.text === null) {
    return { file: { path: written.path, recordedAs: null, status: 'binary', write: null, changed: 0 }, after: current };
  }

  const spliced = splice(repo, current, written.post_blob_sha, written.pre_blob_sha, before);
  if (spliced !== null) {
    return {
      file: {
        path: written.path,
        recordedAs: null,
        status: 'clean',
        write: { kind: 'merge', content: spliced },
        changed: changedLines(current.text, spliced),
      },
      after: { oid: hashText(repo, spliced), text: spliced },
    };
  }

  // It could not be picked out cleanly. Fall back to git's own three-way
  // merge purely for the conflict markers, so what lands in the editor looks
  // like every other conflict the person has ever resolved.
  const merged = mergeFile(scratch, current.text, left, before);
  return {
    file: {
      path: written.path,
      recordedAs: null,
      status: 'conflicted',
      write: { kind: 'merge', content: merged.content },
      // What is in dispute is the run's own lines, so that is the number to
      // show. Measuring the merged text instead counted the conflict markers
      // and both sides of every disagreement: one line of an agent's work was
      // announced in the plan as seven, on the screen where somebody decides
      // whether to trust the undo.
      changed: changedLines(before, left),
    },
    after: current,
  };
}

/**
 * The surgical part.
 *
 * A generic three-way merge conflicts whenever two changes land on adjacent
 * lines, which between an agent and a person is most of the time. We can do
 * better, because the ledger tells us precisely which lines the run changed:
 * diff what it left against what was there before, follow each of those line
 * ranges into the file as it stands now, check the text is still exactly what
 * the run left, and put the old lines back in its place.
 *
 * Returns null when any part of the change cannot be placed with certainty.
 * Guessing here would silently destroy somebody's work.
 */
function splice(repo: Repo, current: Current, post: string, pre: string, preText: string): string | null {
  if (current.text === null || current.oid === null) return null;
  const undo = diffBlobs(repo, post, pre);
  const moved = diffBlobs(repo, post, current.oid);
  if (undo === null || undo.length === 0 || moved === null) return null;
  const drift = lineMap(moved);
  const lines = splitLines(current.text);

  // Back to front, so earlier edits do not move later ones.
  const edits: { at: number; remove: number; insert: string[] }[] = [];
  for (const hunk of undo) {
    if (hunk.oldLen === 0) {
      // The run deleted these lines; putting them back needs an anchor.
      if (hunk.oldStart === 0) {
        edits.push({ at: 0, remove: 0, insert: hunk.added });
        continue;
      }
      const anchor = drift(hunk.oldStart);
      if (anchor === null) return null;
      edits.push({ at: anchor, remove: 0, insert: hunk.added });
      continue;
    }
    const from = drift(hunk.oldStart);
    const to = drift(hunk.oldStart + hunk.oldLen - 1);
    // The range has to have survived whole and unbroken.
    if (from === null || to === null || to - from !== hunk.oldLen - 1) return null;
    const standing = lines.slice(from - 1, to);
    if (standing.length !== hunk.removed.length) return null;
    for (let at = 0; at < standing.length; at += 1) if (standing[at] !== hunk.removed[at]) return null;
    edits.push({ at: from - 1, remove: hunk.oldLen, insert: hunk.added });
  }

  const out = [...lines];
  for (const edit of edits.sort((a, b) => b.at - a.at)) out.splice(edit.at, edit.remove, ...edit.insert);

  // If the revert put the file all the way back, hand back the pre-image
  // itself, so even the trailing newline is exactly as it was.
  const preLines = splitLines(preText);
  if (out.length === preLines.length && out.every((line, at) => line === preLines[at])) return preText;
  return joinLines(out, current.text.endsWith('\n'));
}

/** One file, several runs: the worst status wins, the last write stands. */
function merge(existing: RevertFile | undefined, step: RevertFile): RevertFile {
  if (existing === undefined) return step;
  const rank: Record<RevertStatus, number> = { unchanged: 0, clean: 1, binary: 2, unverifiable: 3, conflicted: 4 };
  const status = rank[step.status] > rank[existing.status] ? step.status : existing.status;
  return {
    path: step.path,
    recordedAs: step.recordedAs ?? existing.recordedAs,
    status,
    write: step.write ?? existing.write,
    changed: Math.max(existing.changed, step.changed),
  };
}

/**
 * git's own three-way merge, on three temporary files. Using git rather than
 * a differ of our own means the result, and the conflict markers, match what
 * every other tool in the repository would have produced.
 */
function mergeFile(scratch: string, ours: string, base: string, theirs: string): { content: string; conflicted: boolean } {
  const files = {
    ours: join(scratch, 'current'),
    base: join(scratch, 'agent-left'),
    theirs: join(scratch, 'before-agent'),
  };
  writeFileSync(files.ours, ours);
  writeFileSync(files.base, base);
  writeFileSync(files.theirs, theirs);
  const args = [
    'merge-file',
    '-p',
    '--diff3',
    '-L',
    'yours, as it stands',
    '-L',
    'what the agent left',
    '-L',
    'before the agent',
    files.ours,
    files.base,
    files.theirs,
  ];
  try {
    return { content: execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), conflicted: false };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string };
    // A positive status is the number of conflicts; anything else means git gave up.
    if (typeof failed.status === 'number' && failed.status > 0 && typeof failed.stdout === 'string') {
      return { content: failed.stdout, conflicted: true };
    }
    return { content: ours, conflicted: true };
  } finally {
    for (const file of Object.values(files)) rmSync(file, { force: true });
  }
}

function currentOf(repo: Repo, path: string): Current {
  const full = join(repo.root, path);
  if (!existsSync(full)) return { oid: null, text: null };
  let bytes: Buffer;
  try {
    bytes = readFileSync(full);
  } catch {
    return { oid: null, text: null };
  }
  return {
    // Hashed from the file itself, not from a string, so binary stays intact,
    // and written, because the next step diffs against it.
    oid: git(['hash-object', '-w', '--no-filters', '--', full], { cwd: repo.root }),
    text: isBinary(bytes) ? null : bytes.toString('utf8'),
  };
}

function hashText(repo: Repo, text: string): string {
  return git(['hash-object', '-w', '--no-filters', '--stdin'], { cwd: repo.root, input: text });
}

function hasBlob(repo: Repo, oid: string): boolean {
  return tryGit(['cat-file', '-e', `${oid}^{blob}`], { cwd: repo.root }) !== null;
}

/** Blob contents as text, or null when it is not text we can merge. */
function blobText(repo: Repo, oid: string): string | null {
  let bytes: Buffer;
  try {
    bytes = execFileSync('git', ['cat-file', 'blob', oid], { cwd: repo.root, maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
  return isBinary(bytes) ? null : bytes.toString('utf8');
}

/** The same test git uses: a NUL byte early on means binary. */
function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

function stateDir(repo: Repo): string {
  const dir = join(repo.root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** How many lines differ, ignoring the identical head and tail. */
function changedLines(before: string, after: string): number {
  if (before === after) return 0;
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  return Math.max(a.length - head - tail, b.length - head - tail);
}
