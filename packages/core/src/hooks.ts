import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLI_NAME, PRODUCT_NAME } from '@deepblame/protocol';

/**
 * Adapter installation. Each harness gets its events to us its own way; the
 * rule everywhere is that we add our entry, leave everything else in the file
 * exactly as it was, and can take our entry back out again.
 */

export const CLAUDE_DIR = '.claude';
export const CLAUDE_SETTINGS = 'settings.json';
export const CLAUDE_SETTINGS_LOCAL = 'settings.local.json';

/** Marks the lines we wrote into someone else's file, so we can remove exactly those. */
const MARKER = `# ${PRODUCT_NAME}: records this commit, for tools that have no hooks of their own.`;

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

/**
 * The fallback adapter: a `post-commit` hook, so a tool with no hooks at all
 * is still on the record at commit granularity. Someone else's hook in that
 * file is kept; we add a line and can take exactly that line back out.
 */
export function installGitHook(hooksDir: string, command: string): HookChange {
  const file = join(hooksDir, 'post-commit');
  const call = `${command} || true`;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (existing !== null && existing.includes(MARKER)) return { file, installed: true, changed: false, command };

  const body =
    existing === null
      ? `#!/bin/sh\n${MARKER}\n${call}\n`
      : `${existing.endsWith('\n') ? existing : `${existing}\n`}\n${MARKER}\n${call}\n`;
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return { file, installed: true, changed: true, command };
}

export function uninstallGitHook(hooksDir: string): HookChange {
  const file = join(hooksDir, 'post-commit');
  if (!existsSync(file)) return { file, installed: false, changed: false, command: '' };
  const before = readFileSync(file, 'utf8');
  if (!before.includes(MARKER)) return { file, installed: false, changed: false, command: '' };
  const kept = before
    .split('\n')
    .filter((line) => !line.includes(MARKER) && !line.includes('record-commit'))
    .join('\n');
  // Nothing but a shebang and blank lines left: the file was only ever ours.
  if (kept.replace(/^#!.*$/m, '').trim() === '') rmSync(file, { force: true });
  else writeFileSync(file, kept.endsWith('\n') ? kept : `${kept}\n`);
  return { file, installed: false, changed: true, command: '' };
}

export function gitHookInstalled(hooksDir: string): boolean {
  const file = join(hooksDir, 'post-commit');
  try {
    return existsSync(file) && readFileSync(file, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
}

export const CODEX_NOTIFY = 'codex-notify.sh';

/**
 * Codex tells a program of its own choosing when a turn ends, and that is all
 * it tells anyone. We write that program; the user points their Codex config
 * at it, because a tool has no business editing a config outside the project.
 */
export function installCodexNotify(root: string, command: string, stateDir: string): HookChange {
  const file = join(stateDir, CODEX_NOTIFY);
  const body = [
    '#!/bin/sh',
    MARKER,
    `cd ${shellQuote(root)} || exit 0`,
    `${command} --agent codex --notify "$1" >/dev/null 2>&1 || true`,
    '',
  ].join('\n');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (existing === body) return { file, installed: true, changed: false, command };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return { file, installed: true, changed: true, command };
}

export function uninstallCodexNotify(stateDir: string): HookChange {
  const file = join(stateDir, CODEX_NOTIFY);
  const changed = existsSync(file);
  rmSync(file, { force: true });
  return { file, installed: false, changed, command: '' };
}

export function codexNotifyInstalled(stateDir: string): boolean {
  return existsSync(join(stateDir, CODEX_NOTIFY));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
