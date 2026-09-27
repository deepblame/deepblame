import { detectHarnesses, type HarnessDetection } from './detect';
import {
  hooksInstalled,
  installClaudeCode,
  uninstallClaudeCode,
  type HookChange,
  type HookFile,
} from './hooks';
import { createGenesis, readLedger, type LedgerState } from './ledger';
import { openRepo, type Repo } from './repo';
import { findRun, listRuns, type LedgerRun } from './runs';
import { seal, type SealResult } from './seal';
import { ensureStateDir, readStateDir, type StateDirInfo } from './state';

export interface CommandOptions {
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface HookOptions {
  /** How a hook should call us. Without it nothing is installed. */
  hookCommand?: string;
  /** Leave the agent's settings alone. */
  noHooks?: boolean;
  /** Write to the personal settings file instead of the shared one. */
  local?: boolean;
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
  if (options.noHooks !== true && options.hookCommand !== undefined && claudeCode?.found === true) {
    hooks.push(installClaudeCode(repo.root, options.hookCommand, { local: options.local }));
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
  const hooks = hooksInstalled(repo.root);
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

  for (const { run } of listRuns(repo)) {
    if (cutoff !== null && Date.parse(run.started_at) < cutoff) continue;
    report.runs += 1;
    const spend = run.cost;
    if (spend === undefined) {
      report.unmeasured += 1;
      continue;
    }
    report.totals.input_tokens += spend.input_tokens;
    report.totals.output_tokens += spend.output_tokens;
    report.totals.cache_write_tokens += spend.cache_write_tokens ?? 0;
    report.totals.cache_read_tokens += spend.cache_read_tokens ?? 0;
    if (spend.usd === null) report.totals.unpriced += 1;
    else report.totals.usd += spend.usd;

    for (const [into, key] of [
      [models, run.model?.name ?? 'unknown model'],
      [agents, run.harness.name],
    ] as const) {
      const entry = bucket(into, key);
      entry.runs += 1;
      entry.input_tokens += spend.input_tokens;
      entry.output_tokens += spend.output_tokens;
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

export function hooks(cwd: string, action: HooksAction, options: CommandOptions & HookOptions = {}): HooksReport {
  const repo = openRepo(cwd);
  const changes: HookChange[] = [];
  if (action === 'install') {
    if (options.hookCommand === undefined) throw new Error('no command to install');
    changes.push(installClaudeCode(repo.root, options.hookCommand, { local: options.local }));
  } else if (action === 'uninstall') {
    changes.push(uninstallClaudeCode(repo.root, { local: false }));
    changes.push(uninstallClaudeCode(repo.root, { local: true }));
  }
  return {
    repo,
    action,
    changes,
    files: hooksInstalled(repo.root),
    harnesses: detectHarnesses(repo.root, options.env),
  };
}
