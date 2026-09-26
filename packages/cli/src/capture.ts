import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendEvents, captureClaudeCode, openCapture } from '@deepblame/core/capture';

/**
 * The hook entry point. It runs on every agent tool call, so it loads only
 * the capture module (no schema library, no git), writes one line and exits.
 * It prints nothing: an agent reads a hook's stdout, and it always exits 0,
 * because a recorder that can fail a build is a recorder people turn off.
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
    const cwd = fieldString(payload, 'cwd') ?? flag(argv, '-C') ?? flag(argv, '--cwd') ?? io.cwd;
    const context = openCapture(cwd);
    if (context === null) return 0;
    const result = captureClaudeCode(payload, context, new Date());
    appendEvents(context, result.events);
    if (result.seal) sealInBackground(io, context.root);
  } catch {
    // Never surface anything to the agent: a lost event beats a blocked turn.
  }
  return 0;
}

function sealInBackground(io: CaptureIo, root: string): void {
  const entry = io.entry;
  if (entry === undefined || entry === '') return;
  try {
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
