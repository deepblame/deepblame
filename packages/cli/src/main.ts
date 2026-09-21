import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GitError, NotARepositoryError, init, status } from '@deepblame/core';
import { CLI_NAME } from '@deepblame/protocol';
import pkg from '../package.json' with { type: 'json' };
import { formatInit, formatStatus, makeStyle } from './format';

export const VERSION: string = pkg.version;

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout(text: string): void;
  stderr(text: string): void;
  color: boolean;
}

const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

const HELP = `${CLI_NAME} ${VERSION}
Know which AI agent wrote every line of your code, why it wrote it,
and undo just that agent's work.

Usage
  ${CLI_NAME} init       set up the ledger in this repository
  ${CLI_NAME} status     show what is set up and what is recorded

Options
  -C <dir>        run as if started in <dir>
  --json          machine-readable output
  -h, --help      show this help
  -v, --version   print the version

Coming next: capture hooks for OpenCode, Claude Code, Codex and Cursor,
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
  const [command, extra] = positionals;
  if (values.help || command === undefined || command === 'help') {
    io.stdout(HELP);
    return EXIT.ok;
  }
  if (extra !== undefined) return usageError(io, `unexpected argument '${extra}'`);

  const cwd = values.cwd === undefined ? io.cwd : resolve(io.cwd, values.cwd);
  const style = makeStyle(io.color && !values.json);
  try {
    switch (command) {
      case 'init': {
        const result = init(cwd, { env: io.env });
        io.stdout(values.json ? toJson(result) : formatInit(result, style));
        return EXIT.ok;
      }
      case 'status': {
        const report = status(cwd, { env: io.env });
        io.stdout(values.json ? toJson(report) : formatStatus(report, style));
        return EXIT.ok;
      }
      default:
        return usageError(io, `unknown command '${command}'`);
    }
  } catch (error) {
    return failure(io, error);
  }
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
