import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_INDEX_FILE, RUN_INDEX_VERSION, STATE_DIR, parseRun, type Run } from '@deepblame/protocol';
import { git, tryGit } from './git';
import { readLedger } from './ledger';
import type { Repo } from './repo';

/**
 * A cache of what is in the ledger.
 *
 * Without it, every command parses every run: `blame` on one file reads and
 * validates a thousand records to find the three that touched it, and it gets
 * slower every week you use the tool. A tool that gets slower the more history
 * it has is a tool people stop running.
 *
 * The index holds only what is needed to *choose* runs — when, which agent,
 * which paths, what it cost — plus the object id of the full record, fetched
 * on demand. It is a cache and nothing more: delete it and the next command
 * rebuilds it from the ledger, which stays the only source of truth.
 *
 * The file is append-only NDJSON with the ledger head written as a trailer, so
 * a crash mid-write leaves entries that the reader discards rather than a
 * corrupt file that has to be recognised as such.
 */

export interface IndexedRun {
  /** run_id. */
  id: string;
  /** Object id of the full record, for `git cat-file`. */
  oid: string;
  /** started_at. */
  at: string;
  /** ended_at, or null while the run is open. */
  end: string | null;
  agent: string;
  model: string | null;
  /** Paths the run wrote, as the ledger spells them. */
  paths: string[];
  tools: number;
  cost: { in: number; out: number; cw: number; cr: number; usd: number | null } | null;
}

interface Header {
  v: number;
}

interface Trailer {
  head: string;
}

/** Newest first, the same order every command wants. */
export function readIndex(repo: Repo): IndexedRun[] {
  const head = readLedger(repo).head;
  if (head === null) return [];
  const file = indexPath(repo);
  const loaded = load(file);
  if (loaded !== null && loaded.head === head) return loaded.runs;

  // The head moved. Add only what is new, if we can work out what that is.
  if (loaded !== null && reachable(repo, loaded.head)) {
    const added = runsBetween(repo, loaded.head, head);
    if (added !== null) {
      append(file, added, head);
      return sort([...loaded.runs, ...added]);
    }
  }
  const all = entriesOf(repo, listOids(repo, head));
  rebuild(file, all, head);
  return sort(all);
}

/** The full records behind index entries, in one git process. */
export function hydrate(repo: Repo, entries: readonly IndexedRun[]): { run: Run; oid: string }[] {
  if (entries.length === 0) return [];
  const runs: { run: Run; oid: string }[] = [];
  for (const { oid, content } of catFile(repo, entries.map((entry) => entry.oid))) {
    const parsed = parseRun(safeJson(content));
    if (parsed.ok) runs.push({ run: parsed.value, oid });
  }
  return runs;
}

/** Thrown away rather than repaired when anything about it looks wrong. */
export function forgetIndex(repo: Repo): void {
  rmSync(indexPath(repo), { force: true });
}

function indexPath(repo: Repo): string {
  return join(repo.root, STATE_DIR, RUN_INDEX_FILE);
}

function load(file: string): { runs: IndexedRun[]; head: string } | null {
  if (!existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((line) => line !== '');
  const first = lines.shift();
  if (first === undefined) return null;
  const header = safeJson(first) as Header | null;
  if (header === null || header.v !== RUN_INDEX_VERSION) return null;

  // Entries written after the last trailer belong to a write that never
  // finished, so they are not trusted.
  const runs: IndexedRun[] = [];
  let head: string | null = null;
  let committed = 0;
  for (const line of lines) {
    const value = safeJson(line);
    if (value === null || typeof value !== 'object') return null;
    if ('head' in value) {
      head = (value as Trailer).head;
      committed = runs.length;
      continue;
    }
    if (!isEntry(value)) return null;
    runs.push(value);
  }
  if (head === null) return null;
  return { runs: sort(runs.slice(0, committed)), head };
}

function rebuild(file: string, runs: readonly IndexedRun[], head: string): void {
  const body = [JSON.stringify({ v: RUN_INDEX_VERSION }), ...runs.map((run) => JSON.stringify(run)), JSON.stringify({ head })];
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(temp, `${body.join('\n')}\n`);
    renameSync(temp, file);
  } catch {
    rmSync(temp, { force: true });
  }
}

function append(file: string, runs: readonly IndexedRun[], head: string): void {
  const body = [...runs.map((run) => JSON.stringify(run)), JSON.stringify({ head })];
  try {
    appendFileSync(file, `${body.join('\n')}\n`);
  } catch {
    // A cache that cannot be written is still a correct answer, just a slow one.
  }
}

/** Object ids of every run record in the ledger at `head`. */
function listOids(repo: Repo, head: string): string[] {
  const listing = tryGit(['ls-tree', '-r', head, '--', 'runs'], { cwd: repo.root });
  if (listing === null) return [];
  return listing
    .split('\n')
    .map((line) => line.match(/^\d+ blob ([0-9a-f]+)\t/)?.[1])
    .filter((oid): oid is string => oid !== undefined);
}

/** Run records that appeared between two ledger commits. Null when git cannot say. */
function runsBetween(repo: Repo, from: string, to: string): IndexedRun[] | null {
  const listing = tryGit(['diff-tree', '-r', '--no-commit-id', '--diff-filter=AM', from, to, '--', 'runs'], {
    cwd: repo.root,
  });
  if (listing === null) return null;
  const oids: string[] = [];
  for (const line of listing.split('\n')) {
    const match = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [AM]\d*\t/.exec(line);
    if (match?.[1] !== undefined) oids.push(match[1]);
  }
  return entriesOf(repo, oids);
}

function reachable(repo: Repo, oid: string): boolean {
  return tryGit(['cat-file', '-e', `${oid}^{commit}`], { cwd: repo.root }) !== null;
}

function entriesOf(repo: Repo, oids: readonly string[]): IndexedRun[] {
  if (oids.length === 0) return [];
  const entries: IndexedRun[] = [];
  for (const { oid, content } of catFile(repo, oids)) {
    const parsed = parseRun(safeJson(content));
    if (parsed.ok) entries.push(entryOf(parsed.value, oid));
  }
  return entries;
}

function entryOf(run: Run, oid: string): IndexedRun {
  const spend = run.cost;
  return {
    id: run.run_id,
    oid,
    at: run.started_at,
    end: run.ended_at,
    agent: run.harness.name,
    model: run.model?.name ?? null,
    paths: run.files_written.map((written) => written.path),
    tools: run.tool_calls.length,
    cost:
      spend === undefined
        ? null
        : {
            in: spend.input_tokens,
            out: spend.output_tokens,
            cw: spend.cache_write_tokens ?? 0,
            cr: spend.cache_read_tokens ?? 0,
            usd: spend.usd,
          },
  };
}

function isEntry(value: object): value is IndexedRun {
  const entry = value as Partial<IndexedRun>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.oid === 'string' &&
    typeof entry.at === 'string' &&
    typeof entry.agent === 'string' &&
    Array.isArray(entry.paths)
  );
}

function sort(runs: IndexedRun[]): IndexedRun[] {
  // Newest first, with the run id breaking ties so the order never wobbles
  // between two runs recorded in the same millisecond.
  return [...runs].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
