import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
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

export function detectHarnesses(root: string, env: NodeJS.ProcessEnv = process.env): HarnessDetection[] {
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];

  return SIGNATURES.map(({ id, label, markers, binaries }) => {
    const signals: string[] = [];
    for (const marker of markers) {
      const full = join(root, marker);
      if (existsSync(full)) signals.push(statSync(full).isDirectory() ? `${marker}/` : marker);
    }
    for (const binary of binaries) {
      const onPath = pathDirs.some((dir) => extensions.some((ext) => isExecutable(join(dir, binary + ext))));
      if (onPath) signals.push(`${binary} on PATH`);
    }
    return { id, label, found: signals.length > 0, signals };
  });
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
