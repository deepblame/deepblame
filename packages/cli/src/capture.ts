import { readFileSync } from 'node:fs';
import { appendEvents, captureClaudeCode, captureCursor, captureEvent, openCapture } from '@deepblame/core/capture';

/**
 * The hook entry point. It runs on every agent tool call, so it loads only
 * the capture module (no schema library, no git), writes one line and exits.
 * It prints nothing: an agent reads a hook's stdout, and it always exits 0,
 * because a recorder that can fail a build is a recorder people turn off.
 *
 * Everything here is measured in milliseconds of somebody else's turn. It is
 * bundled as CommonJS because node's ESM loader costs around 20ms of startup,
 * child_process is loaded only on the one event that needs it, and the
 * bytecode cache is switched on where the runtime has one.
 */

export interface CaptureIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Path of this bundle, used to start the sealer in the background. */
  entry?: string | undefined;
  /** Reads the hook payload. Injectable so tests need no real stdin. */
  stdin?: (() => string | null) | undefined;
}

export function capture(argv: readonly string[], io: CaptureIo): number {
  try {
    const payload = parseJson((io.stdin ?? readStdin)());
    const cwd = fieldString(payload, 'cwd') ?? workspaceRoot(payload) ?? flag(argv, '-C') ?? flag(argv, '--cwd') ?? io.cwd;
    const context = openCapture(cwd);
    if (context === null) return 0;
    // Claude Code and Cursor both send a field called hook_event_name, so the
    // installed command names its own harness; anything else sends the plain
    // shape any tool can produce.
    const agent = flag(argv, '--agent');
    const now = new Date();
    const result =
      agent === 'cursor'
        ? captureCursor(payload, context, now)
        : fieldString(payload, 'hook_event_name') !== null
          ? captureClaudeCode(payload, context, now)
          : captureEvent(withAgent(payload, agent), context, now);
    appendEvents(context, result.events);
    if (result.seal) sealInBackground(io, context.root);
  } catch {
    // Never surface anything to the agent: a lost event beats a blocked turn.
  }
  return 0;
}

/** `--agent opencode` names the harness when the payload has not. */
function withAgent(payload: unknown, agent: string | null): unknown {
  if (typeof payload !== 'object' || payload === null || agent === null) return payload;
  const record = payload as Record<string, unknown>;
  return record['agent'] === undefined ? { ...record, agent } : record;
}

function sealInBackground(io: CaptureIo, root: string): void {
  const entry = io.entry;
  if (entry === undefined || entry === '') return;
  try {
    // Loaded here rather than at the top: this happens once per turn, while
    // everything above happens on every single tool call.
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    spawn(process.execPath, [entry, 'seal', '-C', root], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch {
    // The next `deepblame log` seals instead.
  }
}

function readStdin(): string | null {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return null;
  }
}

function parseJson(text: string | null): unknown {
  if (text === null || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Cursor names the project this way instead of sending a cwd. */
function workspaceRoot(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const roots = (payload as Record<string, unknown>)['workspace_roots'];
  if (!Array.isArray(roots)) return null;
  const first = roots.find((entry) => typeof entry === 'string' && entry !== '');
  return typeof first === 'string' ? first : null;
}

function fieldString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at < 0) return null;
  return argv[at + 1] ?? null;
}
