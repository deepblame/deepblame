import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUEUE_FILE, QUEUE_SEALING_FILE, QUEUE_TAKING_FILE, STATE_DIR } from '@deepblame/protocol';
import { describe, expect, it } from 'vitest';
import { appendEvents, captureClaudeCode, openCapture } from '../src/capture';
import { init } from '../src/commands';
import { openRepo } from '../src/repo';
import { listRuns } from '../src/runs';
import { seal } from '../src/seal';
import { makeRepo } from './helpers';

/**
 * How the queue changes hands.
 *
 * The sealer used to read the queue, spend a while writing to the ledger, and
 * write back what it had not used. Capture's appends are atomic against each
 * other but not against a whole-file rewrite, so an event that landed in
 * between was overwritten and gone. One turn in a couple of hundred lost a
 * line; when the lost line was the stop hook the turn never closed, and it sat
 * in the queue for ever while `log` showed nothing. Three hundred turns in a
 * row was what it took to notice.
 *
 * Now the sealer renames the queue aside and reads the file it owns, so it
 * never writes to the file capture appends to. These check the parts of that
 * which a race cannot be relied on to show.
 */

const SESSION = '5c4b3a2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';
const T0 = new Date('2026-10-02T12:00:00.000Z');
const T1 = new Date('2026-10-02T12:00:03.000Z');
const T2 = new Date('2026-10-02T12:00:06.000Z');

function feed(root: string, event: Record<string, unknown>, now: Date, session = SESSION): void {
  const context = openCapture(root);
  if (context === null) throw new Error('not set up');
  const result = captureClaudeCode({ session_id: session, cwd: root, ...event }, context, now);
  appendEvents(context, result.events);
}

/** A turn, with the stop hook only if asked for. */
function turn(root: string, prompt: string, value: number, { finish = true, session = SESSION, at = T1 } = {}): void {
  const file = join(root, 'app.ts');
  feed(root, { hook_event_name: 'UserPromptSubmit', prompt }, T0, session);
  feed(root, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } }, at, session);
  writeFileSync(file, `export const answer = ${value};\n`);
  feed(
    root,
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: file, old_string: '42', new_string: String(value) },
      tool_response: { filePath: file },
    },
    at,
    session,
  );
  if (finish) feed(root, { hook_event_name: 'Stop', stop_hook_active: false }, T2, session);
}

function state(root: string, name: string): string {
  const file = join(root, STATE_DIR, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

describe('the sealer never writes to the file capture appends to', () => {
  it('leaves the live queue alone, holding what it cannot seal in its own file', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turn(root, 'half a turn', 1, { finish: false });

    const result = seal(openRepo(root), { now: T2 });
    expect(result.sealed).toBe(0);
    expect(result.pending).toBeGreaterThan(0);
    // The unfinished turn is owed, and it is not in the file an agent appends to.
    expect(state(root, QUEUE_SEALING_FILE)).not.toBe('');
    expect(state(root, QUEUE_FILE)).toBe('');
  });

  it('keeps an event that arrives while a seal is in flight', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turn(root, 'first turn', 1);

    // What a concurrent capture does: the queue has been renamed away, so this
    // append creates a fresh one. The old code read the queue, wrote the ledger,
    // then wrote the queue back from what it had read — and this line vanished.
    const stateDir = join(root, STATE_DIR);
    const smuggled = `{"v":1,"k":"prompt","ts":"${T1.toISOString()}","agent":"claude-code","session":"${SESSION}","text":"arrived mid-seal","sha256":"x"}\n`;
    seal(openRepo(root), { now: T2 });
    appendFileSync(join(stateDir, QUEUE_FILE), smuggled);

    const again = seal(openRepo(root), { now: T2 });
    expect(again.pending + again.events).toBeGreaterThan(0);
    const everywhere = [QUEUE_FILE, QUEUE_TAKING_FILE, QUEUE_SEALING_FILE].map((name) => state(root, name)).join('');
    expect(everywhere).toContain('arrived mid-seal');
  });

  it('picks up what a sealer that died had already taken', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turn(root, 'a turn a dead sealer took', 7);
    // Exactly what is left behind by a process killed between taking the queue
    // and committing: the events are in the sealer's file, the queue is empty.
    const stateDir = join(root, STATE_DIR);
    const taken = readFileSync(join(stateDir, QUEUE_FILE), 'utf8');
    writeFileSync(join(stateDir, QUEUE_TAKING_FILE), taken);
    writeFileSync(join(stateDir, QUEUE_FILE), '');

    const result = seal(openRepo(root), { now: T2 });
    expect(result.sealed).toBe(1);
    expect(listRuns(openRepo(root))[0]?.run.task.intent).toBe('a turn a dead sealer took');
    expect(existsSync(join(stateDir, QUEUE_TAKING_FILE))).toBe(false);
  });

  it('counts events waiting in the sealer’s file as waiting', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turn(root, 'half a turn', 1, { finish: false });
    seal(openRepo(root), { now: T2 });

    // status asks this question, and a turn parked in the sealer's file is
    // still a turn that has not landed.
    const again = seal(openRepo(root), { now: T2 });
    expect(again.pending).toBeGreaterThan(0);
  });
});

describe('a turn whose end never came', () => {
  it('waits, while the agent might still be working', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turn(root, 'still going', 1, { finish: false });

    expect(seal(openRepo(root), { now: new Date(T2.getTime() + 60_000) }).sealed).toBe(0);
  });

  it('is sealed once the session has been silent long enough', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    turn(root, 'killed mid-turn', 1, { finish: false });

    // Ctrl-C, a closed laptop, a crashed editor: the stop hook never runs, and
    // the next prompt that would have closed the turn never comes either.
    const later = new Date(T2.getTime() + 31 * 60_000);
    const result = seal(openRepo(root), { now: later });
    expect(result.sealed).toBe(1);
    const [entry] = listRuns(openRepo(root));
    expect(entry?.run.task.intent).toBe('killed mid-turn');
    // Recorded as having ended when it went quiet, not when we gave up on it.
    expect(entry?.run.ended_at).toBe(T1.toISOString());
  });

  it('does not cut a long turn in two while its tools are still firing', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: T0 });
    // A model that thinks for twenty minutes between tool calls.
    const late = new Date(T1.getTime() + 20 * 60_000);
    turn(root, 'a long turn', 1, { at: late });

    const result = seal(openRepo(root), { now: new Date(late.getTime() + 31 * 60_000) });
    expect(result.sealed).toBe(1);
    expect(listRuns(openRepo(root))).toHaveLength(1);
  });
});
