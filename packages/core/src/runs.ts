import { parseRun, type Run } from '@deepblame/protocol';
import { git } from './git';
import { readLedger } from './ledger';
import type { Repo } from './repo';

/**
 * Reading side of the ledger. Run records are plain blobs under `runs/`, so
 * everything here is git plumbing plus JSON; nothing is cached yet. An index
 * arrives when repositories get big enough to need one.
 */

export interface LedgerRun {
  run: Run;
  /** Object id of the record itself, which is also its short handle. */
  oid: string;
}

export interface ListOptions {
  /** Newest first; all of them when omitted. */
  limit?: number;
}

export function listRuns(repo: Repo, options: ListOptions = {}): LedgerRun[] {
  const head = readLedger(repo).head;
  if (head === null) return [];
  const cwd = repo.root;
  const listing = git(['ls-tree', '-r', head, '--', 'runs'], { cwd });
  const oids = listing
    .split('\n')
    .map((line) => line.match(/^\d+ blob ([0-9a-f]+)\t/)?.[1])
    .filter((oid): oid is string => oid !== undefined);
  if (oids.length === 0) return [];

  const runs: LedgerRun[] = [];
  for (const { oid, content } of catFile(repo, oids)) {
    const parsed = parseRun(safeJson(content));
    if (parsed.ok) runs.push({ run: parsed.value, oid });
  }
  runs.sort((a, b) => Date.parse(b.run.started_at) - Date.parse(a.run.started_at));
  return options.limit === undefined ? runs : runs.slice(0, options.limit);
}

/** Accepts a run id or any unambiguous prefix of one, like git does. */
export function findRun(repo: Repo, prefix: string): LedgerRun | null {
  const needle = prefix.toLowerCase().replace(/-/g, '');
  const matches = listRuns(repo).filter((entry) => entry.run.run_id.replace(/-/g, '').startsWith(needle));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** One git process for any number of objects; sizes are bytes, so parse bytes. */
function catFile(repo: Repo, oids: readonly string[]): { oid: string; content: string }[] {
  const out = git(['cat-file', '--batch'], { cwd: repo.root, input: `${oids.join('\n')}\n`, raw: true });
  const buffer = Buffer.from(out, 'utf8');
  const results: { oid: string; content: string }[] = [];
  let at = 0;
  while (at < buffer.length) {
    const newline = buffer.indexOf(0x0a, at);
    if (newline < 0) break;
    const header = buffer.toString('utf8', at, newline).split(' ');
    const oid = header[0];
    const size = Number(header[2]);
    if (oid === undefined || header[1] !== 'blob' || !Number.isFinite(size)) break;
    const start = newline + 1;
    results.push({ oid, content: buffer.toString('utf8', start, start + size) });
    at = start + size + 1;
  }
  return results;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
