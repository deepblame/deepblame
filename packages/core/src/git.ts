import { execFileSync } from 'node:child_process';

export class GitError extends Error {
  override name = 'GitError';
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
    /** Exit status, or null when git could not be started at all. */
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface GitOptions {
  cwd: string;
  input?: string;
  env?: Record<string, string>;
  /** Keep trailing whitespace; needed when reading blob contents. */
  raw?: boolean;
}

/**
 * Runs git without a shell, so paths and messages are never interpreted.
 * Throws GitError with git's own stderr when the command fails.
 */
export function git(args: readonly string[], options: GitOptions): string {
  try {
    const out = execFileSync('git', args, {
      cwd: options.cwd,
      input: options.input,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return options.raw ? out : out.trimEnd();
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
    if (e.code === 'ENOENT') {
      throw new GitError('git was not found on your PATH', args, '', null);
    }
    const stderr = String(e.stderr ?? '').trim();
    throw new GitError(stderr || `git ${args[0] ?? ''} failed`, args, stderr, e.status ?? null);
  }
}

/** Like git(), but returns null when git exits non-zero. Missing git still throws. */
export function tryGit(args: readonly string[], options: GitOptions): string | null {
  try {
    return git(args, options);
  } catch (error) {
    if (error instanceof GitError && error.status !== null) return null;
    throw error;
  }
}
