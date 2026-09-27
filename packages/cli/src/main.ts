import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  GitError,
  NotARepositoryError,
  commandOnPath,
  cost,
  hooks,
  init,
  log,
  sealNow,
  show,
  status,
  type HooksAction,
} from '@deepblame/core';
import { CLI_NAME } from '@deepblame/protocol';
import pkg from '../package.json' with { type: 'json' };
import {
  formatCost,
  formatHooks,
  formatInit,
  formatLog,
  formatSeal,
  formatShow,
  formatStatus,
  makeStyle,
} from './format';

export const VERSION: string = pkg.version;

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout(text: string): void;
  stderr(text: string): void;
  color: boolean;
  /** Path of this bundle. Hooks need a command that still works tomorrow. */
  entry?: string | undefined;
}

const EXIT = { ok: 0, failure: 1, usage: 2 } as const;
const DEFAULT_LIMIT = 20;

const HELP = `${CLI_NAME} ${VERSION}
Know which AI agent wrote every line of your code, why it wrote it,
and undo just that agent's work.

Usage
  ${CLI_NAME} init             set up the ledger and start recording
  ${CLI_NAME} status           show what is set up and what is recorded
  ${CLI_NAME} log              list recorded agent runs, newest first
  ${CLI_NAME} show <run>       show one run in full
  ${CLI_NAME} cost             what the agents spent, by model and agent
  ${CLI_NAME} seal             fold captured events into the ledger now
  ${CLI_NAME} hooks <action>   install, uninstall or check capture hooks

Options
  -C <dir>        run as if started in <dir>
  --limit <n>     how many runs to list (default ${DEFAULT_LIMIT})
  --days <n>      only count the last <n> days in cost
  --local         keep hooks in .claude/settings.local.json, uncommitted
  --no-hooks      set up without touching your agent's settings
  --no-seal       list only what is already in the ledger
  --json          machine-readable output
  -h, --help      show this help
  -v, --version   print the version

Recording covers Claude Code today. OpenCode, Codex and Cursor are next,
then blame --why and surgical revert.
`;

/** Returns the exit code instead of exiting, so it can be tested in-process. */
export function main(argv: readonly string[], io: Io): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        cwd: { type: 'string', short: 'C' },
        limit: { type: 'string' },
        days: { type: 'string' },
        local: { type: 'boolean' },
        'no-hooks': { type: 'boolean' },
        'no-seal': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    return usageError(io, firstSentence(error));
  }

  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  const [command, argument, extra] = positionals;
  if (values.help || command === undefined || command === 'help') {
    io.stdout(HELP);
    return EXIT.ok;
  }
  if (extra !== undefined) return usageError(io, `unexpected argument '${extra}'`);

  const cwd = values.cwd === undefined ? io.cwd : resolve(io.cwd, values.cwd);
  const style = makeStyle(io.color && !values.json);
  const takesArgument = command === 'show' || command === 'hooks';
  if (!takesArgument && argument !== undefined) return usageError(io, `unexpected argument '${argument}'`);

  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) return usageError(io, `--limit needs a positive number`);
  }
  let days: number | undefined;
  if (values.days !== undefined) {
    days = Number(values.days);
    if (!Number.isInteger(days) || days < 1) return usageError(io, `--days needs a positive number`);
  }

  try {
    switch (command) {
      case 'init': {
        const result = init(cwd, {
          env: io.env,
          hookCommand: hookCommand(io),
          noHooks: values['no-hooks'] === true,
          local: values.local === true,
        });
        io.stdout(values.json ? toJson(result) : formatInit(result, style));
        return EXIT.ok;
      }
      case 'status': {
        const report = status(cwd, { env: io.env });
        io.stdout(values.json ? toJson(report) : formatStatus(report, style));
        return EXIT.ok;
      }
      case 'log': {
        const report = log(cwd, { env: io.env, limit, seal: values['no-seal'] !== true });
        io.stdout(values.json ? toJson(report) : formatLog(report, style));
        return EXIT.ok;
      }
      case 'show': {
        if (argument === undefined) return usageError(io, `${CLI_NAME} show needs a run id`);
        const report = show(cwd, argument, { env: io.env, seal: values['no-seal'] !== true });
        if (report.entry === null) {
          io.stderr(`${CLI_NAME}: no run matches '${argument}'.\nRun '${CLI_NAME} log' to see what is recorded.\n`);
          return EXIT.failure;
        }
        io.stdout(values.json ? toJson(report.entry) : formatShow(report.entry, style));
        return EXIT.ok;
      }
      case 'cost': {
        const report = cost(cwd, { env: io.env, days, seal: values['no-seal'] !== true });
        io.stdout(values.json ? toJson(report) : formatCost(report, style));
        return EXIT.ok;
      }
      case 'seal': {
        const report = sealNow(cwd, { env: io.env });
        io.stdout(values.json ? toJson(report.result) : formatSeal(report.result, style));
        return EXIT.ok;
      }
      case 'hooks': {
        if (argument === undefined) return usageError(io, `${CLI_NAME} hooks needs install, uninstall or status`);
        if (!isHooksAction(argument)) return usageError(io, `unknown hooks action '${argument}'`);
        const report = hooks(cwd, argument, {
          env: io.env,
          hookCommand: hookCommand(io),
          local: values.local === true,
        });
        io.stdout(values.json ? toJson(report) : formatHooks(report, style));
        return EXIT.ok;
      }
      default:
        return usageError(io, `unknown command '${command}'`);
    }
  } catch (error) {
    return failure(io, error);
  }
}

/**
 * How a hook should call us: the small capture binary, which loads none of
 * this. Preferably by name, otherwise the exact file next to this bundle
 * through the node that is running it, so a locally installed CLI keeps
 * recording after the shell that installed it is gone.
 */
function hookCommand(io: Io): string {
  const capture = `${CLI_NAME}-capture`;
  if (commandOnPath(capture, io.env)) return capture;
  const entry = io.entry;
  if (entry !== undefined && entry !== '') {
    const sibling = entry.endsWith('.mjs') ? join(dirname(entry), 'capture.mjs') : `${entry}-capture`;
    if (existsSync(sibling)) return `${quote(process.execPath)} ${quote(sibling)}`;
  }
  if (commandOnPath(CLI_NAME, io.env)) return `${CLI_NAME} capture --agent claude-code`;
  if (entry !== undefined && entry !== '') {
    return `${quote(process.execPath)} ${quote(entry)} capture --agent claude-code`;
  }
  return `npx --yes --package=${CLI_NAME} ${capture}`;
}

function quote(path: string): string {
  return /[\s"']/.test(path) ? `"${path}"` : path;
}

function isHooksAction(value: string): value is HooksAction {
  return value === 'install' || value === 'uninstall' || value === 'status';
}

function usageError(io: Io, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nSee '${CLI_NAME} --help'.\n`);
  return EXIT.usage;
}

function failure(io: Io, error: unknown): number {
  if (error instanceof NotARepositoryError) {
    io.stderr(`${CLI_NAME}: not inside a git repository.\nRun it from your project folder, or run 'git init' first.\n`);
  } else if (error instanceof GitError && error.status === null) {
    io.stderr(`${CLI_NAME}: git was not found on your PATH. Install git and try again.\n`);
  } else if (error instanceof GitError) {
    io.stderr(`${CLI_NAME}: git ${error.args[0] ?? ''} failed: ${error.message}\n`);
  } else {
    const detail = io.env.DEBUG && error instanceof Error ? `\n${error.stack}` : '';
    io.stderr(`${CLI_NAME}: unexpected error: ${error instanceof Error ? error.message : String(error)}${detail}\n`);
  }
  return EXIT.failure;
}

function firstSentence(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('. ')[0] ?? message;
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
