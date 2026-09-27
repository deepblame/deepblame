import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { STATE_DIR, type HarnessId, type Run } from '@deepblame/protocol';
import { FileNotTrackedError, blameFile, type BlameResult, type BlameSpan } from './blame';
import { detectHarnesses, type HarnessDetection } from './detect';
import { diagnose, type DoctorReport } from './doctor';
import { collect, type GcOptions, type GcPlan } from './gc';
import { tryGit } from './git';
import { runFromCommit } from './gitrun';
import {
  CODEX_NOTIFY,
  OPENCODE_PLUGIN,
  OPENCODE_PLUGIN_DIR,
  codexNotifyInstalled,
  cursorHooksInstalled,
  cursorHooksPath,
  gitHookInstalled,
  hooksInstalled,
  installClaudeCode,
  installCodexNotify,
  installCursorHooks,
  installGitHook,
  installOpenCodePlugin,
  openCodePluginInstalled,
  uninstallClaudeCode,
  uninstallCodexNotify,
  uninstallCursorHooks,
  uninstallGitHook,
  uninstallOpenCodePlugin,
  type HookChange,
  type HookFile,
} from './hooks';
import { createGenesis, readLedger, type LedgerState } from './ledger';
import { openRepo, type Repo } from './repo';
import { applyRevert, planRevert, type RevertPlan } from './revert';
import { findRun, indexedRuns, listRuns, type LedgerRun } from './runs';
import { appendRuns, seal, type SealResult } from './seal';
import { ensureStateDir, readStateDir, type StateDirInfo } from './state';
import { markWorktree, recordWorktreeTurn } from './worktree';

export interface CommandOptions {
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface HookOptions {
  /** How a hook should call us. Without it nothing is installed. */
  hookCommand?: string;
  /** How the git hook should call us; the capture command will not do. */
  commitCommand?: string;
  /** Leave the agent's settings alone. */
  noHooks?: boolean;
  /** Write to the personal settings file instead of the shared one. */
  local?: boolean;
  /** Which adapter to act on. Defaults to Claude Code. */
  agent?: HookAgent;
  /** How the Codex notify script should call us. */
  turnCommand?: string;
  /** How Cursor's hooks should call us; they send their own payload shape. */
  cursorCommand?: string;
}

/** Where git keeps this repository's hooks, honouring core.hooksPath. */
export function hooksDirOf(repo: Repo): string {
  const configured = tryGit(['config', '--get', 'core.hooksPath'], { cwd: repo.root });
  return configured === null || configured === '' ? join(repo.commonDir, 'hooks') : resolve(repo.root, configured);
}

function hookFilesOf(repo: Repo): HookFile[] {
  const hooksDir = hooksDirOf(repo);
  const stateDir = join(repo.root, STATE_DIR);
  return [
    ...hooksInstalled(repo.root),
    { file: join(hooksDir, 'post-commit'), installed: gitHookInstalled(hooksDir) },
    { file: join(stateDir, CODEX_NOTIFY), installed: codexNotifyInstalled(stateDir) },
    { file: join(repo.root, OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN), installed: openCodePluginInstalled(repo.root) },
    { file: cursorHooksPath(repo.root), installed: cursorHooksInstalled(repo.root) },
  ];
}

export interface RecordTurnOptions extends CommandOptions {
  agent?: string;
  intent?: string | null;
  /** Only move the baseline forward, recording nothing. */
  mark?: boolean;
}

/**
 * Records what a turn changed for a harness that reports turns but not tools.
 * Used by the Codex notify script, and by anything else that can run a
 * command when its agent stops.
 */
export function recordTurn(cwd: string, options: RecordTurnOptions = {}): RecordCommitReport {
  const repo = openRepo(cwd);
  const now = options.now ?? new Date();
  if (!readStateDir(repo.root).exists) return { repo, run: null, recorded: false, head: null };
  if (options.mark === true) {
    markWorktree(repo, now);
    return { repo, run: null, recorded: false, head: readLedger(repo).head };
  }
  const run = recordWorktreeTurn(repo, {
    agent: (options.agent ?? 'git') as HarnessId,
    intent: options.intent ?? null,
    now,
  });
  if (run === null) return { repo, run: null, recorded: false, head: readLedger(repo).head };
  const result = appendRuns(repo, [run], now);
  return { repo, run, recorded: result.sealed > 0, head: result.head };
}

export interface InitResult {
  repo: Repo;
  ledger: { head: string; created: boolean };
  stateDir: { path: string; created: boolean };
  harnesses: HarnessDetection[];
  /** Settings files this init changed, if any. */
  hooks: HookChange[];
}

/**
 * Idempotent: safe to run again, repairs a deleted state directory, and
 * installs capture hooks for the agents it finds so that recording starts
 * without a second command.
 */
export function init(cwd: string, options: CommandOptions & HookOptions = {}): InitResult {
  const repo = openRepo(cwd);
  const now = options.now ?? new Date();
  const existing = readLedger(repo).head;
  const harnesses = detectHarnesses(repo.root, options.env);
  const claudeCode = harnesses.find((harness) => harness.id === 'claude-code');
  const hooks: HookChange[] = [];
  const result: InitResult = {
    repo,
    ledger: existing !== null ? { head: existing, created: false } : createGenesis(repo, now),
    stateDir: ensureStateDir(repo.root, now, { objectFormat: repo.objectFormat }),
    harnesses,
    hooks,
  };
  if (options.noHooks !== true && options.hookCommand !== undefined) {
    if (claudeCode?.found === true) {
      hooks.push(installClaudeCode(repo.root, options.hookCommand, { local: options.local }));
    }
    if (harnesses.find((harness) => harness.id === 'opencode')?.found === true) {
      hooks.push(installOpenCodePlugin(repo.root, options.hookCommand));
    }
    if (options.cursorCommand !== undefined && harnesses.find((h) => h.id === 'cursor')?.found === true) {
      hooks.push(installCursorHooks(repo.root, options.cursorCommand));
    }
  }
  return result;
}

export interface StatusReport {
  repo: Repo;
  initialized: boolean;
  ledger: LedgerState;
  stateDir: StateDirInfo;
  harnesses: HarnessDetection[];
  /** Settings files that call us, whether or not they changed today. */
  hooks: HookFile[];
  /** True once at least one agent is wired up to report to us. */
  recording: boolean;
}

export function status(cwd: string, options: CommandOptions = {}): StatusReport {
  const repo = openRepo(cwd);
  const ledger = readLedger(repo);
  const stateDir = readStateDir(repo.root);
  const hooks = hookFilesOf(repo);
  return {
    repo,
    initialized: ledger.head !== null && stateDir.exists,
    ledger,
    stateDir,
    harnesses: detectHarnesses(repo.root, options.env),
    hooks,
    recording: hooks.some((hook) => hook.installed),
  };
}

export interface LogOptions extends CommandOptions {
  limit?: number;
  /** Fold pending events into the ledger first. On by default. */
  seal?: boolean;
}

export interface LogReport {
  repo: Repo;
  initialized: boolean;
  runs: LedgerRun[];
  sealed: SealResult | null;
  /** Events still waiting because their turn has not ended. */
  queued: number;
}

export function log(cwd: string, options: LogOptions = {}): LogReport {
  const repo = openRepo(cwd);
  const stateDir = readStateDir(repo.root);
  const initialized = readLedger(repo).head !== null && stateDir.exists;
  if (!initialized) return { repo, initialized, runs: [], sealed: null, queued: stateDir.queued };
  const sealed = options.seal === false ? null : seal(repo, { now: options.now });
  return {
    repo,
    initialized,
    runs: listRuns(repo, { limit: options.limit ?? 20 }),
    sealed,
    queued: readStateDir(repo.root).queued,
  };
}

export interface ShowReport {
  repo: Repo;
  id: string;
  entry: LedgerRun | null;
}

export interface ShowOptions extends CommandOptions {
  /** Fold pending events into the ledger first. On by default. */
  seal?: boolean;
}

export function show(cwd: string, id: string, options: ShowOptions = {}): ShowReport {
  const repo = openRepo(cwd);
  if (options.seal !== false) seal(repo, { now: options.now });
  return { repo, id, entry: findRun(repo, id) };
}

export interface BlameOptions extends CommandOptions {
  seal?: boolean;
  /** Explain one line instead of the whole file. */
  line?: number;
}

export interface BlameReport {
  repo: Repo;
  initialized: boolean;
  /** Repository-relative path, as the ledger spells it. */
  path: string;
  result: BlameResult | null;
  /** Set when a line was asked about; null when that line has no known author. */
  line: BlameSpan | null;
}

/** Who wrote each line of a file, and how sure we are. */
export function blame(cwd: string, file: string, options: BlameOptions = {}): BlameReport {
  const repo = openRepo(cwd);
  const stateDir = readStateDir(repo.root);
  const initialized = readLedger(repo).head !== null && stateDir.exists;
  const path = repoRelative(repo, cwd, file);
  if (!initialized) return { repo, initialized, path, result: null, line: null };
  if (options.seal !== false) seal(repo, { now: options.now });
  const result = blameFile(repo, path);
  const line = options.line === undefined ? null : result.spans.find((span) => span.from <= (options.line as number) && span.to >= (options.line as number)) ?? null;
  return { repo, initialized, path, result, line };
}

/** Accepts what the user typed: absolute, relative to here, or already repo-relative. */
function repoRelative(repo: Repo, cwd: string, file: string): string {
  const absolute = isAbsolute(file) ? file : resolve(cwd, file);
  const rel = relative(repo.root, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new FileNotTrackedError(file);
  return sep === '/' ? rel : rel.split(sep).join('/');
}

export interface CostBucket {
  /** A model name, or an agent id, depending on the grouping. */
  key: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  usd: number;
  /** Runs counted here whose model has no known rate. */
  unpriced: number;
}

export interface CostReport {
  repo: Repo;
  initialized: boolean;
  /** How far back the report looks; null means the whole ledger. */
  days: number | null;
  runs: number;
  /** Runs with no usage recorded at all, usually from before capture was on. */
  unmeasured: number;
  totals: {
    input_tokens: number;
    output_tokens: number;
    cache_write_tokens: number;
    cache_read_tokens: number;
    usd: number;
    unpriced: number;
  };
  byModel: CostBucket[];
  byAgent: CostBucket[];
}

export interface CostOptions extends CommandOptions {
  /** Only count runs that started within this many days. */
  days?: number;
  seal?: boolean;
}

/** What the agents spent, from the ledger's own records. */
export function cost(cwd: string, options: CostOptions = {}): CostReport {
  const repo = openRepo(cwd);
  const stateDir = readStateDir(repo.root);
  const initialized = readLedger(repo).head !== null && stateDir.exists;
  const empty: CostReport = {
    repo,
    initialized,
    days: options.days ?? null,
    runs: 0,
    unmeasured: 0,
    totals: { input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, usd: 0, unpriced: 0 },
    byModel: [],
    byAgent: [],
  };
  if (!initialized) return empty;
  if (options.seal !== false) seal(repo, { now: options.now });

  const now = (options.now ?? new Date()).getTime();
  const cutoff = options.days === undefined ? null : now - options.days * 86_400_000;
  const report = { ...empty };
  const models = new Map<string, CostBucket>();
  const agents = new Map<string, CostBucket>();
  const bucket = (into: Map<string, CostBucket>, key: string): CostBucket => {
    const found = into.get(key);
    if (found !== undefined) return found;
    const fresh: CostBucket = { key, runs: 0, input_tokens: 0, output_tokens: 0, usd: 0, unpriced: 0 };
    into.set(key, fresh);
    return fresh;
  };

  // Straight off the index: spend is a summary, and summarising should not
  // mean reading and validating every record in the ledger.
  for (const run of indexedRuns(repo)) {
    if (cutoff !== null && Date.parse(run.at) < cutoff) continue;
    report.runs += 1;
    const spend = run.cost;
    if (spend === null) {
      report.unmeasured += 1;
      continue;
    }
    report.totals.input_tokens += spend.in;
    report.totals.output_tokens += spend.out;
    report.totals.cache_write_tokens += spend.cw;
    report.totals.cache_read_tokens += spend.cr;
    if (spend.usd === null) report.totals.unpriced += 1;
    else report.totals.usd += spend.usd;

    for (const [into, key] of [
      [models, run.model ?? 'unknown model'],
      [agents, run.agent],
    ] as const) {
      const entry = bucket(into, key);
      entry.runs += 1;
      entry.input_tokens += spend.in;
      entry.output_tokens += spend.out;
      if (spend.usd === null) entry.unpriced += 1;
      else entry.usd += spend.usd;
    }
  }

  const bySpend = (a: CostBucket, b: CostBucket): number => b.usd - a.usd || b.runs - a.runs;
  report.totals.usd = Math.round(report.totals.usd * 1e6) / 1e6;
  report.byModel = [...models.values()].sort(bySpend);
  report.byAgent = [...agents.values()].sort(bySpend);
  return report;
}

export interface RevertOptions extends CommandOptions {
  /** Run ids, or unambiguous prefixes. */
  runs?: readonly string[];
  /** Undo everything one harness did. */
  agent?: string;
  /** Only runs from the last <n> hours. */
  hours?: number;
  /** Write the plan out. Without it, nothing is touched. */
  apply?: boolean;
  /** Write conflicted files too, with merge markers. */
  conflicts?: boolean;
  seal?: boolean;
}

export interface RevertReport {
  repo: Repo;
  initialized: boolean;
  /** Null when DeepBlame is not set up here. */
  plan: RevertPlan | null;
  /** How the runs were chosen, for the message when nothing matched. */
  selection: { runs: readonly string[]; agent: string | null; hours: number | null };
}

/**
 * Undoes one agent's work and leaves everyone else's alone. A plan first,
 * always: `apply` is the only thing that writes, and even then a conflicted
 * file is left for the person unless they ask otherwise.
 */
export function revert(cwd: string, options: RevertOptions = {}): RevertReport {
  const repo = openRepo(cwd);
  const stateDir = readStateDir(repo.root);
  const initialized = readLedger(repo).head !== null && stateDir.exists;
  const selection = {
    runs: options.runs ?? [],
    agent: options.agent ?? null,
    hours: options.hours ?? null,
  };
  if (!initialized) return { repo, initialized, plan: null, selection };
  if (options.seal !== false) seal(repo, { now: options.now });

  const plan = planRevert(repo, {
    runs: options.runs,
    agent: options.agent,
    hours: options.hours,
    now: options.now,
  });
  if (options.apply !== true || plan.runs.length === 0) return { repo, initialized, plan, selection };
  return { repo, initialized, plan: applyRevert(repo, plan, { conflicts: options.conflicts }), selection };
}

/**
 * Accounts for the tool's own silence. Everything it reports comes with
 * something to do, because "not recording" is a state people need to get out
 * of, not a diagnosis to admire.
 */
export function doctor(cwd: string, options: CommandOptions = {}): DoctorReport {
  const repo = openRepo(cwd);
  return diagnose(repo, { now: options.now, env: options.env, hooks: hookFilesOf(repo) });
}

export interface GcReport {
  repo: Repo;
  plan: GcPlan;
  initialized: boolean;
}

/** Ages the stored file contents out of the ledger, keeping every run record. */
export function gc(cwd: string, options: CommandOptions & GcOptions = {}): GcReport {
  const repo = openRepo(cwd);
  const initialized = readLedger(repo).head !== null && readStateDir(repo.root).exists;
  const plan = collect(repo, { days: options.days, apply: options.apply, now: options.now });
  return { repo, plan, initialized };
}

export interface SealReport {
  repo: Repo;
  result: SealResult;
}

export function sealNow(cwd: string, options: CommandOptions = {}): SealReport {
  const repo = openRepo(cwd);
  return { repo, result: seal(repo, { now: options.now }) };
}

export type HooksAction = 'install' | 'uninstall' | 'status';

export interface HooksReport {
  repo: Repo;
  action: HooksAction;
  /** What the run changed; empty for `status`. */
  changes: HookChange[];
  /** Where things stand afterwards. */
  files: HookFile[];
  harnesses: HarnessDetection[];
}

/** Which adapter a `hooks` command is about. */
export type HookAgent = 'claude-code' | 'git' | 'codex' | 'opencode' | 'cursor' | 'all';

export function hooks(cwd: string, action: HooksAction, options: CommandOptions & HookOptions = {}): HooksReport {
  const repo = openRepo(cwd);
  const agent = options.agent ?? 'claude-code';
  const changes: HookChange[] = [];
  if (action === 'install') {
    if (agent === 'claude-code' || agent === 'all') {
      if (options.hookCommand === undefined) throw new Error('no command to install');
      changes.push(installClaudeCode(repo.root, options.hookCommand, { local: options.local }));
    }
    if (agent === 'git' || agent === 'all') {
      if (options.commitCommand === undefined) throw new Error('no command to install');
      changes.push(installGitHook(hooksDirOf(repo), options.commitCommand));
    }
    if (agent === 'codex' || agent === 'all') {
      if (options.turnCommand === undefined) throw new Error('no command to install');
      changes.push(installCodexNotify(repo.root, options.turnCommand, join(repo.root, STATE_DIR)));
    }
    if (agent === 'opencode' || agent === 'all') {
      if (options.hookCommand === undefined) throw new Error('no command to install');
      changes.push(installOpenCodePlugin(repo.root, options.hookCommand));
    }
    if (agent === 'cursor' || agent === 'all') {
      if (options.cursorCommand === undefined) throw new Error('no command to install');
      changes.push(installCursorHooks(repo.root, options.cursorCommand));
    }
  } else if (action === 'uninstall') {
    changes.push(uninstallClaudeCode(repo.root, { local: false }));
    changes.push(uninstallClaudeCode(repo.root, { local: true }));
    changes.push(uninstallGitHook(hooksDirOf(repo)));
    changes.push(uninstallCodexNotify(join(repo.root, STATE_DIR)));
    changes.push(uninstallOpenCodePlugin(repo.root));
    changes.push(uninstallCursorHooks(repo.root));
  }
  return {
    repo,
    action,
    changes,
    files: hookFilesOf(repo),
    harnesses: detectHarnesses(repo.root, options.env),
  };
}

export interface RecordCommitReport {
  repo: Repo;
  /** Null when there was nothing to record, or DeepBlame is not set up here. */
  run: Run | null;
  /** False when the ledger already held this commit. */
  recorded: boolean;
  head: string | null;
}

/**
 * Records the commit that just landed. Called by the post-commit hook, so it
 * must never fail loudly: a recorder that breaks `git commit` is a recorder
 * people rip out the same afternoon.
 */
export function recordCommit(cwd: string, options: CommandOptions & { ref?: string } = {}): RecordCommitReport {
  const repo = openRepo(cwd);
  const now = options.now ?? new Date();
  if (!readStateDir(repo.root).exists) return { repo, run: null, recorded: false, head: null };
  const run = runFromCommit(repo, options.ref ?? 'HEAD', now);
  if (run === null) return { repo, run: null, recorded: false, head: readLedger(repo).head };
  const result = appendRuns(repo, [run], now);
  return { repo, run, recorded: result.sealed > 0, head: result.head };
}
