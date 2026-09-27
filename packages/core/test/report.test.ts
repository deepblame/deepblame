import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvents, captureClaudeCode, openCapture } from '../src/capture';
import { init } from '../src/commands';
import { openRepo } from '../src/repo';
import { reportRange } from '../src/report';
import { seal } from '../src/seal';
import { makeRepo, sh } from './helpers';

/**
 * What a reviewer sees before reading the diff. Only the lines the change
 * touches are counted: blaming the whole file would report work that was
 * reviewed weeks ago.
 */

const SESSION = '4d5e6f70-8192-43a4-b5c6-d7e8f9012345';
const START = new Date('2026-09-27T09:00:00.000Z');

function turn(root: string, file: string, from: string, to: string, prompt: string): void {
  const path = join(root, file);
  const stop = new Date(START.getTime() + 5000);
  const feed = (event: Record<string, unknown>, when: Date): void => {
    const context = openCapture(root);
    if (context === null) throw new Error('not set up');
    appendEvents(context, captureClaudeCode({ session_id: SESSION, cwd: root, ...event }, context, when).events);
  };
  feed({ hook_event_name: 'UserPromptSubmit', prompt }, START);
  feed({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path } }, START);
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  feed(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path, old_string: from, new_string: to },
      tool_response: {},
    },
    START,
  );
  feed({ hook_event_name: 'Stop' }, stop);
  seal(openRepo(root), { now: stop });
}

function setup(): string {
  const root = makeRepo({ commits: true });
  init(root, { now: START });
  writeFileSync(join(root, 'app.ts'), 'one\ntwo\nthree\nfour\n');
  sh(root, ['add', '-A']);
  sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'base']);
  sh(root, ['checkout', '-q', '-b', 'feature']);
  return root;
}

describe('reporting on a change', () => {
  it('counts only the lines this branch touched', () => {
    const root = setup();
    turn(root, 'app.ts', 'two', 'TWO', 'the agent changed line two');
    // A person changes a different line in the same branch.
    writeFileSync(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8').replace('four', 'FOUR'));
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'the work']);

    const result = reportRange(openRepo(root), 'main');
    expect(result.changed).toBe(2);
    expect(result.byAgents).toBe(1);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.agent).toBe('claude-code');
    expect(result.agents[0]?.lines).toBe(1);
    expect(result.agents[0]?.runs[0]?.intent).toBe('the agent changed line two');
    expect(result.files.map((file) => file.path)).toEqual(['app.ts']);
  });

  it('says nothing was changed when the branch is level with its base', () => {
    const root = setup();
    const result = reportRange(openRepo(root), 'main');
    expect(result.changed).toBe(0);
    expect(result.agents).toHaveLength(0);
  });

  it('ignores an agent line that this branch did not touch', () => {
    const root = setup();
    // The agent's work is already on main, before the branch forked.
    sh(root, ['checkout', '-q', 'main']);
    turn(root, 'app.ts', 'two', 'TWO', 'old agent work');
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'agent work on main']);
    sh(root, ['checkout', '-q', '-b', 'later']);
    writeFileSync(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8').replace('four', 'FOUR'));
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'my work']);

    const result = reportRange(openRepo(root), 'main');
    expect(result.changed).toBe(1);
    expect(result.byAgents).toBe(0);
    expect(result.agents).toHaveLength(0);
  });

  it('counts a whole new file the agent wrote', () => {
    const root = setup();
    const feed = (event: Record<string, unknown>, when: Date): void => {
      const context = openCapture(root);
      if (context === null) throw new Error('not set up');
      appendEvents(context, captureClaudeCode({ session_id: SESSION, cwd: root, ...event }, context, when).events);
    };
    const path = join(root, 'fresh.ts');
    feed({ hook_event_name: 'UserPromptSubmit', prompt: 'add the helper' }, START);
    feed({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path } }, START);
    writeFileSync(path, 'export const a = 1;\nexport const b = 2;\n');
    feed(
      { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path }, tool_response: {} },
      START,
    );
    feed({ hook_event_name: 'Stop' }, new Date(START.getTime() + 5000));
    seal(openRepo(root), { now: new Date(START.getTime() + 5000) });
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'the helper']);

    const result = reportRange(openRepo(root), 'main');
    expect(result.files.map((file) => file.path)).toEqual(['fresh.ts']);
    expect(result.changed).toBe(2);
    expect(result.byAgents).toBe(2);
  });

  it('skips a file the diff names but the worktree no longer has', () => {
    const root = setup();
    turn(root, 'app.ts', 'two', 'TWO', 'the agent');
    writeFileSync(join(root, 'extra.ts'), 'a\nb\n');
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'the work']);
    // Somebody removed it locally, so the diff still names it but it is gone.
    rmSync(join(root, 'extra.ts'));

    const result = reportRange(openRepo(root), 'main');
    expect(result.skipped).toBe(1);
    expect(result.files.map((file) => file.path)).toEqual(['app.ts']);
    expect(result.byAgents).toBe(1);
  });
});
