import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEDGER_IDENTITY, LEDGER_REF, LedgerMetaSchema, STATE_DIR } from '@deepblame/protocol';
import { NotARepositoryError, init, status } from '../src';
import { makeRepo, scratchDir, sh } from './helpers';

const NOW = new Date('2026-09-21T20:00:00.000Z');
/** Keeps the host machine's binaries out of harness detection. */
const NO_PATH = { PATH: '' };

describe('init', () => {
  it('creates the ledger in a repository with no commits and touches nothing else', () => {
    const repo = makeRepo();
    const result = init(repo, { now: NOW, env: NO_PATH });

    expect(result.ledger.created).toBe(true);
    expect(sh(repo, ['rev-parse', LEDGER_REF])).toBe(result.ledger.head);
    expect(sh(repo, ['status', '--porcelain'])).toBe('');
    expect(() => sh(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).toThrow();
  });

  it('leaves HEAD, the branch and the index alone in a repository with history', () => {
    const repo = makeRepo({ commits: true });
    const before = [sh(repo, ['rev-parse', 'HEAD']), sh(repo, ['branch', '--show-current']), sh(repo, ['ls-files', '-s'])];

    init(repo, { now: NOW, env: NO_PATH });

    const after = [sh(repo, ['rev-parse', 'HEAD']), sh(repo, ['branch', '--show-current']), sh(repo, ['ls-files', '-s'])];
    expect(after).toEqual(before);
    expect(sh(repo, ['status', '--porcelain'])).toBe('');
  });

  it('is idempotent', () => {
    const repo = makeRepo();
    const first = init(repo, { now: NOW, env: NO_PATH });
    const second = init(repo, { now: new Date('2026-09-22T09:00:00.000Z'), env: NO_PATH });

    expect(second.ledger).toEqual({ head: first.ledger.head, created: false });
    expect(second.stateDir.created).toBe(false);
    expect(sh(repo, ['rev-list', '--count', LEDGER_REF])).toBe('1');
  });

  it('needs no git identity and never signs with the user key', () => {
    const repo = makeRepo();
    // If signing were attempted, gpg.program=false would make it fail.
    sh(repo, ['config', 'commit.gpgsign', 'true']);
    sh(repo, ['config', 'gpg.program', 'false']);

    init(repo, { now: NOW, env: NO_PATH });

    expect(sh(repo, ['log', '-1', '--format=%an <%ae>', LEDGER_REF])).toBe(
      `${LEDGER_IDENTITY.name} <${LEDGER_IDENTITY.email}>`,
    );
    expect(sh(repo, ['cat-file', 'commit', LEDGER_REF])).not.toContain('gpgsig');
  });

  it('writes a genesis commit whose meta.json matches the schema', () => {
    const repo = makeRepo();
    init(repo, { now: NOW, env: NO_PATH });

    const meta = LedgerMetaSchema.parse(JSON.parse(sh(repo, ['cat-file', 'blob', `${LEDGER_REF}:meta.json`])));
    expect(meta.created_at).toBe(NOW.toISOString());
    expect(sh(repo, ['ls-tree', '--name-only', LEDGER_REF])).toBe('meta.json');
  });

  it('works in sha256 repositories', () => {
    const repo = makeRepo({ objectFormat: 'sha256', commits: true });
    const result = init(repo, { now: NOW, env: NO_PATH });

    expect(result.repo.objectFormat).toBe('sha256');
    expect(result.ledger.head).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails with a clear error outside a repository', () => {
    expect(() => init(scratchDir('plain'), { env: NO_PATH })).toThrow(NotARepositoryError);
  });
});

describe('state directory', () => {
  it('ignores itself, so it can never be committed', () => {
    const repo = makeRepo();
    init(repo, { now: NOW, env: NO_PATH });

    expect(existsSync(join(repo, STATE_DIR, '.gitignore'))).toBe(true);
    sh(repo, ['add', '-A']);
    expect(sh(repo, ['status', '--porcelain'])).toBe('');
    expect(() => sh(repo, ['check-ignore', '-q', `${STATE_DIR}/config.json`])).not.toThrow();
  });

  it('keeps an edited config, and comes back after being deleted', () => {
    const repo = makeRepo();
    init(repo, { now: NOW, env: NO_PATH });
    const config = join(repo, STATE_DIR, 'config.json');
    writeFileSync(config, '{"edited":true}\n');

    init(repo, { now: NOW, env: NO_PATH });
    expect(readFileSync(config, 'utf8')).toBe('{"edited":true}\n');

    rmSync(join(repo, STATE_DIR), { recursive: true });
    const again = init(repo, { now: NOW, env: NO_PATH });
    expect(again.stateDir.created).toBe(true);
    expect(again.ledger.created).toBe(false);
  });
});

describe('agent detection', () => {
  it('finds agents by project markers and by binaries on PATH', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.claude'));
    const bin = scratchDir('bin');
    writeFileSync(join(bin, 'opencode'), '#!/bin/sh\n');
    chmodSync(join(bin, 'opencode'), 0o755);
    writeFileSync(join(bin, 'codex'), 'not executable');

    const found = Object.fromEntries(
      init(repo, { now: NOW, env: { PATH: bin } }).harnesses.map((h) => [h.id, h.signals]),
    );

    expect(found).toEqual({
      opencode: ['opencode on PATH'],
      'claude-code': ['.claude/'],
      codex: [],
      cursor: [],
    });
  });
});

describe('status', () => {
  it('reports a repository that is not set up yet', () => {
    const report = status(makeRepo(), { env: NO_PATH });
    expect(report.initialized).toBe(false);
    expect(report.ledger.head).toBeNull();
  });

  it('reports the ledger after init', () => {
    const repo = makeRepo();
    init(repo, { now: NOW, env: NO_PATH });
    const report = status(repo, { env: NO_PATH });

    expect(report).toMatchObject({
      initialized: true,
      recording: false,
      ledger: { runs: 0, createdAt: NOW.toISOString() },
      stateDir: { exists: true, queued: 0 },
    });
    expect(report.ledger.genesis).toBe(report.ledger.head);
  });

  it('shares one ledger across worktrees, with state kept per worktree', () => {
    const repo = makeRepo({ commits: true });
    const { ledger } = init(repo, { now: NOW, env: NO_PATH });
    const worktree = join(scratchDir('wt-parent'), 'feature');
    sh(repo, ['worktree', 'add', '-q', '-b', 'feature', worktree]);

    const before = status(worktree, { env: NO_PATH });
    expect(before.ledger.head).toBe(ledger.head);
    expect(before.stateDir.exists).toBe(false);

    const setUp = init(worktree, { now: NOW, env: NO_PATH });
    expect(setUp.ledger.created).toBe(false);
    expect(setUp.stateDir.created).toBe(true);
    expect(status(worktree, { env: NO_PATH }).repo.branch).toBe('feature');
  });
});
