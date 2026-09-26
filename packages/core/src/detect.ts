import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessId } from '@deepblame/protocol';

export interface HarnessDetection {
  id: HarnessId;
  label: string;
  found: boolean;
  /** Human-readable evidence, e.g. ".claude/" or "opencode on PATH". */
  signals: string[];
}

interface HarnessSignature {
  id: HarnessId;
  label: string;
  markers: string[];
  binaries: string[];
}

/** Ordered by adapter priority. AGENTS.md is read by several tools, so it identifies none of them. */
const SIGNATURES: readonly HarnessSignature[] = [
  { id: 'opencode', label: 'OpenCode', markers: ['opencode.json', 'opencode.jsonc', '.opencode'], binaries: ['opencode'] },
  { id: 'claude-code', label: 'Claude Code', markers: ['.claude', 'CLAUDE.md'], binaries: ['claude'] },
  { id: 'codex', label: 'Codex', markers: ['.codex'], binaries: ['codex'] },
  { id: 'cursor', label: 'Cursor', markers: ['.cursor', '.cursorrules'], binaries: ['cursor'] },
];

/**
 * `platform` is injectable so the Windows lookup rules are tested on every OS.
 * On Windows a command is found the way cmd.exe finds it: only names ending in
 * a PATHEXT extension count (so npm's `opencode.cmd`, not its bash shim), and
 * there is no execute bit to check.
 */
export function detectHarnesses(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): HarnessDetection[] {
  return SIGNATURES.map(({ id, label, markers, binaries }) => {
    const signals: string[] = [];
    for (const marker of markers) {
      const full = join(root, marker);
      if (existsSync(full)) signals.push(statSync(full).isDirectory() ? `${marker}/` : marker);
    }
    for (const binary of binaries) {
      if (commandOnPath(binary, env, platform)) signals.push(`${binary} on PATH`);
    }
    return { id, label, found: signals.length > 0, signals };
  });
}

/** The same lookup, used on its own to decide how to spell a hook command. */
export function commandOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const windows = platform === 'win32';
  const pathDirs = (env.PATH ?? '').split(windows ? ';' : ':').filter(Boolean);
  // Windows file names ignore case; lowercasing keeps the lookup identical on case-sensitive disks.
  const extensions = windows
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase())
    : [''];
  const isCommand = windows ? isFile : isExecutableFile;
  return pathDirs.some((dir) => extensions.some((ext) => isCommand(join(dir, name + ext))));
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
