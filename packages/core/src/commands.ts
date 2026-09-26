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
