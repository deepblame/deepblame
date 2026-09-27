import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BLOBS_DIR, CONFIG_FILE, QUEUE_FILE, STATE_DIR } from '@deepblame/protocol/names';
import type { HarnessId, QueueEvent, QueueHunk } from '@deepblame/protocol/queue';

/**
 * The hot path. This module runs inside every agent tool call, so it imports
 * no schema library, spawns no git and touches no network: it appends one
 * line per event to a local file and returns. Anything that can fail is
 * caught here, because a capture failure must never block an agent.
 */

/** Bigger files are recorded by path only; hashing them would stall the agent. */
const MAX_HASH_BYTES = 4 * 1024 * 1024;
/** Git's own heuristic: a NUL byte near the start means "not text". */
const BINARY_SNIFF_BYTES = 8000;
const INTENT_MAX = 120;

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);

export interface CaptureContext {
  /** Worktree root, found without spawning git. */
  root: string;
  stateDir: string;
  objectFormat: 'sha1' | 'sha256';
  /** Keep the prompt itself in the ledger. Off unless the repo opts in. */
  promptText: boolean;
  /** Keep a one-line summary of the prompt, so `deepblame log` is readable. */
  intent: boolean;
  /** Park file contents for the sealer. Off means blame and revert lose their evidence. */
  keepContent: boolean;
}

export interface CaptureResult {
  events: QueueEvent[];
  /** The turn ended: the caller may seal in the background. */
  seal: boolean;
}

/** Walks up for a `.git` entry. A file (worktree link) counts, like git's own rule. */
export function findRepoRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Null when this is not a repository, or when DeepBlame is not set up in it. */
export function openCapture(cwd: string): CaptureContext | null {
  const root = findRepoRoot(cwd);
  if (root === null) return null;
  const stateDir = join(root, STATE_DIR);
  if (!existsSync(stateDir)) return null;
  const context: CaptureContext = {
    root,
    stateDir,
    objectFormat: 'sha1',
    promptText: false,
    intent: true,
    keepContent: true,
  };
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stateDir, CONFIG_FILE), 'utf8'));
    if (isRecord(raw)) {
      if (raw['object_format'] === 'sha256') context.objectFormat = 'sha256';
      const capture = raw['capture'];
      if (isRecord(capture)) {
        if (typeof capture['prompt_text'] === 'boolean') context.promptText = capture['prompt_text'];
        if (typeof capture['intent'] === 'boolean') context.intent = capture['intent'];
        if (typeof capture['content'] === 'boolean') context.keepContent = capture['content'];
      }
    }
  } catch {
    // A missing or unreadable config is not a reason to lose the event.
  }
  return context;
}

/** The git object id a blob with this content would have. Hash only, no write. */
export function gitBlobOid(content: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format)
    .update(Buffer.from(`blob ${content.length}\u0000`, 'utf8'))
    .update(content)
    .digest('hex');
}

/**
 * Turns one Claude Code hook payload into queue events. Unknown events and
 * unknown shapes produce nothing rather than an error.
 */
export function captureClaudeCode(payload: unknown, context: CaptureContext, now: Date): CaptureResult {
  const none: CaptureResult = { events: [], seal: false };
  if (!isRecord(payload)) return none;
  const session = asString(payload['session_id']);
  if (session === null) return none;

  const base = { v: 1 as const, ts: now.toISOString(), agent: 'claude-code' as HarnessId, session };
  const event = asString(payload['hook_event_name']);

  switch (event) {
    case 'SessionStart':
      return {
        events: [
          {
            ...base,
            k: 'session',
            cwd: asString(payload['cwd']) ?? context.root,
            source: asString(payload['source']),
            transcript: asString(payload['transcript_path']),
          },
        ],
        seal: false,
      };

    case 'UserPromptSubmit': {
      const prompt = asString(payload['prompt']);
      if (prompt === null) return none;
      const promptEvent: QueueEvent = {
        ...base,
        k: 'prompt',
        sha256: sha256(prompt),
        intent: context.intent ? intentOf(prompt) : null,
      };
      if (context.promptText) promptEvent.text = prompt;
      return { events: [promptEvent], seal: false };
    }

    case 'PreToolUse': {
      const tool = asString(payload['tool_name']);
      if (tool === null || !WRITE_TOOLS.has(tool)) return none;
      const path = repoPath(context.root, filePathOf(payload['tool_input']));
      if (path === null) return none;
      const before = hashFile(context, join(context.root, path));
      return {
        events: [{ ...base, k: 'write-pre', path, blob: before.blob, lines: before.lines }],
        seal: false,
      };
    }

    case 'PostToolUse': {
      const tool = asString(payload['tool_name']);
      if (tool === null) return none;
      const input = payload['tool_input'];
      const response = payload['tool_response'];
      const events: QueueEvent[] = [
        {
          ...base,
          k: 'tool',
          name: tool,
          ok: toolSucceeded(response),
          args_sha256: sha256(stableJson(input)),
          result_sha256: response === undefined ? null : sha256(stableJson(response)),
        },
      ];
      const path = repoPath(context.root, filePathOf(input));
      if (path !== null && READ_TOOLS.has(tool)) {
        events.push({ ...base, k: 'read', path });
      } else if (path !== null && WRITE_TOOLS.has(tool)) {
        const after = hashFile(context, join(context.root, path));
        events.push({
          ...base,
          k: 'write',
          path,
          tool,
          blob: after.blob,
          lines: after.lines,
          hunks: after.text === null ? [] : hunksOf(tool, input, after.text),
        });
      }
      return { events, seal: false };
    }

    case 'Stop':
    case 'SubagentStop':
    case 'SessionEnd':
      return {
        events: [{ ...base, k: 'end', reason: asString(payload['reason']) ?? event.toLowerCase() }],
        seal: true,
      };

    default:
      return none;
  }
}

/** One append per hook call: a single write syscall, nothing held open. */
export function appendEvents(context: CaptureContext, events: readonly QueueEvent[]): number {
  if (events.length === 0) return 0;
  const text = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  try {
    appendFileSync(join(context.stateDir, QUEUE_FILE), text, 'utf8');
    return events.length;
  } catch {
    return 0;
  }
}

/**
 * The open door.
 *
 * Every harness reports differently, and writing an adapter for each one does
 * not scale — there will always be a tool we have not heard of. So there is
 * one documented shape any tool can send us, one JSON object per call:
 *
 *   { "kind": "prompt", "agent": "opencode", "session": "ses_1", "text": "…" }
 *   { "kind": "write-pre", "path": "src/a.ts" }
 *   { "kind": "write", "path": "src/a.ts", "tool": "edit", "old": "…", "new": "…" }
 *   { "kind": "tool", "tool": "bash", "args": { … }, "ok": true }
 *   { "kind": "read", "path": "src/b.ts" }
 *   { "kind": "usage", "model": "claude-sonnet-4", "input": 12, "output": 3, "usd": 0.01 }
 *   { "kind": "end" }
 *
 * `agent` and `session` may be sent once per call or on the first call only;
 * everything else is optional. Anything we do not recognise is ignored rather
 * than rejected, because a recorder that errors is a recorder people remove.
 */
export function captureEvent(payload: unknown, context: CaptureContext, now: Date): CaptureResult {
  const none: CaptureResult = { events: [], seal: false };
  if (!isRecord(payload)) return none;
  const agent = asHarness(payload['agent']);
  const session = asString(payload['session']) ?? asString(payload['session_id']);
  const kind = asString(payload['kind']);
  if (agent === null || session === null || kind === null) return none;
  const base = { v: 1 as const, ts: now.toISOString(), agent, session };

  switch (kind) {
    case 'session':
      return {
        events: [
          {
            ...base,
            k: 'session',
            cwd: asString(payload['cwd']) ?? context.root,
            source: asString(payload['source']),
            transcript: asString(payload['transcript']),
          },
        ],
        seal: false,
      };

    case 'prompt': {
      const text = asString(payload['text']);
      if (text === null) return none;
      const event: QueueEvent = {
        ...base,
        k: 'prompt',
        sha256: sha256(text),
        intent: context.intent ? intentOf(text) : null,
      };
      if (context.promptText) event.text = text;
      return { events: [event], seal: false };
    }

    case 'read': {
      const path = repoPath(context.root, payload['path']);
      return path === null ? none : { events: [{ ...base, k: 'read', path }], seal: false };
    }

    case 'write-pre': {
      const path = repoPath(context.root, payload['path']);
      if (path === null) return none;
      const before = hashFile(context, join(context.root, path));
      return { events: [{ ...base, k: 'write-pre', path, blob: before.blob, lines: before.lines }], seal: false };
    }

    case 'write': {
      const path = repoPath(context.root, payload['path']);
      if (path === null) return none;
      const after = hashFile(context, join(context.root, path));
      const tool = asString(payload['tool']) ?? 'write';
      // The same shape Claude Code's Edit tool reports, so one hunk builder
      // serves both: what was replaced, and what replaced it.
      const edit = { old_string: payload['old'], new_string: payload['new'], replace_all: payload['all'] === true };
      return {
        events: [
          {
            ...base,
            k: 'write',
            path,
            tool: tool === 'edit' ? 'Edit' : tool,
            blob: after.blob,
            lines: after.lines,
            hunks: after.text === null ? [] : hunksOf(tool === 'edit' ? 'Edit' : tool, edit, after.text),
          },
        ],
        seal: false,
      };
    }

    case 'tool': {
      const name = asString(payload['tool']);
      if (name === null) return none;
      return {
        events: [
          {
            ...base,
            k: 'tool',
            name,
            ok: payload['ok'] !== false,
            args_sha256: sha256(stableJson(payload['args'])),
            result_sha256: payload['result'] === undefined ? null : sha256(stableJson(payload['result'])),
          },
        ],
        seal: false,
      };
    }

    case 'usage':
      return {
        events: [
          {
            ...base,
            k: 'usage',
            model: asString(payload['model']),
            provider: asString(payload['provider']),
            input: asCount(payload['input']),
            output: asCount(payload['output']),
            cache_read: asCount(payload['cache_read']),
            cache_write: asCount(payload['cache_write']),
            usd: typeof payload['usd'] === 'number' && payload['usd'] >= 0 ? payload['usd'] : null,
          },
        ],
        seal: false,
      };

    case 'end':
      return { events: [{ ...base, k: 'end', reason: asString(payload['reason']) ?? 'end' }], seal: true };

    default:
      return none;
  }
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Only harnesses the ledger has a name for; anything else is not recorded. */
function asHarness(value: unknown): HarnessId | null {
  const known: readonly string[] = ['opencode', 'claude-code', 'codex', 'cursor', 'git'];
  return typeof value === 'string' && known.includes(value) ? (value as HarnessId) : null;
}

function hashFile(context: CaptureContext, file: string): { blob: string | null; lines: number; text: string | null } {
  const empty = { blob: null, lines: 0, text: null };
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_HASH_BYTES) return empty;
    const content = readFileSync(file);
    const blob = gitBlobOid(content, context.objectFormat);
    if (context.keepContent) park(context, blob, content);
    const binary = content.subarray(0, BINARY_SNIFF_BYTES).includes(0);
    const text = binary ? null : content.toString('utf8');
    return { blob, lines: text === null ? 0 : countLines(text), text };
  } catch {
    return empty;
  }
}

/**
 * Keeps a copy of the content under its own object id until the sealer files
 * it in git. Without it, `blame` can only guess whether a line is still the
 * line the agent wrote, and `revert` has nothing to put back.
 */
function park(context: CaptureContext, oid: string, content: Buffer): void {
  const file = join(context.stateDir, BLOBS_DIR, oid);
  try {
    if (existsSync(file)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { flag: 'wx' });
  } catch {
    // Someone else parked it first, or the disk refused: the agent must not care.
  }
}

/**
 * Line ranges for an edit, read off the file as it is now. The text before a
 * replacement is untouched, so the new text's line number is also the old
 * one's; only the lengths differ.
 */
function hunksOf(tool: string, input: unknown, after: string): QueueHunk[] {
  if (!isRecord(input)) return [];
  if (tool === 'Edit') {
    return editHunks(after, asString(input['old_string']), asString(input['new_string']), input['replace_all'] === true);
  }
  if (tool === 'MultiEdit') {
    const edits = input['edits'];
    if (!Array.isArray(edits)) return [];
    return edits.flatMap((edit) =>
      isRecord(edit)
        ? editHunks(after, asString(edit['old_string']), asString(edit['new_string']), edit['replace_all'] === true)
        : [],
    );
  }
  // A whole-file write has no hunks of its own; the sealer builds one once it
  // knows how long the file was before.
  return [];
}

function editHunks(after: string, oldText: string | null, newText: string | null, all: boolean): QueueHunk[] {
  if (oldText === null || newText === null || newText === '') return [];
  const hunks: QueueHunk[] = [];
  const oldLen = countLines(oldText);
  const newLen = countLines(newText);
  let from = 0;
  for (;;) {
    const at = after.indexOf(newText, from);
    if (at < 0) break;
    const start = countLines(after.slice(0, at), true) + 1;
    hunks.push({ old_start: start, old_len: oldLen, new_start: start, new_len: newLen });
    if (!all) break;
    from = at + newText.length;
  }
  return hunks;
}

/** Lines a piece of text spans; with `strict`, the newlines it actually contains. */
function countLines(text: string, strict = false): number {
  if (text === '') return strict ? 0 : 0;
  let count = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count += 1;
  if (strict) return count;
  return text.endsWith('\n') ? count : count + 1;
}

function filePathOf(input: unknown): unknown {
  if (!isRecord(input)) return null;
  return input['file_path'] ?? input['notebook_path'] ?? null;
}

/** Repository-relative, forward slashes. Null for anything outside the worktree. */
function repoPath(root: string, file: unknown): string | null {
  if (typeof file !== 'string' || file === '') return null;
  const absolute = isAbsolute(file) ? file : resolve(root, file);
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return sep === '/' ? rel : rel.split(sep).join('/');
}

function toolSucceeded(response: unknown): boolean {
  if (!isRecord(response)) return true;
  if (response['success'] === false) return false;
  return response['error'] === undefined;
}

function intentOf(prompt: string): string | null {
  const line = prompt.trim().split('\n')[0]?.trim() ?? '';
  if (line === '') return null;
  return line.length > INTENT_MAX ? `${line.slice(0, INTENT_MAX - 1)}…` : line;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
