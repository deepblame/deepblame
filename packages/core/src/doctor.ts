import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { LEDGER_REF, QUEUE_FILE, SEAL_LOCK_FILE, STATE_DIR } from '@deepblame/protocol';
import { commandOnPath, detectHarnesses, type HarnessDetection } from './detect';
import { tryGit } from './git';
import { installedCommands, type HookFile } from './hooks';
import { readLedger } from './ledger';
import type { Repo } from './repo';
import { hydrate, readIndex, type IndexedRun } from './runindex';
import { readStateDir } from './state';

/**
 * "Why is it not recording anything?"
 *
 * This will be the first question anybody asks, and the honest answer is
 * usually dull: the agent has not run since the hooks went in, or the agent
 * they use is not the one that got hooked up. A tool that watches quietly has
 * to be able to account for its own silence, so every check here ends in
 * something to do rather than a diagnosis to interpret.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  /** One word, the thing being checked. */
  name: string;
  status: CheckStatus;
  /** What is true right now. */
  detail: string;
  /** What to do about it. Null when there is nothing to do. */
  fix: string | null;
}

export interface DoctorReport {
  repo: Repo;
  checks: Check[];
  /** Checks that are not ok. */
  problems: number;
}

/** How many recent runs to verify content for. Enough to spot a real problem. */
const SAMPLE = 40;
/** A queue older than this has been waiting through something. */
const STALE_QUEUE_MS = 6 * 60 * 60 * 1000;
/** A lock older than this belongs to a process that died. */
const STALE_LOCK_MS = 60_000;

export interface DoctorOptions {
  now?: Date;
  env?: NodeJS.ProcessEnv;
  hooks: readonly HookFile[];
}

export function diagnose(repo: Repo, options: DoctorOptions): DoctorReport {
  const now = (options.now ?? new Date()).getTime();
  const stateDir = join(repo.root, STATE_DIR);
  const state = readStateDir(repo.root);
  const ledger = readLedger(repo);
  const harnesses = detectHarnesses(repo.root, options.env);
  const installed = options.hooks.filter((hook) => hook.installed);
  const checks: Check[] = [];

  // 1. A repository at all.
  const branch = repo.branch ?? 'detached HEAD';
  const head = tryGit(['rev-parse', '--short', 'HEAD'], { cwd: repo.root });
  checks.push({
    name: 'repository',
    status: 'ok',
    detail: head === null ? `${branch}, no commits yet` : `${branch} @ ${head}`,
    fix: null,
  });

  // 2. The ledger.
  const runs = ledger.head === null ? [] : readIndex(repo);
  const latest = runs[0];
  if (ledger.head === null) {
    checks.push({
      name: 'ledger',
      status: 'fail',
      detail: 'no ledger in this repository',
      fix: 'deepblame init',
    });
  } else if (ledger.createdAt === null) {
    // The ref is there and it is not a ledger: its first commit has no
    // meta.json, so somebody has pointed the ref at ordinary history — a
    // mistyped `git update-ref`, a push of the wrong branch, a tool that
    // rewrote refs. Nothing will be recorded into it and nothing can be read
    // out of it, and this used to be reported as "created, nothing recorded
    // yet", which is the same silence this command exists to break.
    checks.push({
      name: 'ledger',
      status: 'fail',
      detail: `${LEDGER_REF} points at ${ledger.head.slice(0, 7)}, which is not a ledger: its first commit has no meta.json`,
      fix: `move it aside (git update-ref -d ${LEDGER_REF}) and run deepblame init`,
    });
  } else {
    checks.push({
      name: 'ledger',
      status: 'ok',
      detail:
        latest === undefined
          ? 'created, nothing recorded yet'
          : `${plural(runs.length, 'run')}, last one ${since(Date.parse(latest.at), now)}`,
      fix: null,
    });
  }

  // 3. Local state.
  checks.push(
    state.exists
      ? { name: 'state', status: 'ok', detail: `${STATE_DIR}/ present`, fix: null }
      : { name: 'state', status: 'fail', detail: `${STATE_DIR}/ is missing`, fix: 'deepblame init' },
  );

  // 4. Something reporting to us.
  checks.push(
    installed.length > 0
      ? { name: 'recording', status: 'ok', detail: adaptersOf(installed), fix: null }
      : {
          name: 'recording',
          status: 'fail',
          detail: 'nothing is set up to report to us',
          fix: 'deepblame hooks install --agent all',
        },
  );

  // 5. The hook is a line of text in somebody else's file. Does it still run?
  // This is the check that catches the whole family of silent failures, the
  // worst of which looks completely healthy: `npx deepblame init` puts the CLI
  // on PATH for the length of that one command, so a hook naming it is correct
  // while init verifies it and dead by the time an agent fires it.
  const broken = installedCommands(repo.root)
    .map((hook) => ({ hook, wrong: resolves(hook.command, options.env) }))
    .filter((one): one is { hook: (typeof one)['hook']; wrong: string } => one.wrong !== null);
  if (broken.length > 0) {
    checks.push({
      name: 'hook',
      status: 'fail',
      detail: broken.map((one) => one.wrong).join('; '),
      fix: 'deepblame init',
    });
  }

  // 6. An agent that is here but reports to nobody. The usual real problem.
  const missed = harnesses.filter((harness) => harness.found && !coveredBy(installed, harness));
  if (missed.length > 0) {
    checks.push({
      name: 'agents',
      status: 'warn',
      detail: `${missed.map((harness) => harness.label).join(', ')} ${missed.length === 1 ? 'is' : 'are'} used here but not hooked up`,
      fix: missed.map((harness) => `deepblame hooks install --agent ${harness.id}`).join('\n'),
    });
  } else if (harnesses.some((harness) => harness.found)) {
    checks.push({
      name: 'agents',
      status: 'ok',
      detail: harnesses.filter((h) => h.found).map((h) => h.label).join(', '),
      fix: null,
    });
  }

  // 7. Events that went in but never came out.
  const queuePath = join(stateDir, QUEUE_FILE);
  const queueAge = ageOf(queuePath, now);
  if (state.queued > 0 && queueAge !== null && queueAge > STALE_QUEUE_MS) {
    checks.push({
      name: 'queue',
      status: 'warn',
      detail: `${plural(state.queued, 'event')} waiting, untouched for ${duration(queueAge)}`,
      fix: 'the turn never ended; deepblame seal folds them in anyway',
    });
  } else if (state.queued > 0) {
    checks.push({
      name: 'queue',
      status: 'ok',
      detail: `${plural(state.queued, 'event')} waiting for the turn to end`,
      fix: null,
    });
  }

  // 8. A lock left behind by a sealer that died.
  const lockAge = ageOf(join(stateDir, SEAL_LOCK_FILE), now);
  if (lockAge !== null && lockAge > STALE_LOCK_MS) {
    checks.push({
      name: 'lock',
      status: 'warn',
      detail: `a seal has held the lock for ${duration(lockAge)}`,
      fix: `delete ${STATE_DIR}/${SEAL_LOCK_FILE} and run deepblame seal`,
    });
  }

  // 9. Whether the evidence blame and revert rely on is still there.
  if (runs.length > 0) {
    const missing = missingContent(repo, runs.slice(0, SAMPLE));
    checks.push(
      missing === 0
        ? {
            name: 'evidence',
            status: 'ok',
            detail: `every recent run's content is in the ledger`,
            fix: null,
          }
        : {
            name: 'evidence',
            status: 'warn',
            detail: `${plural(missing, 'run')} of the last ${Math.min(runs.length, SAMPLE)} lost the content they recorded`,
            fix: 'blame and revert will not claim those lines; nothing can bring the content back',
          },
    );
  }

  return { repo, checks, problems: checks.filter((check) => check.status !== 'ok').length };
}

/**
 * Runs whose recorded file states the repository no longer holds. Two git
 * processes: fetch the records, then ask about all their blobs at once.
 */
function missingContent(repo: Repo, entries: readonly IndexedRun[]): number {
  const runs = hydrate(repo, entries);
  const wanted = new Map<string, string[]>();
  for (const { run } of runs) {
    const oids = run.files_written
      .map((written) => written.post_blob_sha)
      .filter((oid): oid is string => oid !== null);
    if (oids.length > 0) wanted.set(run.run_id, oids);
  }
  if (wanted.size === 0) return 0;

  const all = [...new Set([...wanted.values()].flat())];
  const out = tryGit(['cat-file', '--batch-check'], {
    cwd: repo.root,
    input: `${all.map((oid) => `${oid}^{blob}`).join('\n')}\n`,
  });
  if (out === null) return 0;
  const present = new Set<string>();
  for (const line of out.split('\n')) {
    const match = /^([0-9a-f]+) blob \d+$/.exec(line.trim());
    if (match?.[1] !== undefined) present.add(match[1]);
  }

  let lost = 0;
  for (const oids of wanted.values()) if (oids.some((oid) => !present.has(oid))) lost += 1;
  return lost;
}

/**
 * Would this command line find anything to run?
 *
 * Not by running it — a hook runs an agent's capture path and must never be
 * fired to satisfy a check. Only the program is looked at: a path has to exist,
 * a bare name has to be on PATH. `npx …` is taken on trust, since deciding it
 * would mean going to the network.
 */
function resolves(command: string, env: NodeJS.ProcessEnv | undefined): string | null {
  const [program, ...rest] = words(command);
  if (program === undefined || program === '') return 'a hook has no command in it';
  // Taken on trust: deciding it would mean going to the network.
  if (/^npx(\.[a-z]+)?$/i.test(basename(program))) return null;

  const named = /[\\/]/.test(program);
  if (named && !isAbsolute(program)) return relative(program);
  if (named ? !existsSync(program) : !commandOnPath(program, env)) {
    return `a hook calls '${program}', which is not there — nothing is being recorded`;
  }

  // `node /path/to/capture.cjs` — whatever it is handed has to be there too.
  // The program itself is the interpreter and exists on every machine, so
  // checking only it would pass a hook whose script has been deleted.
  const script = rest.find((word) => /\.[cm]?js$/.test(word));
  if (script === undefined) return null;
  if (!isAbsolute(script)) return relative(script);
  return existsSync(script)
    ? null
    : `a hook calls '${script}', which is not there — nothing is being recorded`;
}

/**
 * A relative path in a hook is the quiet kind of wrong.
 *
 * Nothing decides what directory an agent fires its hooks from, so a path like
 * `packages/cli/dist/capture.cjs` records perfectly whenever the agent happens
 * to start at the top of the repository and silently records nothing when it
 * does not. Worse, checking it from the repository root — which is where
 * anyone runs `doctor` — finds the file and reports it healthy. It is only a
 * problem where nobody is looking, so it is called out on sight rather than
 * tested for existence.
 */
function relative(path: string): string {
  return `a hook calls '${path}', a relative path — it only records when the agent happens to run from the repository root`;
}

/**
 * A command line as words, honouring the quoting we write ourselves. Node's own
 * path has a space in it on Windows, so a command that is not unpicked properly
 * looks broken there and fine everywhere else.
 */
function words(command: string): string[] {
  const found: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return found;
}

/** The first word, for saying in the report which command is missing. */
function firstWord(command: string): string {
  return words(command)[0] ?? '';
}

function coveredBy(installed: readonly HookFile[], harness: HarnessDetection): boolean {
  const files = installed.map((hook) => hook.file.split('\\').join('/'));
  switch (harness.id) {
    case 'claude-code':
      return files.some((file) => file.includes('/.claude/'));
    case 'cursor':
      return files.some((file) => file.includes('/.cursor/'));
    case 'opencode':
      return files.some((file) => file.includes('/.opencode/'));
    case 'codex':
      return files.some((file) => file.includes('codex-notify'));
    default:
      return true;
  }
}

function adaptersOf(installed: readonly HookFile[]): string {
  const names: string[] = [];
  for (const hook of installed) {
    const file = hook.file.split('\\').join('/');
    if (file.includes('/.claude/')) names.push('Claude Code');
    else if (file.includes('/.cursor/')) names.push('Cursor');
    else if (file.includes('/.opencode/')) names.push('OpenCode');
    else if (file.includes('codex-notify')) names.push('Codex');
    else if (file.endsWith('post-commit')) names.push('every commit');
  }
  return [...new Set(names)].join(', ');
}

function ageOf(file: string, now: number): number | null {
  try {
    if (!existsSync(file)) return null;
    return Math.max(0, now - statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

function since(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  return ms < 60_000 ? 'just now' : `${duration(ms)} ago`;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, 'hour');
  return plural(Math.round(hours / 24), 'day');
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
