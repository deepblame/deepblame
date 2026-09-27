import { tryGit } from './git';
import type { Repo } from './repo';

/**
 * Following a file through its renames.
 *
 * The ledger records the path a run wrote at the time it wrote it. Files move:
 * someone runs `git mv`, a refactor shuffles the tree, a folder is renamed.
 * Without this, every rename wipes the history of the file it moved — which is
 * exactly the moment people most want to know who wrote what.
 *
 * Both directions matter. Blame starts from the name the file has now and asks
 * what it used to be called; revert starts from the name in the ledger and asks
 * where that file lives today.
 */

/** How far back to look for renames. One git process, bounded on purpose. */
const HISTORY_DEPTH = 1000;
/** A chain longer than this is a loop, or somebody is playing games. */
const MAX_HOPS = 32;

export interface RenameMap {
  /** old path → what it became. */
  forward: Map<string, string>;
  /** new path → what it was before. */
  backward: Map<string, string>;
}

/**
 * Every rename git knows about: committed ones from the recent history, plus
 * any that are staged but not yet committed.
 */
export function readRenames(repo: Repo): RenameMap {
  const forward = new Map<string, string>();
  const backward = new Map<string, string>();
  const add = (from: string, to: string): void => {
    if (from === '' || to === '' || from === to) return;
    forward.set(from, to);
    backward.set(to, from);
  };

  // Committed renames, oldest first so a file renamed twice ends up pointing
  // at its latest name.
  const log = tryGit(
    ['log', '--reverse', '-z', '-M', '--diff-filter=R', '--name-status', '--format=', `-n${HISTORY_DEPTH}`],
    { cwd: repo.root, raw: true },
  );
  if (log !== null) {
    const tokens = log.split('\u0000');
    for (let at = 0; at < tokens.length; at += 1) {
      const token = tokens[at];
      if (token === undefined || !/^R\d*$/.test(token)) continue;
      add(tokens[at + 1] ?? '', tokens[at + 2] ?? '');
      at += 2;
    }
  }

  // Renames that are staged but not committed yet. Porcelain v1 with -z puts
  // the new path first, then the old one, each NUL-terminated.
  const status = tryGit(['status', '--porcelain=v1', '-z', '--untracked-files=no'], { cwd: repo.root, raw: true });
  if (status !== null) {
    const entries = status.split('\u0000');
    for (let at = 0; at < entries.length; at += 1) {
      const entry = entries[at];
      if (entry === undefined || entry.length < 4) continue;
      const code = entry.slice(0, 2);
      if (!code.includes('R') && !code.includes('C')) continue;
      add(entries[at + 1] ?? '', entry.slice(3));
      at += 1;
    }
  }

  return { forward, backward };
}

/** Every name this file has gone by, newest first. Always includes `path`. */
export function aliasesOf(renames: RenameMap, path: string): string[] {
  return walk(renames.backward, path);
}

/** Where a path recorded in the ledger lives now, if it has moved. */
export function currentNameOf(renames: RenameMap, path: string): string {
  const chain = walk(renames.forward, path);
  return chain[chain.length - 1] ?? path;
}

function walk(links: Map<string, string>, from: string): string[] {
  const seen = [from];
  let at = from;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const next = links.get(at);
    if (next === undefined || seen.includes(next)) break;
    seen.push(next);
    at = next;
  }
  return seen;
}
