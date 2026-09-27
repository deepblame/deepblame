import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blameFile } from '../src/blame';
import { appendEvents, captureClaudeCode, openCapture } from '../src/capture';
import { hooks, hooksDirOf, init, recordCommit, recordTurn } from '../src/commands';
import { gitHookInstalled, installGitHook, uninstallGitHook } from '../src/hooks';
import { openRepo } from '../src/repo';
import { listRuns } from '../src/runs';
import { seal } from '../src/seal';
import { makeRepo, scratchDir, sh } from './helpers';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const SESSION = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('git fallback', () => {
  it('records a commit as a run, with the lines it changed', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: NOW });
    writeFileSync(join(root, 'app.ts'), 'export const answer = 42;\nexport const extra = 1;\n');
    sh(root, ['add', 'app.ts']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'widen the answer']);

    const report = recordCommit(root, { now: NOW });
    expect(report.recorded).toBe(true);

    const [entry] = listRuns(openRepo(root));
    expect(entry?.run.harness.name).toBe('git');
    expect(entry?.run.actor).toEqual({ type: 'human', id: 'Fixture' });
    expect(entry?.run.task.intent).toBe('widen the answer');
    expect(entry?.run.files_written.map((file) => file.path)).toEqual(['app.ts']);
    expect(entry?.run.files_written[0]?.hunks.length).toBeGreaterThan(0);
  });

  it('records the very first commit of a repository too', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: NOW });
    expect(recordCommit(root, { now: NOW }).recorded).toBe(true);
    expect(listRuns(openRepo(root))[0]?.run.files_written.map((file) => file.path)).toEqual(['app.ts']);
  });

  it('does not record the same commit twice', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: NOW });
    expect(recordCommit(root, { now: NOW }).recorded).toBe(true);
    expect(recordCommit(root, { now: NOW }).recorded).toBe(false);
    expect(listRuns(openRepo(root))).toHaveLength(1);
  });

  it('does nothing at all when DeepBlame is not set up', () => {
    const root = makeRepo({ commits: true });
    expect(recordCommit(root, { now: NOW }).recorded).toBe(false);
  });

  it('leaves an agent its lines when the commit lands afterwards', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: NOW });
    const file = join(root, 'app.ts');
    const feed = (event: Record<string, unknown>, at: Date): void => {
      const context = openCapture(root);
      if (context === null) throw new Error('not set up');
      const result = captureClaudeCode({ session_id: SESSION, cwd: root, ...event }, context, at);
      appendEvents(context, result.events);
    };

    feed({ hook_event_name: 'UserPromptSubmit', prompt: 'rename the constant' }, NOW);
    feed({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } }, NOW);
    writeFileSync(file, 'export const theAnswer = 42;\n');
    feed(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'answer', new_string: 'theAnswer' },
        tool_response: {},
      },
      NOW,
    );
    feed({ hook_event_name: 'Stop' }, NOW);
    seal(openRepo(root), { now: NOW });

    // The human then commits the agent's work; the commit must not take credit.
    sh(root, ['add', 'app.ts']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'commit the rename']);
    recordCommit(root, { now: NOW });

    const claimed = blameFile(openRepo(root), 'app.ts').spans.filter((span) => span.run !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.run?.harness.name).toBe('claude-code');
  });

  it('adds itself to a post-commit hook without disturbing what is there', () => {
    const dir = scratchDir('hooks');
    writeFileSync(join(dir, 'post-commit'), '#!/bin/sh\necho mine\n');

    const installed = installGitHook(dir, 'deepblame record-commit');
    expect(installed.changed).toBe(true);
    const body = readFileSync(join(dir, 'post-commit'), 'utf8');
    expect(body).toContain('echo mine');
    expect(body).toContain('deepblame record-commit');
    expect(gitHookInstalled(dir)).toBe(true);
    // Installing again is a no-op rather than a second copy.
    expect(installGitHook(dir, 'deepblame record-commit').changed).toBe(false);

    uninstallGitHook(dir);
    expect(readFileSync(join(dir, 'post-commit'), 'utf8')).toContain('echo mine');
    expect(gitHookInstalled(dir)).toBe(false);
  });

  it('removes the hook file entirely when it was only ever ours', () => {
    const dir = scratchDir('hooks-only-ours');
    installGitHook(dir, 'deepblame record-commit');
    uninstallGitHook(dir);
    expect(existsSync(join(dir, 'post-commit'))).toBe(false);
  });

  it('records what changed between two turns of a tool that only reports turns', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: NOW });
    // The first call only sets the baseline; nobody is blamed for history.
    expect(recordTurn(root, { agent: 'codex', mark: true, now: NOW }).recorded).toBe(false);

    writeFileSync(join(root, 'app.ts'), 'export const answer = 43;\n');
    const later = new Date('2026-09-27T12:05:00.000Z');
    const report = recordTurn(root, { agent: 'codex', intent: 'bump the answer', now: later });
    expect(report.recorded).toBe(true);
    expect(report.run?.harness.name).toBe('codex');
    expect(report.run?.task.intent).toBe('bump the answer');
    expect(report.run?.files_written.map((file) => file.path)).toEqual(['app.ts']);

    const claimed = blameFile(openRepo(root), 'app.ts').spans.filter((span) => span.run !== null);
    expect(claimed[0]?.run?.harness.name).toBe('codex');
  });

  it('records nothing for a turn that changed nothing', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: NOW });
    recordTurn(root, { agent: 'codex', mark: true, now: NOW });
    expect(recordTurn(root, { agent: 'codex', now: NOW }).recorded).toBe(false);
    expect(listRuns(openRepo(root))).toHaveLength(0);
  });

  it('writes a notify script Codex can be pointed at', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: NOW });
    const report = hooks(root, 'install', { agent: 'codex', turnCommand: 'deepblame record-turn', env: { PATH: '' } });
    const script = report.changes[0]?.file ?? '';
    expect(script.endsWith('codex-notify.sh')).toBe(true);
    const body = readFileSync(script, 'utf8');
    expect(body).toContain('--agent codex');
    expect(body).toContain(root);
    expect(hooks(root, 'status', { env: { PATH: '' } }).files.some((file) => file.installed)).toBe(true);
  });

  it('puts the hook where this repository keeps its hooks', () => {
    const root = makeRepo({ commits: true });
    expect(hooksDirOf(openRepo(root))).toBe(join(root, '.git', 'hooks'));
    sh(root, ['config', 'core.hooksPath', 'tooling/hooks']);
    expect(hooksDirOf(openRepo(root))).toBe(join(root, 'tooling', 'hooks'));
  });
});
