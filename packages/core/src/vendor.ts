import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN_DIR, CAPTURE_FILE, CAPTURE_STAMP, STATE_DIR } from '@deepblame/protocol';

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
 * The cost is that the copy does not follow the CLI when it is upgraded, so it
 * records its version and `doctor` says when the two have drifted.
 */

export interface VendorResult {
  /** Absolute path of the copy the hooks should call. */
  path: string;
  /** What it was copied from, or null when there was nothing to copy. */
  source: string | null;
  /** False when an identical copy was already there. */
  changed: boolean;
  version: string | null;
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

/**
 * Copies the capture program into the worktree. Returns where it went, whether
 * anything changed, and null for `source` when the caller had nothing to copy —
 * running from source in development, say, where the bundle does not exist yet.
 */
export function vendorCapture(root: string, source: string | null, version: string | null, now = new Date()): VendorResult {
  const path = capturePath(root);
  if (source === null || !existsSync(source)) {
    return { path, source: null, changed: false, version: readStamp(root).version };
  }

  const changed = !sameFile(source, path);
  if (changed) {
    mkdirSync(join(root, STATE_DIR, BIN_DIR), { recursive: true });
    copyFileSync(source, path);
    writeFileSync(
      join(root, STATE_DIR, BIN_DIR, CAPTURE_STAMP),
      `${JSON.stringify({ version, installed_at: now.toISOString(), source }, null, 2)}\n`,
    );
  }
  return { path, source, changed, version };
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
