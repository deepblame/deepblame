import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  FileNotTrackedError,
  GitError,
  NotARepositoryError,
  blame,
  capturePath,
  commandOnPath,
  cost,
  doctor,
  gc,
  hooks,
  init,
  log,
  openRepo,
  recordCommit,
  recordTurn,
  report,
  revert,
  sealNow,
  share,
  show,
  status,
  type CaptureBundle,
  type HookAgent,
  type HooksAction,
} from '@deepblame/core';
import { CLI_NAME } from '@deepblame/protocol';
import pkg from '../package.json' with { type: 'json' };
import {
  formatBlame,
  formatBlameLine,
  formatCost,
  formatDoctor,
  formatGc,
  formatHooks,
  formatInit,
  formatLog,
  formatReport,
  formatRevert,
  formatShare,
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
  ${CLI_NAME} blame <file>     which agent wrote each line, and how sure we are
  ${CLI_NAME} cost             what the agents spent, by model and agent
  ${CLI_NAME} revert           undo one agent's work and nobody else's
  ${CLI_NAME} report --base <r> who wrote the lines this change touches
  ${CLI_NAME} push             send the ledger to the team's remote
  ${CLI_NAME} pull             take in the team's ledger and join it
  ${CLI_NAME} doctor           check that recording is actually working
  ${CLI_NAME} gc               age old file contents out of the ledger
  ${CLI_NAME} seal             fold captured events into the ledger now
  ${CLI_NAME} hooks <action>   install, uninstall or check capture hooks
                   ${' '.repeat(CLI_NAME.length)}   --agent claude-code | opencode | cursor |
                   ${' '.repeat(CLI_NAME.length)}           codex | git | all
                   ${' '.repeat(CLI_NAME.length)}   git records every commit, which covers
                   ${' '.repeat(CLI_NAME.length)}   the tools that have no hooks of their own

Options
  -C <dir>        run as if started in <dir>
  --limit <n>     how many runs to list (default ${DEFAULT_LIMIT})
  --days <n>      only count the last <n> days in cost
  --why <line>    explain one line in blame
  --run <id>      which run to revert; repeat for several
  --agent <name>  which agent to revert, or to hook up
  --hours <n>     only revert runs from the last <n> hours
  --apply         actually write the revert or the gc; nothing is touched without it
  --conflicts     write conflicted files too, with merge markers
  --local         keep hooks in .claude/settings.local.json, uncommitted
  --no-hooks      set up without touching your agent's settings
  --no-seal       list only what is already in the ledger
  --base <ref>    what to compare against in report
  --remote <name> which remote to share the ledger with (default origin)
  --markdown      report as markdown, for a pull request comment
  --json          machine-readable output
  -h, --help      show this help
  -v, --version   print the version

Recording covers Claude Code, OpenCode and Cursor in full, Codex turn by
turn, and every other tool at commit level.
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
        hours: { type: 'string' },
        why: { type: 'string' },
        base: { type: 'string' },
        head: { type: 'string' },
        remote: { type: 'string' },
        markdown: { type: 'boolean' },
        run: { type: 'string', multiple: true },
        apply: { type: 'boolean' },
        conflicts: { type: 'boolean' },
        agent: { type: 'string' },
        intent: { type: 'string' },
        notify: { type: 'string' },
        mark: { type: 'boolean' },
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
  const takesArgument = command === 'show' || command === 'hooks' || command === 'blame';
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
  let hours: number | undefined;
  if (values.hours !== undefined) {
    hours = Number(values.hours);
    if (!Number.isFinite(hours) || hours <= 0) return usageError(io, `--hours needs a positive number`);
  }

  try {
    switch (command) {
      case 'init': {
        const wiring = values['no-hooks'] !== true;
        const root = worktreeRoot(cwd);
        const result = init(cwd, {
          env: io.env,
          hookCommand: wiring ? hookCommand(io, root) : '',
          cursorCommand: wiring ? cursorCommand(io, root) : '',
          captureSource: captureBundle(io),
          version: pkg.version,
          noHooks: !wiring,
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
      case 'blame': {
        if (argument === undefined) return usageError(io, `${CLI_NAME} blame needs a file`);
        let why: number | undefined;
        if (values.why !== undefined) {
          why = Number(values.why);
          if (!Number.isInteger(why) || why < 1) return usageError(io, `--why needs a line number`);
        }
        const report = blame(cwd, argument, { env: io.env, line: why, seal: values['no-seal'] !== true });
        if (values.json) io.stdout(toJson(why === undefined ? report.result : report.line));
        else io.stdout(why === undefined ? formatBlame(report, style) : formatBlameLine(report, why, style));
        return EXIT.ok;
      }
      case 'cost': {
        const report = cost(cwd, { env: io.env, days, seal: values['no-seal'] !== true });
        io.stdout(values.json ? toJson(report) : formatCost(report, style));
        return EXIT.ok;
      }
      case 'revert': {
        const report = revert(cwd, {
          env: io.env,
          runs: values.run,
          agent: values.agent,
          hours,
          apply: values.apply === true,
          conflicts: values.conflicts === true,
          seal: values['no-seal'] !== true,
        });
        io.stdout(values.json ? toJson(report.plan) : formatRevert(report, style));
        // Nothing matched, or something was left behind: both are results
        // rather than crashes, but a script has to be able to tell.
        if (report.plan !== null && report.initialized && report.plan.runs.length === 0) return EXIT.failure;
        if (report.plan?.applied === true && report.plan.skipped.length > 0) return EXIT.failure;
        return EXIT.ok;
      }
      case 'report': {
        if (values.base === undefined) return usageError(io, `${CLI_NAME} report needs --base <ref>`);
        const built = report(cwd, values.base, { env: io.env, head: values.head });
        if (values.json) io.stdout(toJson(built.result));
        else io.stdout(formatReport(built, style, values.markdown === true));
        return EXIT.ok;
      }
      case 'push':
      case 'pull': {
        const shared = share(cwd, command, { env: io.env, remote: values.remote });
        io.stdout(values.json ? toJson(shared.result) : formatShare(shared, style));
        return EXIT.ok;
      }
      case 'doctor': {
        const report = doctor(cwd, { env: io.env });
        io.stdout(values.json ? toJson(report.checks) : formatDoctor(report, style));
        // A script running this in CI wants to know, not to read.
        return report.checks.some((check) => check.status === 'fail') ? EXIT.failure : EXIT.ok;
      }
      case 'gc': {
        const report = gc(cwd, { env: io.env, days, apply: values.apply === true });
        io.stdout(values.json ? toJson(report.plan) : formatGc(report, style));
        return EXIT.ok;
      }
      case 'seal': {
        const report = sealNow(cwd, { env: io.env });
        io.stdout(values.json ? toJson(report.result) : formatSeal(report.result, style));
        return EXIT.ok;
      }
      // Called by the post-commit hook. Quiet on purpose: it must never get
      // in the way of a commit, and nobody asked it to speak.
      case 'record-commit': {
        const report = recordCommit(cwd, { env: io.env });
        if (values.json) io.stdout(toJson({ recorded: report.recorded, run: report.run?.run_id ?? null }));
        return EXIT.ok;
      }
      // Called when a harness that reports only turns finishes one.
      case 'record-turn': {
        const report = recordTurn(cwd, {
          env: io.env,
          agent: values.agent,
          intent: values.intent ?? intentFromNotify(values.notify),
          mark: values.mark === true,
        });
        if (values.json) io.stdout(toJson({ recorded: report.recorded, run: report.run?.run_id ?? null }));
        return EXIT.ok;
      }
      case 'hooks': {
        if (argument === undefined) return usageError(io, `${CLI_NAME} hooks needs install, uninstall or status`);
        if (!isHooksAction(argument)) return usageError(io, `unknown hooks action '${argument}'`);
        const agent = values.agent ?? 'claude-code';
        if (!isHookAgent(agent)) {
          return usageError(io, `--agent takes claude-code, opencode, cursor, codex, git or all`);
        }
        // Only an install writes a command anywhere, and only an install
        // should therefore put a copy of the capture program in the worktree.
        const writing = argument === 'install';
        const root = worktreeRoot(cwd);
        const report = hooks(cwd, argument, {
          env: io.env,
          hookCommand: writing ? hookCommand(io, root) : '',
          commitCommand: commitCommand(io),
          turnCommand: turnCommand(io),
          cursorCommand: writing ? cursorCommand(io, root) : '',
          captureSource: captureBundle(io),
          version: pkg.version,
          local: values.local === true,
          agent,
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
 * this.
 *
 * The command goes into somebody else's settings file and has to still work
 * months from now, in whatever shell their editor spawns. So a copy of the
 * capture program is put inside the repository and the hook holds its full
 * path — no PATH lookup, no npm cache, nothing that can quietly stop being
 * true. `npx deepblame init` is exactly that case: it puts the CLI on PATH for
 * the length of one command, long enough to look installed and not a second
 * longer.
 *
 * Only when there is no bundle to copy — running from source in development —
 * does this fall back to naming something and hoping.
 */
function hookCommand(io: Io, root: string): string {
  if (captureBundle(io).capture !== null) return `${quote(process.execPath)} ${quote(capturePath(root))}`;

  const capture = `${CLI_NAME}-capture`;
  if (commandOnPath(capture, io.env)) return capture;
  if (commandOnPath(CLI_NAME, io.env)) return `${CLI_NAME} capture --agent claude-code`;
  const entry = io.entry;
  if (entry !== undefined && entry !== '') {
    return `${quote(process.execPath)} ${quote(entry)} capture --agent claude-code`;
  }
  return `npx --yes --package=${CLI_NAME} ${capture}`;
}

/**
 * The worktree the hook path must be written against: the state directory sits
 * at the top of the repository, not wherever the command happened to be run.
 * Falls back to here when this is not a repository, since the command that
 * follows will report that properly.
 */
function worktreeRoot(cwd: string): string {
  try {
    return openRepo(cwd).root;
  } catch {
    return cwd;
  }
}

/**
 * The two programs shipped beside this one: the capture hot path, and this
 * bundle itself, which is what seals when a turn ends.
 */
function captureBundle(io: Io): CaptureBundle {
  const entry = io.entry;
  if (entry === undefined || entry === '') return { capture: null };
  // npm and npx put a shim in front of the CLI, so the name in argv is not the
  // file. Resolving it first is what makes the pair findable: guessing from the
  // shim's name found the capture bundle and missed the sealer entirely, and
  // nothing said so — the turn just sat in the queue.
  let real = entry;
  try {
    real = realpathSync(entry);
  } catch {
    // Not a link, or gone. Whatever argv gave us is the best we have.
  }
  const beside = dirname(real);
  const capture = join(beside, 'capture.cjs');
  const cli = join(beside, `${CLI_NAME}.mjs`);
  return { capture: existsSync(capture) ? capture : null, cli: existsSync(cli) ? cli : null };
}

/**
 * Codex hands its notify program a JSON blob. The only part we want is what
 * the user asked for; anything else in there is none of our business.
 */
function intentFromNotify(notify: string | undefined): string | null {
  if (notify === undefined || notify.trim() === '') return null;
  try {
    const payload: unknown = JSON.parse(notify);
    if (typeof payload !== 'object' || payload === null) return null;
    const messages = (payload as Record<string, unknown>)['input-messages'];
    if (Array.isArray(messages)) return messages.filter((item) => typeof item === 'string').join(' ').trim() || null;
    return null;
  } catch {
    return null;
  }
}

/** How the git hook should call us. It runs once per commit, so size is no object. */
function commitCommand(io: Io): string {
  if (commandOnPath(CLI_NAME, io.env)) return `${CLI_NAME} record-commit`;
  const entry = io.entry;
  if (entry !== undefined && entry !== '') return `${quote(process.execPath)} ${quote(entry)} record-commit`;
  return `npx --yes ${CLI_NAME} record-commit`;
}

function turnCommand(io: Io): string {
  if (commandOnPath(CLI_NAME, io.env)) return `${CLI_NAME} record-turn`;
  const entry = io.entry;
  if (entry !== undefined && entry !== '') return `${quote(process.execPath)} ${quote(entry)} record-turn`;
  return `npx --yes ${CLI_NAME} record-turn`;
}

function quote(path: string): string {
  return /[\s"']/.test(path) ? `"${path}"` : path;
}

function isHookAgent(value: string): value is HookAgent {
  const known = ['claude-code', 'opencode', 'cursor', 'codex', 'git', 'all'];
  return known.includes(value);
}

/** Cursor sends its own payload shape, so its hook says whose it is. */
function cursorCommand(io: Io, root: string): string {
  return `${hookCommand(io, root)} --agent cursor`;
}

function isHooksAction(value: string): value is HooksAction {
  return value === 'install' || value === 'uninstall' || value === 'status';
}

function usageError(io: Io, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nSee '${CLI_NAME} --help'.\n`);
  return EXIT.usage;
}

function failure(io: Io, error: unknown): number {
  if (error instanceof FileNotTrackedError) {
    io.stderr(`${CLI_NAME}: ${error.message}\nGive a path inside this repository.\n`);
  } else if (error instanceof NotARepositoryError) {
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
