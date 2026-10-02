import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BLOBS_DIR,
  CLI_NAME,
  LEDGER_IDENTITY,
  LEDGER_REF,
  QUEUE_FILE,
  QUEUE_SEALING_FILE,
  QUEUE_TAKING_FILE,
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
  // Any of the three may hold events: what has just arrived, what a previous
  // attempt could not seal, and what a sealer that died had already taken.
  const waiting = [queuePath, join(stateDir, QUEUE_SEALING_FILE), join(stateDir, QUEUE_TAKING_FILE)];
  if (!waiting.some((file) => existsSync(file))) return idle;

  const lock = join(stateDir, SEAL_LOCK_FILE);
  if (!acquire(lock)) return { ...idle, busy: true };
  let leftover: QueueLine[] = [];
  let tail = '';
  try {
    const buffer = takeQueue(stateDir);
    if (buffer.length === 0) return idle;
    const read = readQueue(buffer);
    tail = read.tail;
    const segments = segmentsOf(read.lines);
    const ready = (segment: Segment): boolean => segment.closed || abandoned(segment, now);
    const closed = segments.filter(ready);
    leftover = segments.filter((segment) => !ready(segment)).flatMap((segment) => segment.lines);
    const lines = read.lines;

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
    const written: Run['files_written'] = [];
    for (const segment of closed) {
      const candidate = runOf(segment, env, transcripts.get(sessionKey(segment.agent, segment.session)) ?? null, rates);
      if (candidate === null) continue;
      const parsed = parseRun(candidate);
      if (!parsed.ok) {
        rejected.push(`${segment.session}: ${parsed.issues.join('; ')}`);
        continue;
      }
      records.push({ id: parsed.value.run_id, json: `${JSON.stringify(parsed.value, null, 2)}\n` });
      written.push(...parsed.value.files_written);
    }
    for (const oid of blobsToKeep(repo, written)) blobs.add(oid);

    const head = records.length > 0 ? commitRuns(repo, records, [...blobs], now) : readLedger(repo).head;
    return {
      sealed: records.length,
      events: closed.reduce((total, segment) => total + segment.lines.length, 0),
      pending: leftover.length,
      rejected,
      head,
      busy: false,
    };
  } finally {
    // Whatever we could not seal is owed, however we leave this function.
    parkQueue(stateDir, leftover, tail);
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
  const written: Run['files_written'] = [];
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
    written.push(...parsed.value.files_written);
  }
  for (const oid of blobsToKeep(repo, written)) blobs.add(oid);

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
  /** Needed to diff the two file states against each other. */
  repo: Repo;
}

function runEnv(repo: Repo): RunEnv {
  return {
    branch: tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo.root }),
    head: tryGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: repo.root }),
    worktree: worktreeId(repo.root),
    host: hostId(),
    repo,
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

  const writes = collectWrites(events, env.repo);
  if (toolCalls.length === 0 && writes.length === 0 && reads.size === 0) return null;

  const startedAt = (prompt ?? first).ts;
  const endedAt = (end ?? last).ts;

  // A harness that counts its own tokens is believed over anything we mine out
  // of a log afterwards: it knows which model answered and what it was billed.
  const reported = events.filter((event): event is Extract<QueueEvent, { k: 'usage' }> => event.k === 'usage');
  const usage =
    reported.length > 0
      ? {
          model: reported.find((event) => event.model !== null)?.model ?? null,
          input_tokens: sum(reported, (event) => event.input),
          output_tokens: sum(reported, (event) => event.output),
          cache_write_tokens: sum(reported, (event) => event.cache_write),
          cache_read_tokens: sum(reported, (event) => event.cache_read),
          harness_usd: reported.some((event) => event.usd !== null) ? sum(reported, (event) => event.usd ?? 0) : null,
          messages: reported.length,
        }
      : transcript === null
        ? null
        : readTranscriptUsage(transcript, startedAt, endedAt);
  const price = usage === null ? null : priceUsd(usage, rates);
  const provider = reported.find((event) => event.provider !== null)?.provider ?? null;

  const run: Run = {
    schema_version: SCHEMA_VERSION,
    run_id: randomUUID(),
    session_id: sessionUuid(segment.agent, segment.session),
    parent_run_id: null,
    harness: { name: segment.agent, version: null },
    model: usage?.model == null ? null : { provider: provider ?? providerOf(usage.model), name: usage.model, version: null },
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

/**
 * The lines that really differ between the two states of the file.
 *
 * What a tool says it changed is a claim. The file before and the file after
 * are evidence, and the ledger holds both. Where the evidence can be read it
 * decides, so an agent that rewrites a whole file to change one line is
 * credited with one line, and an agent that rewrites a file and changes
 * nothing is credited with nothing.
 *
 * This is not a detail. The tool rests on never claiming a line it cannot
 * prove, and taking the claim at face value broke that for the commonest case
 * there is — a whole-file write, which is what `Write` does, and what every
 * editor that applies a model's output as a new file version does. Ten lines
 * went in the ledger when one had changed. `revert` had always worked from the
 * two blobs, which is how the two halves of the same tool came to disagree in
 * public: revert would offer to put one line back while blame said the agent
 * wrote all ten.
 *
 * Null means the diff cannot be had — the content was never kept, or `gc` has
 * aged it out — and then the claim is all there is.
 */
function provenHunks(repo: Repo, pre: string | null, post: string | null): Run['files_written'][number]['hunks'] | null {
  if (post === null) return null;
  // Rewritten with the same bytes: nothing changed, so nothing is owed.
  if (pre === post) return [];
  if (!keepBlob(repo, post)) return null;
  if (pre !== null && !keepBlob(repo, pre)) return null;
  const before = pre ?? tryGit(['hash-object', '-w', '--stdin'], { cwd: repo.root, input: '' });
  if (before === null) return null;
  const diff = tryGit(['diff', '--no-color', '--no-ext-diff', '--unified=0', before, post], { cwd: repo.root });
  if (diff === null) return null;
  const hunks: Run['files_written'][number]['hunks'] = [];
  for (const line of diff.split('\n')) {
    const at = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (at === null) continue;
    hunks.push({
      old_start: Number(at[1]),
      old_len: at[2] === undefined ? 1 : Number(at[2]),
      new_start: Number(at[3]),
      new_len: at[4] === undefined ? 1 : Number(at[4]),
    });
  }
  // Two blobs that differ with nothing to show for it are not text: git says
  // "Binary files differ" and leaves it there. Lines mean nothing for a PNG,
  // but recording no change at all would leave `revert` with nothing to put
  // back, so the claim stands for those.
  if (hunks.length === 0) return null;
  return hunks;
}

/**
 * The file states worth keeping, which is not all of them.
 *
 * The before and after of a file are stored so a run can be put back, and
 * because blame has to be able to prove what it claims. A file the repository
 * ignores is a different matter: it is not part of the repository, nothing in
 * git can anchor it, and it is exactly where people keep `.env` files, keys
 * and tokens. Storing its contents writes them into a ref that `deepblame
 * push` sends to the team's remote, where a key has to be rotated and nobody
 * was ever told it went.
 *
 * So an ignored file's run still records that the agent wrote it, and the id
 * of what it wrote, which is a one-way hash. The contents stay on the machine
 * that wrote them — and the parked copy there is thrown away rather than left
 * lying in the state directory.
 */
function blobsToKeep(repo: Repo, written: readonly Run['files_written'][number][]): string[] {
  const ignored = ignoredPaths(repo, [...new Set(written.map((file) => file.path))]);
  const keep = new Set<string>();
  const drop = new Set<string>();
  for (const file of written) {
    const into = ignored.has(file.path) || secretByName(file.path) ? drop : keep;
    if (file.pre_blob_sha !== null) into.add(file.pre_blob_sha);
    if (file.post_blob_sha !== null) into.add(file.post_blob_sha);
  }
  for (const oid of drop) {
    if (!keep.has(oid)) rmSync(join(repo.root, STATE_DIR, BLOBS_DIR, oid), { force: true });
  }
  return [...keep];
}

/**
 * Files that are credentials by convention, whatever the ignore rules say.
 *
 * A repository with no `.gitignore` yet, or one where somebody has committed
 * a key by mistake, would otherwise have it copied into the ledger and sent
 * wherever the ledger is pushed. The cost of leaving these out is that a run
 * which wrote one cannot be undone by file content; nobody would trade the
 * other way round.
 */
function secretByName(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (name === '.npmrc' || name === '.netrc' || name === '_netrc' || name === 'credentials') return true;
  if (name.startsWith('id_rsa') || name.startsWith('id_dsa') || name.startsWith('id_ecdsa') || name.startsWith('id_ed25519')) {
    return true;
  }
  return /\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/.test(name);
}

/** Which of these the repository ignores. One git call, on the cold path. */
function ignoredPaths(repo: Repo, paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  // A tracked file is never ignored, which is git's own default here, so this
  // only ever catches what is genuinely outside the repository.
  const out = tryGit(['check-ignore', '-z', '--stdin'], { cwd: repo.root, input: `${paths.join('\0')}\0` });
  if (out === null) return new Set();
  return new Set(out.split('\0').filter((one) => one !== ''));
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += of(item);
  return total;
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
function collectWrites(events: readonly QueueEvent[], repo: Repo): Run['files_written'] {
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
    const claimed =
      entry.hunks.length > 0
        ? entry.hunks
        : entry.wholeFile
          ? [{ old_start: 1, old_len: entry.preLines, new_start: 1, new_len: entry.postLines }]
          : [];
    const hunks = provenHunks(repo, entry.pre, entry.post) ?? claimed;
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
/**
 * Takes the queue off the hot path before reading a byte of it.
 *
 * This used to read the queue, spend a while writing to the ledger, and then
 * write back what it had not consumed. Capture appends with O_APPEND, which is
 * atomic against other appends but not against somebody rewriting the whole
 * file: an event that arrived between that read and that write was simply
 * gone. Roughly one turn in two hundred lost a line that way, and a turn that
 * loses its `Stop` never closes, so it sat in the queue for ever while
 * `status` and `log` showed nothing at all. Three hundred turns in a row was
 * what it took to see it.
 *
 * So the queue changes hands by being renamed. Capture appends to a path, and
 * after the rename that path is a new empty file it creates on its next write;
 * it never knows. The sealer reads the file it now owns, and whatever it
 * cannot seal waits in a file only the sealer touches. Nothing is ever read
 * and written back, so nothing an agent appends in between can be overwritten.
 */
function takeQueue(stateDir: string): Buffer {
  const parts: Buffer[] = [];
  const sealing = join(stateDir, QUEUE_SEALING_FILE);
  const taking = join(stateDir, QUEUE_TAKING_FILE);
  const queue = join(stateDir, QUEUE_FILE);

  // Oldest first: what a previous attempt could not seal, then what a sealer
  // that died mid-flight had already taken, then what has arrived since.
  if (existsSync(sealing)) parts.push(readFileSync(sealing));
  if (existsSync(taking)) parts.push(readFileSync(taking));
  if (existsSync(queue)) {
    if (claim(queue, taking)) {
      if (existsSync(taking)) parts.push(readFileSync(taking));
    } else {
      // Windows can refuse to rename a file another process holds open. Reading
      // and truncating can lose a concurrent append, which is what this whole
      // function exists to avoid — but not sealing at all is worse, and the
      // window is a few milliseconds once in a while.
      const current = readFileSync(queue);
      if (current.length > 0) {
        parts.push(current);
        writeFileSync(queue, Buffer.alloc(0));
      }
    }
  }
  return parts.length === 1 ? (parts[0] ?? Buffer.alloc(0)) : Buffer.concat(parts);
}

/** Renaming is the whole trick, so it is worth a few goes. */
function claim(from: string, to: string): boolean {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      renameSync(from, to);
      return true;
    } catch {
      // Something else holds it open for a moment.
    }
  }
  return false;
}

/** What is still owed, in a file the hot path never touches. */
function parkQueue(stateDir: string, leftover: readonly QueueLine[], tail: string): void {
  const sealing = join(stateDir, QUEUE_SEALING_FILE);
  const kept = leftover.map((line) => line.raw).join('') + tail;
  if (kept === '') rmSync(sealing, { force: true });
  else writeFileSync(sealing, kept);
  rmSync(join(stateDir, QUEUE_TAKING_FILE), { force: true });
}

/**
 * A turn whose end we are never going to see.
 *
 * A segment closes on the agent's stop hook, or on the next prompt of the same
 * session. Neither arrives when the agent is killed mid-turn, or when a session
 * simply ends — and then the work it did would sit unsealed for ever, recorded
 * nowhere the user can see. After this long with nothing added, the turn is
 * taken as over and sealed with what it has. Long enough that a model thinking
 * between tool calls is never cut in two.
 */
const ABANDONED_MS = 30 * 60_000;

function abandoned(segment: Segment, now: Date): boolean {
  const last = segment.lines[segment.lines.length - 1];
  if (last === undefined) return false;
  const at = Date.parse(last.event.ts);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at > ABANDONED_MS;
}
