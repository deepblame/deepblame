import type { Run } from '@deepblame/protocol';
import type { Repo } from './repo';
import { hydrate, readIndex, type IndexedRun } from './runindex';

/**
 * Reading side of the ledger. Run records are plain blobs under `runs/`, and
 * everything here goes through the index first: choose the runs you need from
 * the cache, then fetch only those records. The alternative — parsing every
 * record on every command — is what made this slow.
 */

export interface LedgerRun {
  run: Run;
  /** Object id of the record itself. */
  oid: string;
}

export interface ListOptions {
  /** Newest first; all of them when omitted. */
  limit?: number;
}

export function listRuns(repo: Repo, options: ListOptions = {}): LedgerRun[] {
  const index = readIndex(repo);
  const wanted = options.limit === undefined ? index : index.slice(0, options.limit);
  return ordered(hydrate(repo, wanted));
}

/** The index itself, for commands that only need to count or filter. */
export function indexedRuns(repo: Repo): IndexedRun[] {
  return readIndex(repo);
}

/**
 * Runs that wrote any of these paths. This is the one that matters: blame on a
 * single file should not have to read the whole ledger.
 */
export function runsTouching(repo: Repo, paths: ReadonlySet<string>): LedgerRun[] {
  const wanted = readIndex(repo).filter((entry) => entry.paths.some((path) => paths.has(path)));
  return ordered(hydrate(repo, wanted));
}

export interface RunFilter {
  /** Run ids, or any unambiguous prefix of one. */
  ids?: readonly string[];
  agent?: string;
  /** Only runs that started at or after this moment. */
  since?: Date;
}

export function runsMatching(repo: Repo, filter: RunFilter): LedgerRun[] {
  const ids = (filter.ids ?? []).map((id) => id.toLowerCase().replace(/-/g, ''));
  const since = filter.since?.getTime();
  const wanted = readIndex(repo).filter((entry) => {
    if (ids.length > 0 && !ids.some((id) => entry.id.replace(/-/g, '').startsWith(id))) return false;
    if (filter.agent !== undefined && entry.agent !== filter.agent) return false;
    if (since !== undefined && Date.parse(entry.at) < since) return false;
    return true;
  });
  return ordered(hydrate(repo, wanted));
}

/** Accepts a run id or any unambiguous prefix of one, like git does. */
export function findRun(repo: Repo, prefix: string): LedgerRun | null {
  const needle = prefix.toLowerCase().replace(/-/g, '');
  const matches = readIndex(repo).filter((entry) => entry.id.replace(/-/g, '').startsWith(needle));
  if (matches.length !== 1) return null;
  return hydrate(repo, matches)[0] ?? null;
}

function ordered(runs: LedgerRun[]): LedgerRun[] {
  return runs.sort(
    (a, b) =>
      Date.parse(b.run.started_at) - Date.parse(a.run.started_at) ||
      (a.run.run_id < b.run.run_id ? -1 : a.run.run_id > b.run.run_id ? 1 : 0),
  );
}
