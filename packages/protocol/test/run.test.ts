import { describe, expect, it } from 'vitest';
import { CLI_NAME, LEDGER_REF, STATE_DIR, parseRun, type Run } from '../src';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const HASH = 'c'.repeat(64);

function makeRun(overrides: Partial<Run> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    session_id: '16fd2706-8baf-433b-82eb-8c7fada847da',
    parent_run_id: null,
    harness: { name: 'claude-code', version: '2.3.1' },
    model: { provider: 'anthropic', name: 'claude-opus-5', version: null },
    actor: { type: 'agent', id: 'agent-c' },
    task: { prompt_sha256: HASH, intent: 'fix token expiry' },
    started_at: '2026-09-21T20:00:00.000Z',
    ended_at: '2026-09-21T20:04:10.000Z',
    tool_calls: [{ name: 'edit', args_sha256: HASH, result_sha256: null, ts: '2026-09-21T20:01:00.000Z', ok: true }],
    files_read: [{ path: 'src/auth/token.ts', blob_sha: OID_A }],
    files_written: [
      {
        path: 'src/auth/session.ts',
        pre_blob_sha: OID_A,
        post_blob_sha: OID_B,
        hunks: [{ old_start: 12, old_len: 2, new_start: 12, new_len: 5 }],
      },
    ],
    cost: { input_tokens: 18_000, output_tokens: 2_400, usd: 0.41 },
    env: { branch: 'main', head_commit: OID_A, worktree_id: 'wt-1', host_id: 'host-1' },
    ...overrides,
  };
}

function issuesOf(input: unknown): string[] {
  const result = parseRun(input);
  return result.ok ? [] : result.issues;
}

describe('run schema', () => {
  it('accepts a complete run', () => {
    const result = parseRun(makeRun());
    expect(result.ok).toBe(true);
  });

  it('accepts a run from the git fallback, which knows no model or prompt', () => {
    const result = parseRun(
      makeRun({
        harness: { name: 'git', version: null },
        model: null,
        task: { prompt_sha256: null },
        tool_calls: [],
        files_read: [],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses schema versions it does not understand', () => {
    expect(issuesOf({ ...makeRun(), schema_version: 2 })).toEqual([expect.stringMatching(/^schema_version:/)]);
  });

  it('refuses unknown fields instead of silently dropping them', () => {
    expect(issuesOf({ ...makeRun(), secret_field: true }).join('\n')).toMatch(/secret_field/);
  });

  it('refuses a run that ends before it starts', () => {
    expect(issuesOf(makeRun({ ended_at: '2026-09-21T19:00:00.000Z' }))).toEqual([
      'ended_at: ended_at is earlier than started_at',
    ]);
  });

  it('refuses a run that is its own parent', () => {
    const run = makeRun();
    expect(issuesOf({ ...run, parent_run_id: run.run_id })).toEqual(['parent_run_id: a run cannot be its own parent']);
  });

  it('refuses a file write with neither a pre nor a post blob', () => {
    const write = { path: 'a.ts', pre_blob_sha: null, post_blob_sha: null, hunks: [] };
    expect(issuesOf(makeRun({ files_written: [write] })).join('\n')).toMatch(/files_written\.0\.post_blob_sha/);
  });

  it('accepts git sha256 object ids', () => {
    const run = makeRun({ env: { branch: null, head_commit: 'd'.repeat(64), worktree_id: 'wt', host_id: 'h' } });
    expect(parseRun(run).ok).toBe(true);
  });

  it('rejects non-uuid ids and uppercase hashes', () => {
    const issues = issuesOf({ ...makeRun(), run_id: 'run-1', task: { prompt_sha256: HASH.toUpperCase() } });
    expect(issues.join('\n')).toMatch(/run_id/);
    expect(issues.join('\n')).toMatch(/task\.prompt_sha256/);
  });
});

describe('names', () => {
  it('derives every path from the one product name', () => {
    expect(LEDGER_REF).toBe(`refs/${CLI_NAME}/ledger`);
    expect(STATE_DIR).toBe(`.${CLI_NAME}`);
  });
});
