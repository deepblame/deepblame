import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEDGER_REF } from '@deepblame/protocol';
import { describe, expect, it } from 'vitest';
import { appendEvents, captureClaudeCode, openCapture } from '../src/capture';
import { init } from '../src/commands';
import { openRepo } from '../src/repo';
import { listRuns } from '../src/runs';
import { seal } from '../src/seal';
import { pullLedger, pushLedger } from '../src/share';
import { makeRepo, scratchDir, sh } from './helpers';

/**
 * Two people, two laptops, one repository. Each records what its own agents
 * did; the point of sharing is that either of them can then answer for the
 * whole team.
 */

const START = new Date('2026-09-27T09:00:00.000Z');

function turn(root: string, file: string, from: string, to: string, prompt: string, at: Date, session: string): void {
  const path = join(root, file);
  const stop = new Date(at.getTime() + 5000);
  const feed = (event: Record<string, unknown>, when: Date): void => {
    const context = openCapture(root);
    if (context === null) throw new Error('not set up');
    appendEvents(context, captureClaudeCode({ session_id: session, cwd: root, ...event }, context, when).events);
  };
  feed({ hook_event_name: 'UserPromptSubmit', prompt }, at);
  feed({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path } }, at);
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  feed(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path, old_string: from, new_string: to },
      tool_response: {},
    },
    at,
  );
  feed({ hook_event_name: 'Stop' }, stop);
  seal(openRepo(root), { now: stop });
}

/** A bare repository standing in for the team's remote, and two clones. */
function team(): { hub: string; alice: string; bob: string } {
  const hub = scratchDir('hub');
  sh(hub, ['init', '-q', '--bare', '-b', 'main']);

  const seed = makeRepo({ commits: true });
  writeFileSync(join(seed, 'app.ts'), 'one\ntwo\nthree\nfour\n');
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-q', '--no-gpg-sign', '-m', 'base']);
  sh(seed, ['remote', 'add', 'origin', hub]);
  sh(seed, ['push', '-q', 'origin', 'main']);

  const clone = (name: string): string => {
    const dir = scratchDir(name);
    sh(dir, ['clone', '-q', hub, '.']);
    init(dir, { now: START });
    return dir;
  };
  return { hub, alice: clone('alice'), bob: clone('bob') };
}

describe('sharing the ledger', () => {
  it('sends one machine\'s runs to the team and brings them back on another', () => {
    const { alice, bob } = team();
    turn(alice, 'app.ts', 'two', 'TWO', 'alice asked for two', START, '11111111-1111-4111-8111-111111111111');

    pushLedger(openRepo(alice), 'origin');
    const pulled = pullLedger(openRepo(bob), 'origin');

    expect(pulled.gained).toBe(1);
    expect(listRuns(openRepo(bob)).map((entry) => entry.run.task.intent)).toEqual(['alice asked for two']);
  });

  it('joins two ledgers that both moved on', () => {
    const { alice, bob } = team();
    turn(alice, 'app.ts', 'two', 'TWO', 'alice', START, '11111111-1111-4111-8111-111111111111');
    turn(bob, 'app.ts', 'three', 'THREE', 'bob', START, '22222222-2222-4222-8222-222222222222');

    pushLedger(openRepo(alice), 'origin');
    const joined = pullLedger(openRepo(bob), 'origin');

    expect(joined.gained).toBe(1);
    expect(joined.ahead).toBe(1);
    expect(joined.disputed).toEqual([]);
    // Bob now holds both, and the merge kept two parents.
    const intents = listRuns(openRepo(bob)).map((entry) => entry.run.task.intent).sort();
    expect(intents).toEqual(['alice', 'bob']);
    expect(sh(bob, ['rev-list', '--count', '--merges', LEDGER_REF])).toBe('1');

    // And when bob pushes, alice gets the whole picture too.
    pushLedger(openRepo(bob), 'origin');
    pullLedger(openRepo(alice), 'origin');
    expect(listRuns(openRepo(alice)).map((entry) => entry.run.task.intent).sort()).toEqual(['alice', 'bob']);
  });

  it('says there is nothing to do when both are in step', () => {
    const { alice, bob } = team();
    turn(alice, 'app.ts', 'two', 'TWO', 'alice', START, '11111111-1111-4111-8111-111111111111');
    pushLedger(openRepo(alice), 'origin');
    pullLedger(openRepo(bob), 'origin');

    const again = pullLedger(openRepo(bob), 'origin');
    expect(again.unchanged).toBe(true);
    expect(again.gained).toBe(0);
  });

  it('reports what it has that the team does not', () => {
    const { alice, bob } = team();
    turn(alice, 'app.ts', 'two', 'TWO', 'alice', START, '11111111-1111-4111-8111-111111111111');
    pushLedger(openRepo(alice), 'origin');
    pullLedger(openRepo(bob), 'origin');
    turn(bob, 'app.ts', 'four', 'FOUR', 'bob later', new Date(START.getTime() + 3_600_000), '22222222-2222-4222-8222-222222222222');

    const state = pullLedger(openRepo(bob), 'origin');
    expect(state.gained).toBe(0);
    expect(state.ahead).toBe(1);
  });

  it('takes the whole ledger when this machine has none', () => {
    const { alice, bob } = team();
    turn(alice, 'app.ts', 'two', 'TWO', 'alice', START, '11111111-1111-4111-8111-111111111111');
    pushLedger(openRepo(alice), 'origin');

    // Bob deletes his ledger and starts again from the team's.
    sh(bob, ['update-ref', '-d', LEDGER_REF]);
    const pulled = pullLedger(openRepo(bob), 'origin');
    expect(pulled.gained).toBe(1);
    expect(listRuns(openRepo(bob))).toHaveLength(1);
  });

  it('does nothing when the remote has no ledger yet', () => {
    const { bob } = team();
    const first = pullLedger(openRepo(bob), 'origin');
    expect(first.unchanged).toBe(true);
    expect(first.gained).toBe(0);
  });

  it('shares the stored contents, so the other machine can blame and revert', async () => {
    const { alice, bob } = team();
    turn(alice, 'app.ts', 'two', 'TWO', 'alice', START, '11111111-1111-4111-8111-111111111111');
    pushLedger(openRepo(alice), 'origin');
    pullLedger(openRepo(bob), 'origin');

    // Bob's worktree gets the same content alice left.
    writeFileSync(join(bob, 'app.ts'), readFileSync(join(alice, 'app.ts'), 'utf8'));
    const { blameFile } = await import('../src/blame');
    const claimed = blameFile(openRepo(bob), 'app.ts').spans.filter((span) => span.run !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.run?.task.intent).toBe('alice');

    const { planRevert } = await import('../src/revert');
    expect(planRevert(openRepo(bob), { agent: 'claude-code' }).files[0]?.status).toBe('clean');
  });
});

describe('the ledger\'s own birthday', () => {
  it('keeps the earlier one and does not call it a conflict', () => {
    const { alice, bob } = team();
    turn(alice, 'app.ts', 'two', 'TWO', 'alice', START, '11111111-1111-4111-8111-111111111111');
    pushLedger(openRepo(alice), 'origin');

    const joined = pullLedger(openRepo(bob), 'origin');
    // Two people each ran init. That is not a tampered ledger.
    expect(joined.disputed).toEqual([]);

    const born = JSON.parse(sh(bob, ['show', `${LEDGER_REF}:meta.json`])).created_at;
    const hers = JSON.parse(sh(alice, ['show', `${LEDGER_REF}:meta.json`])).created_at;
    expect(Date.parse(born)).toBeLessThanOrEqual(Date.parse(hers));
  });
});
