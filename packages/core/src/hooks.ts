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
/** The same idea for a file that is JavaScript rather than shell. */
const JS_MARKER = `// ${PRODUCT_NAME}: reports what OpenCode does, so ${CLI_NAME} can say who wrote each line.`;

/**
 * Ours, whichever way it is spelled: `deepblame-capture`, `deepblame capture`
 * or a path to the capture bundle inside a deepblame install.
 */
function isOurCommand(command: string): boolean {
  return /capture\.[cm]js/.test(command) || (command.includes(CLI_NAME) && command.includes('capture'));
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

export const CURSOR_DIR = '.cursor';
export const CURSOR_HOOKS = 'hooks.json';

/**
 * Cursor's hooks, which cover the same ground as Claude Code's: the prompt
 * before it is sent, every file read and edit, and the end of the turn. Its
 * file is a flat map of event name to a list of commands, so ours is one entry
 * among whatever else is already there.
 */
const CURSOR_POINTS: readonly string[] = [
  'sessionStart',
  'beforeSubmitPrompt',
  'beforeReadFile',
  'afterFileEdit',
  'stop',
];

export function cursorHooksPath(root: string): string {
  return join(root, CURSOR_DIR, CURSOR_HOOKS);
}

export function installCursorHooks(root: string, command: string): HookChange {
  const file = cursorHooksPath(root);
  const settings = readSettings(file);
  // Cursor refuses a file without it, and refuses a version it does not know.
  if (typeof settings['version'] !== 'number') settings['version'] = 1;
  const hooks = asRecord(settings['hooks']);
  let changed = !existsSync(file);

  for (const event of CURSOR_POINTS) {
    const list = asArray(hooks[event]);
    const ours = list.findIndex((hook) => isOurs(hook));
    const entry = { command, timeout: TIMEOUT };
    if (ours < 0) {
      list.push(entry);
      changed = true;
    } else if (asRecord(list[ours])['command'] !== command) {
      list[ours] = entry;
      changed = true;
    }
    hooks[event] = list;
  }

  settings['hooks'] = hooks;
  if (changed) writeSettings(file, settings);
  return { file, installed: true, changed, command };
}

export function uninstallCursorHooks(root: string): HookChange {
  const file = cursorHooksPath(root);
  if (!existsSync(file)) return { file, installed: false, changed: false, command: '' };
  const settings = readSettings(file);
  const hooks = asRecord(settings['hooks']);
  let changed = false;

  for (const event of Object.keys(hooks)) {
    const list = asArray(hooks[event]);
    const kept = list.filter((hook) => !isOurs(hook));
    if (kept.length !== list.length) changed = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }

  // A file that held nothing but our hooks was ours to begin with.
  if (Object.keys(hooks).length === 0) {
    rmSync(file, { force: true });
    return { file, installed: false, changed: true, command: '' };
  }
  settings['hooks'] = hooks;
  if (changed) writeSettings(file, settings);
  return { file, installed: false, changed, command: '' };
}

export function cursorHooksInstalled(root: string): boolean {
  return fileCallsUs(cursorHooksPath(root));
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

/** OpenCode loads every file in this directory as a plugin. */
export const OPENCODE_PLUGIN_DIR = join('.opencode', 'plugin');
export const OPENCODE_PLUGIN = 'deepblame.js';

/**
 * OpenCode's plugin API, which is the richest of the lot: it reports the
 * prompt, every tool call before and after it runs, and the assistant
 * message's own token count and price. So this adapter records as much as the
 * Claude Code one, and its cost figures come from OpenCode itself rather than
 * from a rate table of ours.
 *
 * Written against @opencode-ai/plugin's own type definitions:
 *   Plugin = (input: PluginInput, options?) => Promise<Hooks>
 *   "chat.message"      (input: { sessionID, … }, output: { message, parts })
 *   "tool.execute.before" (input: { tool, sessionID, callID }, output: { args })
 *   "tool.execute.after"  (input: { tool, sessionID, callID, args }, output: { title, output, metadata })
 *   event               (input: { event }) with session.idle and message.updated
 */
export function installOpenCodePlugin(root: string, command: string): HookChange {
  const dir = join(root, OPENCODE_PLUGIN_DIR);
  const file = join(dir, OPENCODE_PLUGIN);
  const body = openCodePluginSource(command);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (existing === body) return { file, installed: true, changed: false, command };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, body);
  return { file, installed: true, changed: true, command };
}

export function uninstallOpenCodePlugin(root: string): HookChange {
  const file = join(root, OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN);
  const changed = existsSync(file) && readFileSync(file, 'utf8').includes(JS_MARKER);
  if (changed) rmSync(file, { force: true });
  return { file, installed: false, changed, command: '' };
}

export function openCodePluginInstalled(root: string): boolean {
  const file = join(root, OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN);
  if (!existsSync(file)) return false;
  try {
    return readFileSync(file, 'utf8').includes(JS_MARKER);
  } catch {
    return false;
  }
}

/**
 * The plugin file itself. It is small on purpose and does nothing clever: it
 * turns OpenCode's hooks into the plain JSON this tool accepts and hands each
 * one to the capture command, which is the same path every other adapter uses.
 *
 * It never throws and never awaits anything slow, because it runs inside
 * somebody's turn.
 */
function openCodePluginSource(command: string): string {
  const [program = 'deepblame-capture', ...rest] = splitCommand(command);
  const args = JSON.stringify([...rest, '--agent', 'opencode']);
  return `${JS_MARKER}
// Delete this file, or run \`${CLI_NAME} hooks uninstall\`, to stop recording.
import { spawn } from "node:child_process";

const PROGRAM = ${JSON.stringify(program)};
const ARGS = ${args};

/** Hands one event to ${CLI_NAME} and waits only for it to be written. */
function report(event) {
  return new Promise((done) => {
    try {
      const child = spawn(PROGRAM, ARGS, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.on("error", () => done());
      child.on("close", () => done());
      child.stdin.on("error", () => done());
      child.stdin.end(JSON.stringify(event));
    } catch {
      done();
    }
  });
}

/** The path an edit is about, wherever this version of OpenCode keeps it. */
function pathOf(args) {
  if (args === null || typeof args !== "object") return null;
  for (const key of ["filePath", "file_path", "path", "file"]) {
    if (typeof args[key] === "string" && args[key] !== "") return args[key];
  }
  return null;
}

const WRITES = new Set(["edit", "write", "patch", "multiedit"]);
const READS = new Set(["read"]);

export const DeepBlame = async ({ directory, worktree }) => {
  const cwd = worktree || directory;
  const paths = new Map();

  return {
    "chat.message": async (input, output) => {
      const text = (output?.parts ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\\n")
        .trim();
      if (text === "") return;
      await report({ kind: "prompt", session: input.sessionID, cwd, text });
    },

    "tool.execute.before": async (input, output) => {
      const path = pathOf(output?.args);
      if (path === null || !WRITES.has(input.tool)) return;
      paths.set(input.callID, path);
      await report({ kind: "write-pre", session: input.sessionID, cwd, path });
    },

    "tool.execute.after": async (input, output) => {
      const session = input.sessionID;
      await report({
        kind: "tool",
        session,
        cwd,
        tool: input.tool,
        args: input.args ?? null,
        result: output?.title ?? null,
        ok: true,
      });
      const path = paths.get(input.callID) ?? pathOf(input.args);
      paths.delete(input.callID);
      if (path === null) return;
      if (READS.has(input.tool)) {
        await report({ kind: "read", session, cwd, path });
        return;
      }
      if (!WRITES.has(input.tool)) return;
      const args = input.args ?? {};
      await report({
        kind: "write",
        session,
        cwd,
        path,
        tool: input.tool,
        old: typeof args.oldString === "string" ? args.oldString : undefined,
        new: typeof args.newString === "string" ? args.newString : undefined,
        all: args.replaceAll === true,
      });
    },

    event: async ({ event }) => {
      // OpenCode counts its own tokens and knows its own prices, so we take
      // its figures rather than guessing from a rate table.
      if (event?.type === "message.updated" && event.properties?.info?.role === "assistant") {
        const info = event.properties.info;
        await report({
          kind: "usage",
          session: info.sessionID,
          cwd,
          model: info.modelID ?? null,
          provider: info.providerID ?? null,
          input: info.tokens?.input ?? 0,
          output: info.tokens?.output ?? 0,
          cache_read: info.tokens?.cache?.read ?? 0,
          cache_write: info.tokens?.cache?.write ?? 0,
          usd: typeof info.cost === "number" ? info.cost : null,
        });
        return;
      }
      if (event?.type === "session.idle") {
        await report({ kind: "end", session: event.properties?.sessionID, cwd, reason: "session.idle" });
      }
    },
  };
};
`;
}

/** Splits a stored command back into program and arguments, honouring quotes. */
function splitCommand(command: string): string[] {
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((part) => (/^["'].*["']$/.test(part) ? part.slice(1, -1) : part));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * True when this settings file calls our capture command. Handles both shapes
 * we write: Claude Code nests commands under a matcher group, Cursor lists
 * them directly against the event.
 */
function fileCallsUs(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const hooks = asRecord(readSettings(file)['hooks']);
    return Object.values(hooks).some((entries) =>
      asArray(entries).some((entry) => isOurs(entry) || asArray(entry['hooks']).some((hook) => isOurs(hook))),
    );
  } catch {
    return false;
  }
}

function isOurs(hook: unknown): boolean {
  const command = asRecord(hook)['command'];
  return typeof command === 'string' && isOurCommand(command);
}

/**
 * The capture commands actually written into the agents' settings, so `doctor`
 * can check they still resolve to something. A hook is a line of text in
 * someone else's file: it can be right the day it is written and wrong the
 * next, and nothing about capturing tells you — it never prints.
 */
export function installedCommands(root: string): { file: string; command: string }[] {
  const found: { file: string; command: string }[] = [];
  const files = [claudeSettingsPath(root), claudeSettingsPath(root, { local: true }), cursorHooksPath(root)];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let hooks: Record<string, unknown>;
    try {
      hooks = asRecord(readSettings(file)['hooks']);
    } catch {
      continue;
    }
    for (const entries of Object.values(hooks)) {
      for (const entry of asArray(entries)) {
        for (const hook of [entry, ...asArray(entry['hooks'])]) {
          const command = asRecord(hook)['command'];
          if (typeof command === 'string' && isOurCommand(command) && !found.some((one) => one.command === command)) {
            found.push({ file, command });
          }
        }
      }
    }
  }
  return found;
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
