import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BLOBS_DIR,
  CLI_NAME,
  LEDGER_IDENTITY,
  LEDGER_REF,
  QUEUE_FILE,
  SCHEMA_VERSION,
  SEAL_INDEX_FILE,
  SEAL_LOCK_FILE,
  STATE_DIR,
  parseRun,
  type HarnessId,
  type QueueEvent,
  type QueueHunk,
  type Run,
} from '@deepblame/protocol';
import { GitError, git, tryGit } from './git';
import { hostId, sessionUuid, worktreeId } from './ids';
import { createGenesis, readLedger } from './ledger';
import { priceUsd, readRates, type RateTable } from './pricing';
import type { Repo } from './repo';
import { readTranscriptUsage } from './transcript';

/**
 * The cold path. Turns captured events into run records and commits them to
 * the ledger ref with git plumbing: no checkout, no index of the user's, no
 * hooks, no signature. Runs after the agent has stopped, so it may take its
 * time and validate everything it writes.
 */

/** A lock this old belonged to a process that died mid-seal. */
const STALE_LOCK_MS = 60_000;
const MAX_ATTEMPTS = 3;

export interface SealResult {
  /** Runs written to the ledger. */
  sealed: number;
  /** Queue events consumed. */
  events: number;
  /** Events left in the queue because their turn is still open. */
  pending: number;
  /** Turns dropped because they did not validate, with the reason. */
  rejected: string[];
  head: string | null;
  /** Another seal holds the lock; nothing was done. */
  busy: boolean;
}

interface QueueLine {
  /** Verbatim line including its newline, so leftovers go back unchanged. */
  raw: string;
  event: QueueEvent;
}

interface Segment {
  agent: HarnessId;
  session: string;
  lines: QueueLine[];
  /** The turn ended, so it can be sealed whole. */
  closed: boolean;
}

export function seal(repo: Repo, options: { now?: Date } = {}): SealResult {
  const now = options.now ?? new Date();
  const stateDir = join(repo.root, STATE_DIR);
  const queuePath = join(stateDir, QUEUE_FILE);
  const idle: SealResult = { sealed: 0, events: 0, pending: 0, rejected: [], head: readLedger(repo).head, busy: false };
  if (!existsSync(queuePath)) return idle;

  const lock = join(stateDir, SEAL_LOCK_FILE);
  if (!acquire(lock)) return { ...idle, busy: true };
  try {
    const buffer = readFileSync(queuePath);
    if (buffer.length === 0) return idle;
    const { lines, tail } = readQueue(buffer);
    const segments = segmentsOf(lines);
    const closed = segments.filter((segment) => segment.closed);
    const leftover = segments.filter((segment) => !segment.closed).flatMap((segment) => segment.lines);

    if (closed.length === 0) {
      return { ...idle, events: 0, pending: leftover.length };
    }

    const env = runEnv(repo);
    const transcripts = transcriptsOf(lines);
    const rates = readRates(repo.root);
    const rejected: string[] = [];
    const records: { id: string; json: string }[] = [];
    /** Every file state the sealed runs refer to, so the ledger can keep it. */
    const blobs = new Set<string>();
    for (const segment of closed) {
      const candidate = runOf(segment, env, transcripts.get(sessionKey(segment.agent, segment.session)) ?? null, rates);
      if (candidate === null) continue;
      const parsed = parseRun(candidate);
      if (!parsed.ok) {
        rejected.push(`${segment.session}: ${parsed.issues.join('; ')}`);
        continue;
      }
      records.push({ id: parsed.value.run_id, json: `${JSON.stringify(parsed.value, null, 2)}\n` });
      for (const file of parsed.value.files_written) {
        if (file.pre_blob_sha !== null) blobs.add(file.pre_blob_sha);
        if (file.post_blob_sha !== null) blobs.add(file.post_blob_sha);
      }
    }

    const head = records.length > 0 ? commitRuns(repo, records, [...blobs], now) : readLedger(repo).head;
    writeQueue(queuePath, buffer.length, leftover, tail);
    return {
      sealed: records.length,
      events: closed.reduce((total, segment) => total + segment.lines.length, 0),
      pending: leftover.length,
      rejected,
      head,
      busy: false,
    };
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Writes finished runs straight into the ledger, without the queue. Used by
 * the git fallback, where the commit itself is already a complete record.
 * A run the ledger already holds is left alone, so recording twice is safe.
 */
export function appendRuns(repo: Repo, runs: readonly unknown[], now: Date = new Date()): SealResult {
  const records: { id: string; json: string }[] = [];
  const blobs = new Set<string>();
  const rejected: string[] = [];
  const head = readLedger(repo).head;

  for (const candidate of runs) {
    const parsed = parseRun(candidate);
    if (!parsed.ok) {
      rejected.push(parsed.issues.join('; '));
      continue;
    }
    const id = parsed.value.run_id;
    if (head !== null && tryGit(['cat-file', '-e', `${head}:runs/${id}.json`], { cwd: repo.root }) !== null) continue;
    records.push({ id, json: `${JSON.stringify(parsed.value, null, 2)}\n` });
    for (const file of parsed.value.files_written) {
      if (file.pre_blob_sha !== null) blobs.add(file.pre_blob_sha);
      if (file.post_blob_sha !== null) blobs.add(file.post_blob_sha);
    }
  }

  return {
    sealed: records.length,
    events: 0,
    pending: 0,
    rejected,
    head: records.length > 0 ? commitRuns(repo, records, [...blobs], now) : head,
    busy: false,
  };
}

/** One writer at a time. A crashed seal leaves a lock behind; it expires. */
function acquire(lock: string): boolean {
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
        writeFileSync(lock, `${process.pid}\n`);
        return true;
      }
    } catch {
      // The lock vanished between the two calls: let the next run have it.
    }
    return false;
  }
}

/** Splits the queue into parsed lines, keeping a half-written last line aside. */
function readQueue(buffer: Buffer): { lines: QueueLine[]; tail: string } {
  const text = buffer.toString('utf8');
  const complete = text.endsWith('\n');
  const parts = text.split('\n');
  const tail = complete ? '' : (parts.pop() ?? '');
  const lines: QueueLine[] = [];
  for (const part of parts) {
    if (part.trim() === '') continue;
    const event = parseEvent(part);
    if (event !== null) lines.push({ raw: `${part}\n`, event });
  }
  return { lines, tail };
}

function parseEvent(line: string): QueueEvent | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) return null;
    const event = value as Partial<QueueEvent>;
    if (typeof event.k !== 'string' || typeof event.ts !== 'string') return null;
    if (typeof event.agent !== 'string' || typeof event.session !== 'string') return null;
    return event as QueueEvent;
  } catch {
    return null;
  }
}

/**
 * One segment per turn. A prompt opens a turn, an end closes it, and a second
 * prompt closes the one before it. Events that arrive before the first prompt
 * (the session itself) belong to the turn that follows them.
 */
function segmentsOf(lines: readonly QueueLine[]): Segment[] {
  const bySession = new Map<string, Segment[]>();
  for (const line of lines) {
    const key = `${line.event.agent}\u0000${line.event.session}`;
    const list = bySession.get(key) ?? [];
    if (list.length === 0) bySession.set(key, list);
    let current = list[list.length - 1];
    if (current !== undefined && current.closed) current = undefined;
    if (current !== undefined && line.event.k === 'prompt' && current.lines.some((l) => l.event.k === 'prompt')) {
      current.closed = true;
      current = undefined;
    }
    if (current === undefined) {
      current = { agent: line.event.agent, session: line.event.session, lines: [], closed: false };
      list.push(current);
    }
    current.lines.push(line);
    if (line.event.k === 'end') current.closed = true;
  }
  return [...bySession.values()].flat();
}

interface RunEnv {
  branch: string | null;
  head: string | null;
  worktree: string;
  host: string;
}

function runEnv(repo: Repo): RunEnv {
  return {
    branch: tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo.root }),
    head: tryGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: repo.root }),
    worktree: worktreeId(repo.root),
    host: hostId(),
  };
}

function sessionKey(agent: string, session: string): string {
  return `${agent}\u0000${session}`;
}

/**
 * Where each session keeps its conversation log. The harness reports it once,
 * at the start, but every turn of that session needs it to price itself.
 */
function transcriptsOf(lines: readonly QueueLine[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const { event } of lines) {
    if (event.k === 'session' && event.transcript !== null) {
      paths.set(sessionKey(event.agent, event.session), event.transcript);
    }
  }
  return paths;
}

/** Null for a turn that touched nothing: a ledger entry for it would be noise. */
function runOf(segment: Segment, env: RunEnv, transcript: string | null, rates: RateTable): Run | null {
  const events = segment.lines.map((line) => line.event);
  const first = events[0];
  const last = events[events.length - 1];
  if (first === undefined || last === undefined) return null;

  const prompt = events.find((event) => event.k === 'prompt');
  const end = events.find((event) => event.k === 'end');
  const toolCalls = events
    .filter((event): event is Extract<QueueEvent, { k: 'tool' }> => event.k === 'tool')
    .map((event) => ({
      name: event.name,
      args_sha256: event.args_sha256,
      result_sha256: event.result_sha256,
      ts: event.ts,
      ok: event.ok,
    }));

  const reads = new Set<string>();
  for (const event of events) if (event.k === 'read') reads.add(event.path);

  const writes = collectWrites(events);
  if (toolCalls.length === 0 && writes.length === 0 && reads.size === 0) return null;

  const startedAt = (prompt ?? first).ts;
  const endedAt = (end ?? last).ts;
  const usage = transcript === null ? null : readTranscriptUsage(transcript, startedAt, endedAt);
  const price = usage === null ? null : priceUsd(usage, rates);

  const run: Run = {
    schema_version: SCHEMA_VERSION,
    run_id: randomUUID(),
    session_id: sessionUuid(segment.agent, segment.session),
    parent_run_id: null,
    harness: { name: segment.agent, version: null },
    model: usage?.model == null ? null : { provider: providerOf(usage.model), name: usage.model, version: null },
    actor: { type: 'agent', id: segment.agent },
    task: {
      prompt_sha256: prompt?.k === 'prompt' ? prompt.sha256 : null,
      ...(prompt?.k === 'prompt' && prompt.text !== undefined ? { prompt_text: prompt.text } : {}),
      ...(prompt?.k === 'prompt' && prompt.intent !== null ? { intent: prompt.intent } : {}),
    },
    started_at: startedAt,
    ended_at: endedAt,
    tool_calls: toolCalls,
    files_read: [...reads].map((path) => ({ path, blob_sha: null })),
    files_written: writes,
    ...(usage === null || price === null
      ? {}
      : {
          cost: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            ...(usage.cache_write_tokens > 0 ? { cache_write_tokens: usage.cache_write_tokens } : {}),
            ...(usage.cache_read_tokens > 0 ? { cache_read_tokens: usage.cache_read_tokens } : {}),
            usd: price.usd,
            source: price.source,
          },
        }),
    env: { branch: env.branch, head_commit: env.head, worktree_id: env.worktree, host_id: env.host },
  };
  return run;
}

/** Enough to tell whose bill it is; the exact vendor list is not our business. */
function providerOf(model: string): string {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('gemini')) return 'google';
  if (model.startsWith('grok')) return 'xai';
  return 'unknown';
}

interface WriteState {
  pre: string | null;
  preSeen: boolean;
  preLines: number;
  post: string | null;
  postLines: number;
  hunks: QueueHunk[];
  wholeFile: boolean;
}

/** Several edits to one file in one turn are one entry: first pre, last post. */
function collectWrites(events: readonly QueueEvent[]): Run['files_written'] {
  const byPath = new Map<string, WriteState>();
  const state = (path: string): WriteState => {
    const found = byPath.get(path);
    if (found !== undefined) return found;
    const fresh: WriteState = {
      pre: null,
      preSeen: false,
      preLines: 0,
      post: null,
      postLines: 0,
      hunks: [],
      wholeFile: false,
    };
    byPath.set(path, fresh);
    return fresh;
  };

  for (const event of events) {
    if (event.k === 'write-pre') {
      const entry = state(event.path);
      if (!entry.preSeen) {
        entry.pre = event.blob;
        entry.preLines = event.lines;
        entry.preSeen = true;
      }
    } else if (event.k === 'write') {
      const entry = state(event.path);
      entry.post = event.blob;
      entry.postLines = event.lines;
      entry.hunks.push(...event.hunks);
      if (event.hunks.length === 0 && event.tool !== 'Edit' && event.tool !== 'MultiEdit') entry.wholeFile = true;
    }
  }

  const written: Run['files_written'] = [];
  for (const [path, entry] of byPath) {
    // A write we could not hash at either end tells us nothing; the schema agrees.
    if (entry.pre === null && entry.post === null) continue;
    const hunks =
      entry.hunks.length > 0
        ? entry.hunks
        : entry.wholeFile
          ? [{ old_start: 1, old_len: entry.preLines, new_start: 1, new_len: entry.postLines }]
          : [];
    written.push({ path, pre_blob_sha: entry.pre, post_blob_sha: entry.post, hunks });
  }
  return written;
}

/**
 * Writes the records into the ledger tree through a throwaway index, so the
 * user's own index is never touched, then moves the ref only if nobody else
 * moved it first.
 */
function commitRuns(
  repo: Repo,
  records: readonly { id: string; json: string }[],
  blobs: readonly string[],
  now: Date,
): string {
  const cwd = repo.root;
  const indexFile = join(repo.root, STATE_DIR, SEAL_INDEX_FILE);
  const date = now.toISOString();
  const message = `${CLI_NAME}: seal ${records.length} run${records.length === 1 ? '' : 's'}`;

  for (let attempt = 1; ; attempt += 1) {
    const head = readLedger(repo).head ?? createGenesis(repo, now).head;
    rmSync(indexFile, { force: true });
    try {
      git(['read-tree', head], { cwd, env: { GIT_INDEX_FILE: indexFile } });
      for (const record of records) {
        const blob = git(['hash-object', '-w', '--stdin'], { cwd, input: record.json });
        git(['update-index', '--add', '--cacheinfo', `100644,${blob},runs/${record.id}.json`], {
          cwd,
          env: { GIT_INDEX_FILE: indexFile },
        });
      }
      for (const oid of blobs) {
        if (!keepBlob(repo, oid)) continue;
        // Sharded like git's own loose objects: a flat directory of thousands
        // of entries makes every later tree read pay for all of them.
        git(['update-index', '--add', '--cacheinfo', `100644,${oid},blobs/${oid.slice(0, 2)}/${oid.slice(2)}`], {
          cwd,
          env: { GIT_INDEX_FILE: indexFile },
        });
      }
      const tree = git(['write-tree'], { cwd, env: { GIT_INDEX_FILE: indexFile } });
      const commit = git(['commit-tree', '--no-gpg-sign', tree, '-p', head, '-m', message], {
        cwd,
        env: {
          GIT_AUTHOR_NAME: LEDGER_IDENTITY.name,
          GIT_AUTHOR_EMAIL: LEDGER_IDENTITY.email,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: LEDGER_IDENTITY.name,
          GIT_COMMITTER_EMAIL: LEDGER_IDENTITY.email,
          GIT_COMMITTER_DATE: date,
        },
      });
      git(['update-ref', '-m', `${CLI_NAME} seal`, LEDGER_REF, commit, head], { cwd });
      // The ledger holds the contents now, so the parked copies can go.
      for (const oid of blobs) rmSync(join(repo.root, STATE_DIR, BLOBS_DIR, oid), { force: true });
      return commit;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !(error instanceof GitError) || error.status === null) throw error;
    } finally {
      rmSync(indexFile, { force: true });
    }
  }
}

/**
 * Moves one parked file state into git's object store, or confirms the object
 * is already there. Returning false means the content is gone and the ledger
 * records only its id: blame will say so rather than pretend.
 */
function keepBlob(repo: Repo, oid: string): boolean {
  const parked = join(repo.root, STATE_DIR, BLOBS_DIR, oid);
  if (existsSync(parked)) {
    // --no-filters: the id was computed from the bytes, so the bytes go in as they are.
    return tryGit(['hash-object', '-w', '--no-filters', '--', parked], { cwd: repo.root }) === oid;
  }
  return tryGit(['cat-file', '-e', `${oid}^{blob}`], { cwd: repo.root }) !== null;
}

/** Puts back what we did not seal, plus anything captured while we worked. */
function writeQueue(queuePath: string, consumed: number, leftover: readonly QueueLine[], tail: string): void {
  const current = readFileSync(queuePath);
  const appended = current.subarray(Math.min(consumed, current.length));
  const kept = Buffer.from(leftover.map((line) => line.raw).join('') + tail, 'utf8');
  writeFileSync(queuePath, Buffer.concat([kept, appended]));
}
