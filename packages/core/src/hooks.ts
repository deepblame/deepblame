import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLI_NAME } from '@deepblame/protocol';

/**
 * Adapter installation. Each harness gets its events to us its own way; the
 * rule everywhere is that we add our entry, leave everything else in the file
 * exactly as it was, and can take our entry back out again.
 */

export const CLAUDE_DIR = '.claude';
export const CLAUDE_SETTINGS = 'settings.json';
export const CLAUDE_SETTINGS_LOCAL = 'settings.local.json';

/**
 * Ours, whichever way it is spelled: `deepblame-capture`, `deepblame capture`
 * or a path to the capture bundle inside a deepblame install.
 */
function isOurCommand(command: string): boolean {
  return command.includes('capture.mjs') || (command.includes(CLI_NAME) && command.includes('capture'));
}
/** Seconds. A capture that somehow hangs must not hold the agent up. */
const TIMEOUT = 10;

interface HookPoint {
  event: string;
  /** Claude Code matches tool names against this; '*' is every tool. */
  matcher?: string;
}

const CLAUDE_POINTS: readonly HookPoint[] = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
];

export interface HookFile {
  /** Absolute path of the settings file the change applies to. */
  file: string;
  installed: boolean;
}

export interface HookChange extends HookFile {
  /** False when the file already said exactly this. */
  changed: boolean;
  command: string;
}

export interface HookOptions {
  /** Write to the personal settings file instead of the shared one. */
  local?: boolean;
}

export function claudeSettingsPath(root: string, options: HookOptions = {}): string {
  return join(root, CLAUDE_DIR, options.local === true ? CLAUDE_SETTINGS_LOCAL : CLAUDE_SETTINGS);
}

/** True when either settings file already calls us. */
export function hooksInstalled(root: string): HookFile[] {
  return [claudeSettingsPath(root), claudeSettingsPath(root, { local: true })].map((file) => ({
    file,
    installed: fileCallsUs(file),
  }));
}

export function installClaudeCode(root: string, command: string, options: HookOptions = {}): HookChange {
  const file = claudeSettingsPath(root, options);
  const settings = readSettings(file);
  const hooks = asRecord(settings['hooks']);
  let changed = false;

  for (const point of CLAUDE_POINTS) {
    const groups = asArray(hooks[point.event]);
    const group = groups.find((candidate) => matcherOf(candidate) === (point.matcher ?? ''));
    const entry = { type: 'command', command, timeout: TIMEOUT };
    if (group === undefined) {
      groups.push({ ...(point.matcher === undefined ? {} : { matcher: point.matcher }), hooks: [entry] });
      changed = true;
    } else {
      const list = asArray(group['hooks']);
      const ours = list.findIndex((hook) => isOurs(hook));
      if (ours < 0) {
        list.push(entry);
        changed = true;
      } else if (asRecord(list[ours])['command'] !== command) {
        list[ours] = entry;
        changed = true;
      }
      group['hooks'] = list;
    }
    hooks[point.event] = groups;
  }

  settings['hooks'] = hooks;
  if (changed) writeSettings(file, settings);
  return { file, installed: true, changed, command };
}

export function uninstallClaudeCode(root: string, options: HookOptions = {}): HookChange {
  const file = claudeSettingsPath(root, options);
  if (!existsSync(file)) return { file, installed: false, changed: false, command: '' };
  const settings = readSettings(file);
  const hooks = asRecord(settings['hooks']);
  let changed = false;

  for (const event of Object.keys(hooks)) {
    const groups = asArray(hooks[event]);
    const kept: Record<string, unknown>[] = [];
    for (const group of groups) {
      const list = asArray(group['hooks']).filter((hook) => !isOurs(hook));
      if (list.length !== asArray(group['hooks']).length) changed = true;
      if (list.length === 0) continue;
      group['hooks'] = list;
      kept.push(group);
    }
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }

  if (Object.keys(hooks).length === 0) delete settings['hooks'];
  else settings['hooks'] = hooks;
  if (changed) writeSettings(file, settings);
  return { file, installed: false, changed, command: '' };
}

function fileCallsUs(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const settings = readSettings(file);
    const hooks = asRecord(settings['hooks']);
    return Object.values(hooks).some((groups) =>
      asArray(groups).some((group) => asArray(group['hooks']).some((hook) => isOurs(hook))),
    );
  } catch {
    return false;
  }
}

function isOurs(hook: unknown): boolean {
  const command = asRecord(hook)['command'];
  return typeof command === 'string' && isOurCommand(command);
}

function matcherOf(group: Record<string, unknown>): string {
  const matcher = group['matcher'];
  return typeof matcher === 'string' ? matcher : '';
}

function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    // A settings file we cannot read is a file we must not overwrite.
    throw new Error(`${file} is not valid JSON; fix it or move it out of the way`);
  }
}

function writeSettings(file: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((item) => typeof item === 'object' && item !== null) as Record<string, unknown>[]) : [];
}
