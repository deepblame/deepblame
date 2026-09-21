import { resolve } from 'node:path';
import { GitError, git, tryGit } from './git';

export interface Repo {
  /** Top level of the current worktree. The state directory lives here. */
  root: string;
  /** Git directory shared by all worktrees. The ledger ref lives here. */
  commonDir: string;
  objectFormat: 'sha1' | 'sha256';
  /** False in a freshly initialised repository with no commits yet. */
  hasCommits: boolean;
  /** Null on a detached HEAD. */
  branch: string | null;
}

export class NotARepositoryError extends Error {
  override name = 'NotARepositoryError';
  constructor(readonly cwd: string) {
    super(`not inside a git work tree: ${cwd}`);
  }
}

export function openRepo(cwd: string): Repo {
  let root: string;
  try {
    // resolve() turns git's forward-slash paths into native ones on Windows.
    root = resolve(git(['rev-parse', '--show-toplevel'], { cwd }));
  } catch (error) {
    if (error instanceof GitError && error.status !== null) throw new NotARepositoryError(cwd);
    throw error;
  }
  const commonDir = resolve(root, git(['rev-parse', '--git-common-dir'], { cwd: root }));
  const format = tryGit(['rev-parse', '--show-object-format'], { cwd: root });
  return {
    root,
    commonDir,
    objectFormat: format === 'sha256' ? 'sha256' : 'sha1',
    hasCommits: tryGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: root }) !== null,
    branch: tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root }),
  };
}
