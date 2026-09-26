import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_NAME, CONFIG_FILE, IGNORE_FILE, QUEUE_FILE, SCHEMA_VERSION, STATE_DIR } from '@deepblame/protocol';

export interface StateDirInfo {
  /** Absolute path of the worktree's state directory. */
  path: string;
  exists: boolean;
  /** Events captured but not yet sealed into the ledger. */
  queued: number;
}

export interface StateDirOptions {
  /** Written into the config so the capture path can hash blobs without git. */
  objectFormat?: 'sha1' | 'sha256';
}

/**
 * Creates the per-worktree state directory. It carries its own `.gitignore`
 * containing `*`, so it can never be committed and the user's own
 * `.gitignore` is never touched. Existing files are left as they are.
 */
export function ensureStateDir(root: string, now: Date, options: StateDirOptions = {}): { path: string; created: boolean } {
  const path = join(root, STATE_DIR);
  const created = !existsSync(path);
  mkdirSync(path, { recursive: true });
  writeIfMissing(join(path, IGNORE_FILE), `# Local ${CLI_NAME} state. Never committed; rebuilt from the ledger.\n*\n`);
  writeIfMissing(join(path, QUEUE_FILE), '');
  writeIfMissing(
    join(path, CONFIG_FILE),
    `${JSON.stringify(
      {
        schema_version: SCHEMA_VERSION,
        created_at: now.toISOString(),
        object_format: options.objectFormat ?? 'sha1',
        capture: {
          // A one-line summary of each prompt, so `deepblame log` reads like history.
          intent: true,
          // The prompt itself is not recorded unless the repository asks for it.
          prompt_text: false,
        },
        // Prompt text stays on this machine unless the team opts in.
        sync: { prompt_text: false },
      },
      null,
      2,
    )}\n`,
  );
  return { path, created };
}

export function readStateDir(root: string): StateDirInfo {
  const path = join(root, STATE_DIR);
  const queuePath = join(path, QUEUE_FILE);
  if (!existsSync(path)) return { path, exists: false, queued: 0 };
  const queued = existsSync(queuePath)
    ? readFileSync(queuePath, 'utf8').split('\n').filter((line) => line.trim() !== '').length
    : 0;
  return { path, exists: true, queued };
}

function writeIfMissing(file: string, content: string): void {
  if (!existsSync(file)) writeFileSync(file, content, { flag: 'wx' });
}
