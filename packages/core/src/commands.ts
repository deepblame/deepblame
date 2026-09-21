import { detectHarnesses, type HarnessDetection } from './detect';
import { createGenesis, readLedger, type LedgerState } from './ledger';
import { openRepo, type Repo } from './repo';
import { ensureStateDir, readStateDir, type StateDirInfo } from './state';

export interface CommandOptions {
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface InitResult {
  repo: Repo;
  ledger: { head: string; created: boolean };
  stateDir: { path: string; created: boolean };
  harnesses: HarnessDetection[];
}

/** Idempotent: safe to run again, and repairs a deleted state directory. */
export function init(cwd: string, options: CommandOptions = {}): InitResult {
  const repo = openRepo(cwd);
  const now = options.now ?? new Date();
  const existing = readLedger(repo).head;
  return {
    repo,
    ledger: existing !== null ? { head: existing, created: false } : createGenesis(repo, now),
    stateDir: ensureStateDir(repo.root, now),
    harnesses: detectHarnesses(repo.root, options.env),
  };
}

export interface StatusReport {
  repo: Repo;
  initialized: boolean;
  ledger: LedgerState;
  stateDir: StateDirInfo;
  harnesses: HarnessDetection[];
  /** Capture hooks arrive with the adapters; until then nothing is recorded. */
  recording: boolean;
}

export function status(cwd: string, options: CommandOptions = {}): StatusReport {
  const repo = openRepo(cwd);
  const ledger = readLedger(repo);
  const stateDir = readStateDir(repo.root);
  return {
    repo,
    initialized: ledger.head !== null && stateDir.exists,
    ledger,
    stateDir,
    harnesses: detectHarnesses(repo.root, options.env),
    recording: false,
  };
}
