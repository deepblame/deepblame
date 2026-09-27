import {
  BLOBS_DIR,
  LEDGER_IDENTITY,
  LEDGER_REF,
  STATE_DIR,
  SEAL_INDEX_FILE,
} from '@deepblame/protocol';
import { join } from 'node:path';
import { git, tryGit } from './git';
import { readLedger } from './ledger';
import type { Repo } from './repo';
import { forgetIndex, hydrate, readIndex, type IndexedRun } from './runindex';

/**
 * Keeping the ledger from growing forever.
 *
 * The ledger stores the contents of every file an agent touched, because that
 * is the only way to prove a line is still the line an agent wrote, and the
 * only way to put it back. It is also the only part that grows without limit.
 *
 * So the contents age out and the records do not.
 *
 * Dropping a blob from the newest tree is not enough to let go of it: the
 * ledger is append-only, so every earlier commit's tree still points at it and
 * git will never collect it. Releasing it for real means the ledger's own
 * commit chain has to be replaced by a single commit holding the pruned tree.
 * That is the price, and it is stated plainly before anything is written: the
 * run records all survive — who, when, why, which files, what it cost — while
 * the seal-by-seal history of the ledger itself does not.
 *
 * Afterwards `blame` reports those older lines honestly, as unverifiable
 * rather than guessed, and only `revert` stops working that far back. An agent
 * turn from six months ago is not one anybody is about to undo.
 */

export interface GcPlan {
  /** Cutoff: runs that started before this lose their stored contents. */
  before: string;
  /** Runs old enough to prune. */
  runs: number;
  /** Runs whose contents are kept. */
  kept: number;
  /** Blobs that would be dropped from the ledger tree. */
  blobs: number;
  /** Bytes those blobs occupy, reclaimable once git collects them. */
  bytes: number;
  applied: boolean;
  /** The ledger commit written, once applied. */
  head: string | null;
  /** Ledger commits the compaction would replace with one. */
  history: number;
}

export interface GcOptions {
  /** Keep contents for runs from the last <n> days. */
  days?: number;
  /** Write the change. Without it nothing is touched. */
  apply?: boolean;
  now?: Date;
}

const DEFAULT_DAYS = 90;

/** What pruning would drop. Writes nothing unless asked. */
export function collect(repo: Repo, options: GcOptions = {}): GcPlan {
  const now = options.now ?? new Date();
  const days = options.days ?? DEFAULT_DAYS;
  const before = new Date(now.getTime() - days * 86_400_000);
  const head = readLedger(repo).head;
  const empty: GcPlan = {
    before: before.toISOString(),
    runs: 0,
    kept: 0,
    blobs: 0,
    bytes: 0,
    applied: false,
    head,
    history: 0,
  };
  if (head === null) return empty;

  const index = readIndex(repo);
  const old = index.filter((entry) => Date.parse(entry.at) < before.getTime());
  const recent = index.filter((entry) => Date.parse(entry.at) >= before.getTime());
  if (old.length === 0) return { ...empty, kept: recent.length };

  // A blob referenced by a run we are keeping stays, however old it is: two
  // runs often leave a file in the same state.
  const keep = blobsOf(repo, recent);
  const drop = new Set<string>();
  for (const oid of blobsOf(repo, old)) if (!keep.has(oid)) drop.add(oid);

  const stored = storedBlobs(repo, head);
  const doomed = [...drop].filter((oid) => stored.has(oid));
  const bytes = doomed.reduce((total, oid) => total + (stored.get(oid) ?? 0), 0);

  const plan: GcPlan = {
    before: before.toISOString(),
    runs: old.length,
    kept: recent.length,
    blobs: doomed.length,
    bytes,
    applied: false,
    head,
    history: countCommits(repo, head),
  };
  if (options.apply !== true || doomed.length === 0) return plan;

  return { ...plan, applied: true, head: prune(repo, head, doomed, now) };
}

/** Every file state these runs recorded. */
function blobsOf(repo: Repo, entries: readonly IndexedRun[]): Set<string> {
  const oids = new Set<string>();
  for (const { run } of hydrate(repo, entries)) {
    for (const written of run.files_written) {
      if (written.pre_blob_sha !== null) oids.add(written.pre_blob_sha);
      if (written.post_blob_sha !== null) oids.add(written.post_blob_sha);
    }
  }
  return oids;
}

/** What the ledger's own blobs/ tree holds, and how big each one is. */
function storedBlobs(repo: Repo, head: string): Map<string, number> {
  const listing = tryGit(['ls-tree', '-r', '-l', head, '--', BLOBS_DIR], { cwd: repo.root });
  const sizes = new Map<string, number>();
  if (listing === null) return sizes;
  for (const line of listing.split('\n')) {
    // "<mode> blob <oid> <size>\t<path>"
    const match = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t/.exec(line);
    if (match?.[1] !== undefined) sizes.set(match[1], Number(match[2] ?? 0));
  }
  return sizes;
}

function countCommits(repo: Repo, head: string): number {
  const out = tryGit(['rev-list', '--count', head], { cwd: repo.root });
  return out === null ? 0 : Number(out) || 0;
}

/**
 * Writes the compacted ledger: the current tree with those blobs removed, as a
 * single commit with no parent. A parent would keep the old trees reachable,
 * and with them every blob this was meant to release. The run records are
 * carried over untouched, because they live in the tree, not in the history.
 *
 * Plumbing throughout, and a compare-and-swap on the ref, exactly as the
 * sealer does it.
 */
function prune(repo: Repo, head: string, doomed: readonly string[], now: Date): string {
  const cwd = repo.root;
  const index = join(cwd, STATE_DIR, SEAL_INDEX_FILE);
  const env = { GIT_INDEX_FILE: index };

  git(['read-tree', head], { cwd, env });
  for (const oid of doomed) {
    git(['update-index', '--force-remove', '--', `${BLOBS_DIR}/${oid.slice(0, 2)}/${oid.slice(2)}`], { cwd, env });
  }
  const tree = git(['write-tree'], { cwd, env });

  const when = `${Math.floor(now.getTime() / 1000)} +0000`;
  const commit = git(['commit-tree', tree, '--no-gpg-sign', '-m', gcMessage(doomed.length, countCommits(repo, head))], {
    cwd,
    env: {
      ...env,
      GIT_AUTHOR_NAME: LEDGER_IDENTITY.name,
      GIT_AUTHOR_EMAIL: LEDGER_IDENTITY.email,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: LEDGER_IDENTITY.name,
      GIT_COMMITTER_EMAIL: LEDGER_IDENTITY.email,
      GIT_COMMITTER_DATE: when,
    },
  });
  git(['update-ref', LEDGER_REF, commit, head], { cwd });
  // The cache describes a ledger that has moved on.
  forgetIndex(repo);
  return commit;
}

function gcMessage(blobs: number, commits: number): string {
  return (
    `Compact the ledger, releasing ${blobs} stored file state${blobs === 1 ? '' : 's'}\n\n` +
    `Every run record is carried over. The ${commits} commit${commits === 1 ? '' : 's'} before this\n` +
    'one are replaced by this single commit, because an append-only history\n' +
    "keeps every old tree — and every blob in it — reachable forever.\n"
  );
}
