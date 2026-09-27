import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN_DIR, CAPTURE_FILE, CAPTURE_STAMP, SEALER_FILE, STATE_DIR } from '@deepblame/protocol';

/**
 * A copy of the capture program, inside the repository it records.
 *
 * The hooks an agent runs are a line of text in somebody else's settings file,
 * and that line has to still work months later, in whatever shell the editor
 * spawns. Naming a command and trusting PATH does not survive that. It does not
 * even survive the first five seconds: `npx deepblame init` puts the CLI on PATH
 * for the length of that one command, so a hook written to call it by name looks
 * installed, passes every check, and then resolves to nothing. Capture never
 * prints and always exits 0 — that is right on the hot path and merciless here,
 * because the failure is completely silent.
 *
 * So the program the hooks call lives in `.deepblame/bin/`, next to the rest of
 * this worktree's state, and the hook holds its full path. It is 20 KB, the
 * directory already ignores itself, and nothing about it depends on PATH, on
 * npm's cache surviving, or on the CLI still being installed.
 *
 * The full CLI goes in beside it. Capture writes one line and exits; folding
 * those lines into the ledger is a second program it starts in the background
 * when a turn ends, and that one has to be findable from the same place or the
 * turn simply waits for the next command that seals. Bigger, but it is started
 * once a turn rather than once a tool call, and the pair makes the worktree
 * able to record and seal on its own.
 *
 * The cost is that the copies do not follow the CLI when it is upgraded, so
 * they record their version and `doctor` says when the two have drifted.
 */

export interface VendorResult {
  /** Absolute path of the copy the hooks should call. */
  path: string;
  /** What it was copied from, or null when there was nothing to copy. */
  source: string | null;
  /** False when identical copies were already there. */
  changed: boolean;
  version: string | null;
}

/** The two programs a worktree needs to record on its own. */
export interface CaptureBundle {
  /** The hot path the hooks call on every tool call. */
  capture: string | null;
  /** The whole CLI, started once a turn to seal. Optional but wanted. */
  cli?: string | null;
}

export interface VendoredCapture {
  path: string;
  exists: boolean;
  /** The CLI version this copy came from, when it is known. */
  version: string | null;
  installedAt: string | null;
}

export function capturePath(root: string): string {
  return join(root, STATE_DIR, BIN_DIR, CAPTURE_FILE);
}

export function sealerPath(root: string): string {
  return join(root, STATE_DIR, BIN_DIR, SEALER_FILE);
}

/**
 * Copies the capture program into the worktree. Returns where it went, whether
 * anything changed, and null for `source` when the caller had nothing to copy —
 * running from source in development, say, where the bundle does not exist yet.
 */
export function vendorCapture(
  root: string,
  bundle: CaptureBundle | string | null,
  version: string | null,
  now = new Date(),
): VendorResult {
  const sources = typeof bundle === 'string' || bundle === null ? { capture: bundle } : bundle;
  const path = capturePath(root);
  const capture = sources.capture;
  if (capture === null || capture === undefined || !existsSync(capture)) {
    return { path, source: null, changed: false, version: readStamp(root).version };
  }

  const pairs: [string, string][] = [[capture, path]];
  const cli = sources.cli;
  if (cli !== null && cli !== undefined && existsSync(cli)) pairs.push([cli, sealerPath(root)]);

  const stale = pairs.filter(([from, to]) => !sameFile(from, to));
  if (stale.length > 0) {
    mkdirSync(join(root, STATE_DIR, BIN_DIR), { recursive: true });
    for (const [from, to] of stale) copyFileSync(from, to);
    writeFileSync(
      join(root, STATE_DIR, BIN_DIR, CAPTURE_STAMP),
      `${JSON.stringify({ version, installed_at: now.toISOString(), source: capture }, null, 2)}\n`,
    );
  }
  return { path, source: capture, changed: stale.length > 0, version };
}

/** What is installed right now, for `doctor` and `status` to report. */
export function readStamp(root: string): VendoredCapture {
  const path = capturePath(root);
  const stamp = join(root, STATE_DIR, BIN_DIR, CAPTURE_STAMP);
  const exists = existsSync(path);
  if (!existsSync(stamp)) return { path, exists, version: null, installedAt: null };
  try {
    const value: unknown = JSON.parse(readFileSync(stamp, 'utf8'));
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    return {
      path,
      exists,
      version: typeof record['version'] === 'string' ? record['version'] : null,
      installedAt: typeof record['installed_at'] === 'string' ? record['installed_at'] : null,
    };
  } catch {
    return { path, exists, version: null, installedAt: null };
  }
}

/** Same size and same bytes. Cheap enough to run on every `init`. */
function sameFile(source: string, target: string): boolean {
  if (!existsSync(target)) return false;
  try {
    if (statSync(source).size !== statSync(target).size) return false;
    return readFileSync(source).equals(readFileSync(target));
  } catch {
    return false;
  }
}
