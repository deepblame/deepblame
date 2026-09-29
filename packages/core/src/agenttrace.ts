import { createHash, randomUUID } from 'node:crypto';
import {
  SCHEMA_VERSION,
  TRACE_VENDOR,
  TRACE_VERSION,
  type HarnessId,
  type Run,
  type TraceContributor,
  type TraceRecord,
} from '@deepblame/protocol';

/**
 * Turning our ledger into Agent Trace records and back. The format itself
 * lives in the protocol package beside the other wire schemas; what is here is
 * the part that needs git: resolving a record's revision to real blobs, and
 * reading the contents a range covers so it can be hashed.
 */
import { splitLines } from './diffmap';
import { tryGit } from './git';
import type { Repo } from './repo';

/**
 * One run as one trace record.
 *
 * The mapping is close to exact, which is a good sign for both designs: a run
 * has one tool, one moment and one revision, and so does a record. Ranges are
 * given at the revision the run ended on, which is what the spec means by
 * positions being relative to `vcs.revision`.
 */
export function recordFromRun(repo: Repo, run: Run): TraceRecord | null {
  const files: TraceRecord['files'] = [];
  for (const write of run.files_written) {
    if (write.post_blob_sha === null) continue;
    const ranges = rangesOf(repo, write.hunks, write.post_blob_sha);
    if (ranges.length === 0) continue;
    files.push({
      path: write.path,
      conversations: [{ contributor: contributorOf(run), ranges }],
    });
  }
  if (files.length === 0) return null;

  const record: TraceRecord = {
    version: TRACE_VERSION,
    id: run.run_id,
    timestamp: run.started_at,
    files,
    metadata: {
      [TRACE_VENDOR]: {
        run_id: run.run_id,
        session_id: run.session_id,
        ...(run.task.intent === undefined ? {} : { intent: run.task.intent }),
        ...(run.cost?.usd === null || run.cost?.usd === undefined ? {} : { usd: run.cost.usd }),
        tool_calls: run.tool_calls.length,
      },
    },
  };
  // Both fields are required when the object is present, so a tool we have no
  // version for says so rather than being dropped and losing its name.
  record.tool = { name: run.harness.name, version: run.harness.version ?? 'unknown' };
  if (run.env.head_commit !== null) record.vcs = { type: 'git', revision: run.env.head_commit };
  return record;
}

/** `provider/model-name`, the models.dev convention the spec points at. */
function contributorOf(run: Run): TraceContributor {
  if (run.actor.type === 'human') return { type: 'human' };
  const model = run.model;
  return model === null ? { type: 'ai' } : { type: 'ai', model_id: `${model.provider}/${model.name}` };
}

/**
 * Hunks to line ranges, with a hash of what stands on them.
 *
 * `content_hash` is what makes a range findable after the lines have moved, so
 * it is worth the read: without it a consumer can only trust the numbers, and
 * the numbers go stale on the next commit.
 */
type Ranges = TraceRecord['files'][number]['conversations'][number]['ranges'];

function rangesOf(repo: Repo, hunks: Run['files_written'][number]['hunks'], postBlob: string): Ranges {
  const text = tryGit(['cat-file', 'blob', postBlob], { cwd: repo.root, raw: true });
  const lines = text === null ? null : splitLines(text);
  const out: Ranges = [];
  for (const hunk of hunks) {
    if (hunk.new_len === 0) continue;
    const start = hunk.new_start;
    const end = hunk.new_start + hunk.new_len - 1;
    const slice = lines === null ? null : lines.slice(start - 1, end);
    out.push({
      start_line: start,
      end_line: end,
      ...(slice === null || slice.length === 0
        ? {}
        : { content_hash: `sha256:${createHash('sha256').update(slice.join('\n')).digest('hex')}` }),
    });
  }
  return out;
}

export interface ImportedRun {
  /** Null when nothing in the record could be tied to this repository. */
  run: Run | null;
  /** What the record said its tool was, before it was folded into our names. */
  tool: string;
  /** Ranges we could not tie to a blob here, and so did not take in. */
  unresolved: number;
}

/**
 * A record from somebody else's tool, as a run of our own.
 *
 * `harness.name` is `external` and never the tool's own name: these lines were
 * reported to us, not watched by us, and blame says so at a lower confidence.
 *
 * A claim is only taken in if it can be tied to a state of the file that git
 * actually holds, because that is what lets the line be followed to where it
 * is now. Two ways in, in order of strength:
 *
 *  1. The record names a revision this repository has. The file at that
 *     revision is the state the claim was made against, and everything since
 *     can be followed exactly as for a run we watched.
 *  2. It does not, but the range carries a `content_hash` and those very lines
 *     are in the file today. This is what the field is for, and it covers the
 *     ordinary case of a trace arriving from a different clone.
 *
 * Anything else is counted and dropped. A line we cannot follow is a line we
 * cannot answer for, and guessing is the one thing this tool must not do.
 */
export function runFromRecord(repo: Repo, record: TraceRecord, now = new Date()): ImportedRun | null {
  const revision = record.vcs?.type === 'git' ? record.vcs.revision : null;
  const written: Run['files_written'] = [];
  let unresolved = 0;

  for (const file of record.files) {
    const ranges: Ranges = file.conversations.flatMap((one) => one.ranges);
    if (ranges.length === 0) continue;
    const atRevision = revision === null ? null : tryGit(['rev-parse', `${revision}:${file.path}`], { cwd: repo.root });
    const blob = atRevision ?? matchByHash(repo, file.path, ranges);
    if (blob === null) {
      unresolved += ranges.length;
      continue;
    }
    written.push({
      path: file.path,
      // Unknown, and it must stay unknown: a trace carries no before-image, so
      // there is nothing here to put back.
      pre_blob_sha: null,
      post_blob_sha: blob,
      hunks: ranges.map((one) => ({
        old_start: 0,
        old_len: 0,
        new_start: one.start_line,
        new_len: Math.max(0, one.end_line - one.start_line + 1),
      })),
    });
  }
  if (written.length === 0) return { run: null, tool: record.tool?.name ?? 'unknown', unresolved };

  const said = record.files[0]?.conversations[0]?.contributor;
  const tool = record.tool?.name ?? 'unknown';
  const model = modelOf(record);
  const run: Run = {
    schema_version: SCHEMA_VERSION,
    run_id: uuidOf(record.id),
    session_id: uuidOf(`session:${record.id}`),
    parent_run_id: null,
    harness: { name: 'external' as HarnessId, version: record.tool?.version ?? null },
    model,
    actor: { type: said?.type === 'human' ? 'human' : 'agent', id: tool },
    task: {
      prompt_sha256: null,
      ...(intentOf(record) === undefined ? {} : { intent: intentOf(record) }),
    },
    started_at: isoOf(record.timestamp, now),
    ended_at: isoOf(record.timestamp, now),
    tool_calls: [],
    files_read: [],
    files_written: written,
    env: {
      branch: null,
      head_commit: revision !== null && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision) ? revision : null,
      worktree_id: 'imported',
      host_id: 'imported',
    },
  };
  return { run, tool, unresolved };
}

/**
 * The state of a file that the claim's own hashes point at.
 *
 * A trace from another clone names a revision we have never seen, but the
 * ranges carry a hash of the text they cover — which is precisely the escape
 * hatch the spec put there. If those lines are in the file as it stands, the
 * claim is about our file after all, and the current blob is the state to
 * follow from. Every hashed range has to match: one that does not means the
 * record describes a different file than the one in front of us.
 */
function matchByHash(repo: Repo, path: string, ranges: Ranges): string | null {
  const hashed = ranges.filter((one) => typeof one.content_hash === 'string');
  if (hashed.length === 0) return null;
  const blob = tryGit(['rev-parse', `HEAD:${path}`], { cwd: repo.root });
  if (blob === null) return null;
  const text = tryGit(['cat-file', 'blob', blob], { cwd: repo.root, raw: true });
  if (text === null) return null;
  const lines = splitLines(text);

  for (const one of hashed) {
    const slice = lines.slice(one.start_line - 1, one.end_line);
    if (slice.length === 0) return null;
    const digest = `sha256:${createHash('sha256').update(slice.join('\n')).digest('hex')}`;
    if (digest !== one.content_hash) return null;
  }
  return blob;
}

function modelOf(record: TraceRecord): Run['model'] {
  for (const file of record.files) {
    for (const one of file.conversations) {
      const id = one.contributor?.model_id ?? one.ranges.find((range) => range.contributor?.model_id !== undefined)?.contributor?.model_id;
      if (id === undefined) continue;
      const cut = id.indexOf('/');
      if (cut <= 0) return { provider: 'unknown', name: id, version: null };
      return { provider: id.slice(0, cut), name: id.slice(cut + 1), version: null };
    }
  }
  return null;
}

/**
 * A trace carries no prompt. Ours puts one in `metadata`, and another tool's
 * may too; when there is none, the field stays empty rather than being filled
 * with the tool's name, which blame is already showing.
 */
function intentOf(record: TraceRecord): string | undefined {
  const mine = record.metadata?.[TRACE_VENDOR];
  if (typeof mine === 'object' && mine !== null) {
    const said = (mine as Record<string, unknown>)['intent'];
    if (typeof said === 'string' && said !== '') return said.slice(0, 120);
  }
  return undefined;
}

/** Our records are keyed by uuid; another tool's id may be anything. */
function uuidOf(id: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return id.toLowerCase();
  const digest = createHash('sha256').update(`agent-trace:${id}`).digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    ((Number.parseInt(digest[16] ?? '0', 16) & 0x3) | 0x8).toString(16) + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join('-');
}

function isoOf(value: string, now: Date): string {
  const at = Date.parse(value);
  return new Date(Number.isFinite(at) ? at : now.getTime()).toISOString();
}

/** A stable id for a record that arrived without a usable one. */
export function traceId(): string {
  return randomUUID();
}

/** Where exported records go when no destination is named. */
export const TRACE_DIR = 'trace';
