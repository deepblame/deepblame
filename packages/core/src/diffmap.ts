import { tryGit } from './git';
import type { Repo } from './repo';

/**
 * Following a line from one state of a file to another.
 *
 * Both blame and revert need the same thing: the file has moved on since the
 * run wrote it, so where did line 40 end up, and is it even still there? This
 * is that question, answered once.
 */

export interface Hunk {
  /** 1-based start in the old side; 0 for an insertion before the first line. */
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  /** The old side's lines, without the leading '-'. */
  removed: string[];
  /** The new side's lines, without the leading '+'. */
  added: string[];
}

/** git's unified diff, hunks and all. Lines keep their exact text. */
export function parseDiff(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  for (const line of text.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null) {
      open = {
        oldStart: Number(header[1]),
        oldLen: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLen: header[4] === undefined ? 1 : Number(header[4]),
        removed: [],
        added: [],
      };
      hunks.push(open);
      continue;
    }
    if (open === null) continue;
    // Anything else before the first @@ is the file header, which we ignore.
    if (line.startsWith('-')) open.removed.push(line.slice(1));
    else if (line.startsWith('+')) open.added.push(line.slice(1));
    else if (line.startsWith(' ')) {
      open.removed.push(line.slice(1));
      open.added.push(line.slice(1));
    }
  }
  return hunks.sort((a, b) => a.oldStart - b.oldStart);
}

export interface DiffOptions {
  /** Lines of context. Zero by default: we want exact ranges. */
  unified?: number;
  /**
   * Treat a line that only changed in spacing as unchanged. This is what
   * makes a run through a formatter survivable: prettier rewrites the
   * indentation of a whole file without anybody rewriting the code.
   */
  ignoreWhitespace?: boolean;
}

/**
 * Two git objects, diffed. Null when git could not do it — usually an object
 * that is not there. An empty array means the two are identical, which is a
 * different answer, and confusing the two is how a revert quietly writes over
 * somebody's work.
 */
export function diffBlobs(repo: Repo, from: string, to: string, options: DiffOptions = {}): Hunk[] | null {
  if (from === to) return [];
  const args = ['diff', '--no-color', '--no-ext-diff', `--unified=${options.unified ?? 0}`];
  if (options.ignoreWhitespace === true) args.push('--ignore-all-space', '--ignore-blank-lines');
  const out = tryGit([...args, from, to], { cwd: repo.root });
  return out === null ? null : parseDiff(out);
}

/**
 * Follows a line from the old side of a diff into the new side. Null means a
 * later change replaced or deleted it, so nobody can claim it and nothing can
 * safely be spliced over it.
 */
export function lineMap(hunks: readonly Hunk[]): (line: number) => number | null {
  return (line: number) => {
    let offset = 0;
    for (const hunk of hunks) {
      if (hunk.oldLen === 0) {
        // A pure insertion, recorded as landing after `oldStart`.
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

/** A file's content lines, the way a diff counts them. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
}

export function joinLines(lines: readonly string[], trailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return trailingNewline ? `${lines.join('\n')}\n` : lines.join('\n');
}
