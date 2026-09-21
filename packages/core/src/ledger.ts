import {
  CLI_NAME,
  LEDGER_IDENTITY,
  LEDGER_REF,
  LedgerMetaSchema,
  SCHEMA_VERSION,
  type LedgerMeta,
} from '@deepblame/protocol';
import { GitError, git, tryGit } from './git';
import type { Repo } from './repo';

export interface LedgerState {
  ref: string;
  /** Latest ledger commit, or null before init. */
  head: string | null;
  /** Root commit of the ledger. Stable for the life of the repository. */
  genesis: string | null;
  createdAt: string | null;
  runs: number;
}

export function readLedger(repo: Repo): LedgerState {
  const cwd = repo.root;
  const head = tryGit(['rev-parse', '--verify', '--quiet', `${LEDGER_REF}^{commit}`], { cwd });
  if (head === null) {
    return { ref: LEDGER_REF, head: null, genesis: null, createdAt: null, runs: 0 };
  }
  const genesis = git(['rev-list', '--max-parents=0', head], { cwd }).split('\n')[0] ?? head;
  const metaRaw = tryGit(['cat-file', 'blob', `${genesis}:meta.json`], { cwd, raw: true });
  const meta = metaRaw === null ? null : LedgerMetaSchema.safeParse(safeJson(metaRaw));
  const runFiles = git(['ls-tree', '-r', '--name-only', head, '--', 'runs'], { cwd });
  return {
    ref: LEDGER_REF,
    head,
    genesis,
    createdAt: meta?.success ? meta.data.created_at : null,
    runs: runFiles === '' ? 0 : runFiles.split('\n').length,
  };
}

/**
 * Writes the ledger's first commit using plumbing only: no checkout, no index,
 * no hooks. The commit is never signed with the user's key; ledger integrity
 * comes from its own hash chain, and a signing prompt must never block an agent.
 * If a concurrent init wins the race, its head is returned with created: false.
 */
export function createGenesis(repo: Repo, now: Date): { head: string; created: boolean } {
  const cwd = repo.root;
  const meta: LedgerMeta = {
    schema_version: SCHEMA_VERSION,
    created_at: now.toISOString(),
    created_by: `${CLI_NAME} init`,
  };
  const blob = git(['hash-object', '-w', '--stdin'], { cwd, input: `${JSON.stringify(meta, null, 2)}\n` });
  const tree = git(['mktree'], { cwd, input: `100644 blob ${blob}\tmeta.json\n` });
  const date = now.toISOString();
  const commit = git(['commit-tree', '--no-gpg-sign', tree, '-m', `${CLI_NAME}: ledger genesis`], {
    cwd,
    env: {
      GIT_AUTHOR_NAME: LEDGER_IDENTITY.name,
      GIT_AUTHOR_EMAIL: LEDGER_IDENTITY.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: LEDGER_IDENTITY.name,
      GIT_COMMITTER_EMAIL: LEDGER_IDENTITY.email,
      GIT_COMMITTER_DATE: date,
    },
  });
  try {
    // The empty old value makes the update fail if the ref already exists.
    git(['update-ref', '-m', `${CLI_NAME} init`, LEDGER_REF, commit, ''], { cwd });
    return { head: commit, created: true };
  } catch (error) {
    const winner = readLedger(repo).head;
    if (error instanceof GitError && winner !== null) return { head: winner, created: false };
    throw error;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
