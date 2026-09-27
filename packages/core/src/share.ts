import { join } from 'node:path';
import { LEDGER_IDENTITY, LEDGER_REF, SEAL_INDEX_FILE, STATE_DIR } from '@deepblame/protocol';
import { GitError, git, tryGit } from './git';
import { readLedger } from './ledger';
import type { Repo } from './repo';
import { forgetIndex } from './runindex';

/**
 * One ledger for a team, not one per laptop.
 *
 * Until now the record of who wrote what lived on the machine that watched it
 * happen, which answers the question for you and nobody else. The ledger is a
 * git ref, so sharing it is the thing git is already good at: push it, fetch
 * it, merge it.
 *
 * The merge is the part worth explaining. The two kinds of thing a ledger
 * holds can be joined by taking every entry from both, because a conflict is
 * not possible by construction: a run record's path is its own uuid and the
 * record never changes after it is written, and a stored file's path is the
 * hash of its contents. Two machines therefore never write different things to
 * the same path. If one ever does, it is a bug or a tampered ledger, and this
 * keeps what is already local and says so rather than quietly picking a side.
 *
 * The ledger's own metadata is the exception, and an ordinary one: two people
 * each ran `init`, so each ledger records its own birthday. Merging keeps the
 * earlier of the two, because that is when this ledger started.
 */

export interface ShareResult {
  remote: string;
  /** The ledger commit the ref points at afterwards. */
  head: string | null;
  /** Runs that came in from the remote and were not here before. */
  gained: number;
  /** Runs this machine has that the remote did not. */
  ahead: number;
  /** Paths that differ between the two ledgers. Should always be empty. */
  disputed: string[];
  /** Nothing to do: the two were already the same. */
  unchanged: boolean;
}

export class NoLedgerError extends Error {
  override name = 'NoLedgerError';
  constructor() {
    super('there is no ledger here yet');
  }
}

/** Where a fetched ledger is parked before it is merged. */
const INCOMING = 'refs/deepblame/incoming';
/** The ledger's own metadata, which is per-ledger rather than per-run. */
const META_FILE = 'meta.json';

/** Sends this machine's ledger to the remote, after taking in anything new. */
export function pushLedger(repo: Repo, remote = 'origin'): ShareResult {
  const merged = pullLedger(repo, remote);
  const head = readLedger(repo).head;
  if (head === null) throw new NoLedgerError();
  git(['push', remote, `${head}:${LEDGER_REF}`], { cwd: repo.root });
  return { ...merged, head, ahead: 0 };
}

/** Takes in the remote's ledger and folds it into this one. */
export function pullLedger(repo: Repo, remote = 'origin'): ShareResult {
  const cwd = repo.root;
  const mine = readLedger(repo).head;
  const blank: ShareResult = { remote, head: mine, gained: 0, ahead: 0, disputed: [], unchanged: true };

  // A remote with no ledger yet is the normal first push, not a failure.
  const fetched = tryGit(['fetch', '--no-tags', remote, `+${LEDGER_REF}:${INCOMING}`], { cwd });
  if (fetched === null) return blank;
  const theirs = tryGit(['rev-parse', '--verify', '--quiet', `${INCOMING}^{commit}`], { cwd });
  if (theirs === null) return blank;
  if (mine === null) {
    git(['update-ref', LEDGER_REF, theirs], { cwd });
    forgetIndex(repo);
    return { ...blank, head: theirs, gained: runCount(repo, theirs), unchanged: false };
  }
  if (mine === theirs) return blank;

  // Already have everything they do.
  if (tryGit(['merge-base', '--is-ancestor', theirs, mine], { cwd }) !== null) {
    return { ...blank, ahead: countBetween(repo, theirs, mine) };
  }
  // They have everything we do, so take theirs whole.
  if (tryGit(['merge-base', '--is-ancestor', mine, theirs], { cwd }) !== null) {
    git(['update-ref', LEDGER_REF, theirs, mine], { cwd });
    forgetIndex(repo);
    return { ...blank, head: theirs, gained: countBetween(repo, mine, theirs), unchanged: false };
  }

  return joinLedgers(repo, remote, mine, theirs);
}

/** Both sides have runs the other has not. Take every entry from both. */
function joinLedgers(repo: Repo, remote: string, mine: string, theirs: string): ShareResult {
  const cwd = repo.root;
  const ours = entriesOf(repo, mine);
  const incoming = entriesOf(repo, theirs);

  const disputed: string[] = [];
  const union = new Map(ours);
  for (const [path, entry] of incoming) {
    const held = union.get(path);
    if (held === undefined) {
      union.set(path, entry);
      continue;
    }
    if (held.oid === entry.oid) continue;
    // Two people each ran init, so each ledger has its own birthday. Keep the
    // earlier one: that is when this record of the work began.
    if (path === META_FILE) {
      if (bornEarlier(repo, entry.oid, held.oid)) union.set(path, entry);
      continue;
    }
    // Anything else at the same path with different content is impossible by
    // construction, so something is wrong: keep what is local and say so.
    disputed.push(path);
  }

  const index = join(cwd, STATE_DIR, SEAL_INDEX_FILE);
  const env = { GIT_INDEX_FILE: index };
  git(['read-tree', '--empty'], { cwd, env });
  for (const [path, entry] of union) {
    git(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.oid},${path}`], { cwd, env });
  }
  const tree = git(['write-tree'], { cwd, env });

  const gained = [...incoming.keys()].filter((path) => path.startsWith('runs/') && !ours.has(path)).length;
  const ahead = [...ours.keys()].filter((path) => path.startsWith('runs/') && !incoming.has(path)).length;
  const when = `${Math.floor(Date.now() / 1000)} +0000`;
  const commit = git(
    ['commit-tree', tree, '-p', mine, '-p', theirs, '--no-gpg-sign', '-m', mergeMessage(gained, ahead, remote)],
    {
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
    },
  );
  git(['update-ref', LEDGER_REF, commit, mine], { cwd });
  forgetIndex(repo);
  return { remote, head: commit, gained, ahead, disputed, unchanged: false };
}

interface Entry {
  mode: string;
  oid: string;
}

/** True when the first metadata blob records an earlier start than the second. */
function bornEarlier(repo: Repo, candidate: string, held: string): boolean {
  const at = (oid: string): number => {
    const raw = tryGit(['cat-file', 'blob', oid], { cwd: repo.root, raw: true });
    if (raw === null) return Number.POSITIVE_INFINITY;
    try {
      const value: unknown = JSON.parse(raw);
      const when = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['created_at'] : null;
      const parsed = typeof when === 'string' ? Date.parse(when) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  return at(candidate) < at(held);
}

/** Every path in a ledger tree, with the mode and object id git needs back. */
function entriesOf(repo: Repo, commit: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const listing = tryGit(['ls-tree', '-r', commit], { cwd: repo.root });
  if (listing === null) return entries;
  for (const line of listing.split('\n')) {
    const match = /^(\d+) (?:blob|commit) ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match === null) continue;
    const [, mode = '', oid = '', path = ''] = match;
    entries.set(path, { mode, oid });
  }
  return entries;
}

function runCount(repo: Repo, commit: string): number {
  const listing = tryGit(['ls-tree', '-r', '--name-only', commit, '--', 'runs'], { cwd: repo.root });
  return listing === null || listing === '' ? 0 : listing.split('\n').filter((line) => line !== '').length;
}

/** Runs present in `to` and not in `from`. */
function countBetween(repo: Repo, from: string, to: string): number {
  const before = entriesOf(repo, from);
  let count = 0;
  for (const path of entriesOf(repo, to).keys()) if (path.startsWith('runs/') && !before.has(path)) count += 1;
  return count;
}

function mergeMessage(gained: number, ahead: number, remote: string): string {
  return (
    `Join the ledger with ${remote}\n\n` +
    `${gained} run${gained === 1 ? '' : 's'} came in, ${ahead} went out. Run records are\n` +
    'immutable and keyed by their own id, and stored file contents are keyed by\n' +
    'their hash, so joining two ledgers is taking every entry from both.\n'
  );
}

/** Turns a git failure into something a person can act on. */
export function shareError(error: unknown): string | null {
  if (!(error instanceof GitError)) return null;
  const said = error.stderr;
  if (said.includes('does not appear to be a git repository') || said.includes('Could not read from remote')) {
    return 'that remote is not reachable from here';
  }
  if (said.includes('Permission denied') || said.includes('403')) return 'you do not have permission to push there';
  return said === '' ? null : said.split('\n')[0] ?? null;
}
