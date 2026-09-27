import type { HarnessId } from './run';

export type { HarnessId };

/**
 * The capture queue: one JSON object per line, appended by the hot path.
 *
 * This module is deliberately free of any runtime dependency. `deepblame
 * capture` runs on every agent tool call, so it must not pay for a schema
 * library; the sealer validates what it reads before anything reaches the
 * ledger. Queue lines are private to one machine and are deleted once sealed.
 */
export const QUEUE_VERSION = 1;

export interface QueueHunk {
  old_start: number;
  old_len: number;
  new_start: number;
  new_len: number;
}

interface QueueBase {
  v: typeof QUEUE_VERSION;
  k: string;
  /** ISO 8601 with offset, as the run schema wants it. */
  ts: string;
  agent: HarnessId;
  /** The harness's own session identifier, verbatim. */
  session: string;
}

/** A session opened. Carries what the harness knows about itself. */
export interface SessionEvent extends QueueBase {
  k: 'session';
  cwd: string;
  source: string | null;
  /** Where the harness keeps the conversation log, for later cost mining. */
  transcript: string | null;
}

/** A turn started. Opens a run; the next prompt or end closes it. */
export interface PromptEvent extends QueueBase {
  k: 'prompt';
  sha256: string;
  /** First line of the prompt, capped. Omitted when the repo opts out. */
  intent: string | null;
  /** Only when the repo opts in; never leaves the machine by default. */
  text?: string;
}

export interface ToolEvent extends QueueBase {
  k: 'tool';
  name: string;
  ok: boolean;
  args_sha256: string;
  result_sha256: string | null;
}

export interface ReadEvent extends QueueBase {
  k: 'read';
  path: string;
}

/** The state of a file just before the agent changed it. */
export interface WritePreEvent extends QueueBase {
  k: 'write-pre';
  path: string;
  blob: string | null;
  lines: number;
}

/** The state of a file just after the agent changed it. */
export interface WriteEvent extends QueueBase {
  k: 'write';
  path: string;
  /** The tool that wrote it, so the sealer knows how to read the hunks. */
  tool: string;
  blob: string | null;
  lines: number;
  hunks: QueueHunk[];
}

/**
 * What the turn cost, from a harness that keeps its own count. Preferred over
 * anything we work out ourselves: the harness knows which model actually
 * answered and what it was billed.
 */
export interface UsageEvent extends QueueBase {
  k: 'usage';
  model: string | null;
  provider: string | null;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** The harness's own figure in dollars, when it has one. */
  usd: number | null;
}

/** The turn ended (agent stopped, or the session closed). */
export interface EndEvent extends QueueBase {
  k: 'end';
  reason: string | null;
}

export type QueueEvent =
  | SessionEvent
  | PromptEvent
  | ToolEvent
  | ReadEvent
  | WritePreEvent
  | WriteEvent
  | UsageEvent
  | EndEvent;
