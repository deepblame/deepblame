import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blameFile } from '../src/blame';
import { appendEvents, captureClaudeCode, openCapture } from '../src/capture';
import { init } from '../src/commands';
import { openRepo } from '../src/repo';
import { seal } from '../src/seal';
import { makeRepo } from './helpers';

const SESSION = '5f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const START = new Date('2026-09-27T09:00:00.000Z');
const DURING = new Date('2026-09-27T09:00:05.000Z');
const STOP = new Date('2026-09-27T09:00:10.000Z');

function feed(root: string, event: Record<string, unknown>, now: Date): void {
  const context = openCapture(root);
  if (context === null) throw new Error('not set up');
  const result = captureClaudeCode({ session_id: SESSION, cwd: root, ...event }, context, now);
  appendEvents(context, result.events);
}

/** An agent turn that replaces one piece of text in a file. */
function agentEdit(root: string, file: string, from: string, to: string, prompt = 'make it better'): void {
  const path = join(root, file);
  feed(root, { hook_event_name: 'UserPromptSubmit', prompt }, START);
  feed(root, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path } }, DURING);
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  feed(
    root,
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path, old_string: from, new_string: to },
      tool_response: {},
    },
    DURING,
  );
  feed(root, { hook_event_name: 'Stop' }, STOP);
}

function setup(): { root: string; file: string } {
  const root = makeRepo({ commits: true });
  init(root, { now: START });
  const file = 'app.ts';
  writeFileSync(join(root, file), 'one\ntwo\nthree\nfour\n');
  return { root, file };
}

describe('blame', () => {
  it('claims the line an agent wrote and nothing else', () => {
    const { root, file } = setup();
    agentEdit(root, file, 'three', 'THREE');
    seal(openRepo(root), { now: STOP });

    const result = blameFile(openRepo(root), file);
    expect(result.lines).toBe(4);
    expect(result.runs).toBe(1);
    const claimed = result.spans.filter((span) => span.run !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.from).toBe(3);
    expect(claimed[0]?.to).toBe(3);
    expect(claimed[0]?.reason).toBe('exact');
    expect(claimed[0]?.confidence).toBe(1);
    expect(result.agentShare).toBeCloseTo(0.25, 5);
  });

  it('keeps the claim when the file changes somewhere else', () => {
    const { root, file } = setup();
    agentEdit(root, file, 'three', 'THREE');
    seal(openRepo(root), { now: STOP });
    // A human appends to the end of the file afterwards.
    writeFileSync(join(root, file), `${readFileSync(join(root, file), 'utf8')}five\nsix\n`);

    const claimed = blameFile(openRepo(root), file).spans.filter((span) => span.run !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.from).toBe(3);
    expect(claimed[0]?.reason).toBe('survived');
    expect(claimed[0]?.confidence).toBe(0.9);
  });

  it('follows the line when earlier lines are added or removed', () => {
    const { root, file } = setup();
    agentEdit(root, file, 'three', 'THREE');
    seal(openRepo(root), { now: STOP });
    writeFileSync(join(root, file), `zero\nhalf\n${readFileSync(join(root, file), 'utf8')}`);

    const claimed = blameFile(openRepo(root), file).spans.filter((span) => span.run !== null);
    expect(claimed[0]?.from).toBe(5);
    expect(claimed[0]?.to).toBe(5);
  });

  it('gives the line up once someone writes over it', () => {
    const { root, file } = setup();
    agentEdit(root, file, 'three', 'THREE');
    seal(openRepo(root), { now: STOP });
    writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8').replace('THREE', 'mine now'));

    const result = blameFile(openRepo(root), file);
    expect(result.spans.filter((span) => span.run !== null)).toHaveLength(0);
    expect(result.agentShare).toBe(0);
    // The run is still on record as having written here; it just owns nothing now.
    expect(result.runs).toBe(1);
  });

  it('gives a line to the last agent that wrote it', () => {
    const { root, file } = setup();
    agentEdit(root, file, 'three', 'THREE');
    seal(openRepo(root), { now: STOP });
    const later = new Date('2026-09-27T10:00:00.000Z');
    feed(root, { hook_event_name: 'UserPromptSubmit', prompt: 'second pass' }, later);
    feed(root, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, file) } }, later);
    writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8').replace('THREE', 'THIRD'));
    feed(
      root,
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: join(root, file), old_string: 'THREE', new_string: 'THIRD' },
        tool_response: {},
      },
      later,
    );
    feed(root, { hook_event_name: 'Stop' }, later);
    seal(openRepo(root), { now: later });

    const claimed = blameFile(openRepo(root), file).spans.filter((span) => span.run !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.run?.task.intent).toBe('second pass');
  });

  it('says plainly when no agent has been near the file', () => {
    const { root, file } = setup();
    const result = blameFile(openRepo(root), file);
    expect(result.runs).toBe(0);
    expect(result.agentShare).toBe(0);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.reason).toBe('unknown');
  });
});
