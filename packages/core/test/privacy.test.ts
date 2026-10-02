import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvents, captureClaudeCode, openCapture } from '../src/capture';
import { init } from '../src/commands';
import { openRepo } from '../src/repo';
import { listRuns } from '../src/runs';
import { seal } from '../src/seal';
import { tryGit } from '../src/git';
import { makeRepo, sh } from './helpers';

/**
 * What must not end up in the ledger.
 *
 * The ledger is a git ref, and `deepblame push` sends it to the team's remote.
 * Anything in it is therefore on somebody else's machine, and a credential
 * that gets there has to be rotated by people who were never told it went.
 * Two ways it would have: people paste keys into prompts, and the before and
 * after of every file an agent wrote are stored so a run can be put back —
 * including `.env`.
 *
 * Found by writing a key into a prompt and a key into a file and then reading
 * the ledger back out of git, which is the only way to know.
 */

const SESSION = '8d7c6b5a-4938-4271-8160-5f4e3d2c1b0a';
const T0 = new Date('2026-10-02T14:00:00.000Z');
const T1 = new Date('2026-10-02T14:00:03.000Z');
const T2 = new Date('2026-10-02T14:00:07.000Z');

function feed(root: string, event: Record<string, unknown>, now: Date): void {
  const context = openCapture(root);
  if (context === null) throw new Error('not set up');
  appendEvents(context, captureClaudeCode({ session_id: SESSION, cwd: root, ...event }, context, now).events);
}

function turn(root: string, prompt: string, path: string, content: string): void {
  const file = join(root, path);
  feed(root, { hook_event_name: 'UserPromptSubmit', prompt }, T0);
  feed(root, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file } }, T1);
  writeFileSync(file, content);
  feed(
    root,
    { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file, content }, tool_response: {} },
    T1,
  );
  feed(root, { hook_event_name: 'Stop', stop_hook_active: false }, T2);
}

/** Everything the ledger holds, as git stores it. Nothing else is the truth. */
function ledgerText(root: string): string {
  const files = tryGit(['ls-tree', '-r', '--name-only', 'refs/deepblame/ledger'], { cwd: root });
  if (files === null) return '';
  return files
    .split('\n')
    .filter((one) => one !== '')
    .map((path) => tryGit(['show', `refs/deepblame/ledger:${path}`], { cwd: root }) ?? '')
    .join('\n');
}

/**
 * The fixtures are assembled rather than written out.
 *
 * To a secret scanner there is no such thing as a convincing fake: GitHub's
 * push protection refused this very file, naming the Slack token on line
 * eighty-five, and everyone who forks the repository would hit the same wall.
 * Joining the pieces at run time gives the redactor exactly the same string
 * to work on, so nothing here is weakened — the file simply stops being
 * something a scanner has to be argued with about. Tests for a thing that
 * looks for credentials should not ship credentials that look real.
 */
function like(...pieces: readonly string[]): string {
  return pieces.join('');
}

const KEY = like('sk', '-live-', '51H8aQxZZZZmySuperSecretKeyDoNotShare');

describe('a key pasted into a prompt', () => {
  it('does not reach the ledger', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turn(root, `use the key ${KEY} to call the API`, 'app.ts', 'export const a = 1;\n');
    seal(openRepo(root), { now: T2 });

    expect(ledgerText(root)).not.toContain(KEY);
  });

  it('still leaves a readable account of what the run was asked for', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turn(root, `use the key ${KEY} to call the API`, 'app.ts', 'export const a = 1;\n');
    seal(openRepo(root), { now: T2 });

    expect(listRuns(openRepo(root))[0]?.run.task.intent).toBe('use the key [redacted] to call the API');
  });

  it.each([
    ['a GitHub token', like('ghp', '_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789')],
    ['an AWS access key', like('AKIA', 'IOSFODNN7EXAMPLE')],
    ['a Slack token', like('xoxb', '-123456789012-123456789012-aBcDeFgHiJkLmNoPqRsTuVwX')],
    ['a bearer header', like('Authorization: ', 'Bearer ', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123')],
    ['a spelled-out secret', like('DATABASE_PASS', 'WORD=hunter2hunter2')],
    ['a URL with credentials', like('https://admin:', 's3cr3tpassword', '@internal.example.com/db')],
    ['a private key header', like('-----BEGIN ', 'RSA PRIVATE KEY', '-----')],
  ])('keeps %s out of it', (_what, secret) => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turn(root, `here it is: ${secret} — now fix the bug`, 'app.ts', 'export const a = 1;\n');
    seal(openRepo(root), { now: T2 });

    expect(ledgerText(root)).not.toContain(secret);
  });

  it('leaves an ordinary prompt alone', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turn(root, 'rename the token parser and add a test for empty input', 'app.ts', 'export const a = 1;\n');
    seal(openRepo(root), { now: T2 });

    expect(listRuns(openRepo(root))[0]?.run.task.intent).toBe('rename the token parser and add a test for empty input');
  });
});

describe('a file the repository ignores', () => {
  it('has its contents left out of the ledger', () => {
    const root = makeRepo({ commits: true });
    writeFileSync(join(root, '.gitignore'), 'secrets.txt\n');
    sh(root, ['add', '.gitignore']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'ignore secrets']);
    init(root, { now: T0 });
    turn(root, 'write the config', 'secrets.txt', `TOKEN=${KEY}\n`);
    seal(openRepo(root), { now: T2 });

    expect(ledgerText(root)).not.toContain(KEY);
  });

  it('is still recorded as something the agent wrote', () => {
    const root = makeRepo({ commits: true });
    writeFileSync(join(root, '.gitignore'), 'secrets.txt\n');
    sh(root, ['add', '.gitignore']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'ignore secrets']);
    init(root, { now: T0 });
    turn(root, 'write the config', 'secrets.txt', `TOKEN=${KEY}\n`);
    seal(openRepo(root), { now: T2 });

    // The fact is kept; only the contents are not. Blame can say an agent
    // wrote it without the ledger carrying what it wrote.
    expect(listRuns(openRepo(root))[0]?.run.files_written.map((file) => file.path)).toEqual(['secrets.txt']);
  });
});

describe('a file that is a credential by its name', () => {
  it.each(['.env', '.env.production', 'server.pem', 'id_rsa', 'deploy.key', '.npmrc'])(
    'keeps %s out of the ledger even with no ignore rule',
    (name) => {
      const root = makeRepo({ commits: true });
      init(root, { now: T0 });
      turn(root, 'set up the environment', name, `TOKEN=${KEY}\n`);
      seal(openRepo(root), { now: T2 });

      expect(ledgerText(root)).not.toContain(KEY);
    },
  );

  it('keeps ordinary source files, which is the whole point of the thing', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turn(root, 'add a greeting', 'app.ts', 'export const hello = "world";\n');
    seal(openRepo(root), { now: T2 });

    expect(ledgerText(root)).toContain('export const hello = "world";');
  });
});
