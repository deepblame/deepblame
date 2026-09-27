import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blameFile } from '../src/blame';
import { appendEvents, captureClaudeCode, openCapture } from '../src/capture';
import { init, recordCommit } from '../src/commands';
import { aliasesOf, currentNameOf, readRenames } from '../src/rename';
import { openRepo } from '../src/repo';
import { applyRevert, planRevert } from '../src/revert';
import { seal } from '../src/seal';
import { makeRepo, sh } from './helpers';

/**
 * The scenarios that break line-level provenance in real repositories:
 * somebody renames the file, a formatter rewrites every line's indentation,
 * and a branch gets merged. None of these change who wrote the code.
 */

const SESSION = '7a1b2c3d-4e5f-4061-8273-849506a7b8c9';
const START = new Date('2026-09-27T09:00:00.000Z');

function feed(root: string, event: Record<string, unknown>, now: Date): void {
  const context = openCapture(root);
  if (context === null) throw new Error('not set up');
  const result = captureClaudeCode({ session_id: SESSION, cwd: root, ...event }, context, now);
  appendEvents(context, result.events);
}

function turn(root: string, file: string, from: string, to: string, prompt = 'improve it'): void {
  const path = join(root, file);
  const stop = new Date(START.getTime() + 10_000);
  feed(root, { hook_event_name: 'UserPromptSubmit', prompt }, START);
  feed(root, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path } }, START);
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  feed(
    root,
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path, old_string: from, new_string: to },
      tool_response: {},
    },
    START,
  );
  feed(root, { hook_event_name: 'Stop' }, stop);
  seal(openRepo(root), { now: stop });
}

const SOURCE = ['function go() {', '  const a = 1;', '  const b = 2;', '  return a + b;', '}', ''].join('\n');

function setup(): { root: string; file: string } {
  const root = makeRepo({ commits: true });
  init(root, { now: START });
  const file = 'go.js';
  writeFileSync(join(root, file), SOURCE);
  sh(root, ['add', file]);
  sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'base']);
  return { root, file };
}

describe('renames', () => {
  it('reads the chain of names a file has had', () => {
    const root = makeRepo({ commits: true });
    writeFileSync(join(root, 'one.txt'), 'hello\n');
    sh(root, ['add', 'one.txt']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'one']);
    sh(root, ['mv', 'one.txt', 'two.txt']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'renamed once']);
    sh(root, ['mv', 'two.txt', 'three.txt']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'renamed twice']);

    const renames = readRenames(openRepo(root));
    expect(aliasesOf(renames, 'three.txt')).toEqual(['three.txt', 'two.txt', 'one.txt']);
    expect(currentNameOf(renames, 'one.txt')).toBe('three.txt');
    expect(currentNameOf(renames, 'never-moved.txt')).toBe('never-moved.txt');
  });

  it('sees a rename that is staged but not committed', () => {
    const root = makeRepo({ commits: true });
    sh(root, ['mv', 'app.ts', 'main.ts']);
    const renames = readRenames(openRepo(root));
    expect(currentNameOf(renames, 'app.ts')).toBe('main.ts');
  });

  it('still knows who wrote the lines after the file is renamed', () => {
    const { root, file } = setup();
    turn(root, file, 'const b = 2;', 'const b = 22;', 'bump b');
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'agent work']);
    sh(root, ['mv', file, 'src-go.js']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'move it']);

    const result = blameFile(openRepo(root), 'src-go.js');
    expect(result.renamedFrom).toEqual([file]);
    const claimed = result.spans.filter((span) => span.run !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.run?.task.intent).toBe('bump b');
    expect(claimed[0]?.from).toBe(3);
  });

  it('reverts into the file under its new name', () => {
    const { root, file } = setup();
    turn(root, file, 'const b = 2;', 'const b = 22;', 'bump b');
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'agent work']);
    sh(root, ['mv', file, 'moved.js']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'move it']);

    const repo = openRepo(root);
    const plan = planRevert(repo, { agent: 'claude-code' });
    expect(plan.files[0]?.path).toBe('moved.js');
    expect(plan.files[0]?.recordedAs).toBe(file);
    expect(plan.files[0]?.status).toBe('clean');

    applyRevert(repo, plan);
    expect(readFileSync(join(root, 'moved.js'), 'utf8')).toBe(SOURCE);
  });
});

describe('a formatter going through the file', () => {
  it('keeps the line, at a lower confidence, when only the spacing changed', () => {
    const { root, file } = setup();
    turn(root, file, 'const b = 2;', 'const b = 22;', 'bump b');

    // Prettier reindents everything from two spaces to four.
    const reindented = readFileSync(join(root, file), 'utf8').replace(/^ {2}/gm, '    ');
    writeFileSync(join(root, file), reindented);

    const claimed = blameFile(openRepo(root), file).spans.filter((span) => span.run !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.from).toBe(3);
    expect(claimed[0]?.reason).toBe('reformatted');
    expect(claimed[0]?.confidence).toBe(0.7);
  });

  it('still gives the line up when the code itself changed', () => {
    const { root, file } = setup();
    turn(root, file, 'const b = 2;', 'const b = 22;', 'bump b');
    writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8').replace('const b = 22;', 'const b = 99;'));

    const claimed = blameFile(openRepo(root), file).spans.filter((span) => span.run !== null);
    expect(claimed).toHaveLength(0);
  });
});

describe('merges', () => {
  it('records no authorship for a merge commit, because a merge writes nothing', () => {
    const { root, file } = setup();
    sh(root, ['checkout', '-q', '-b', 'side']);
    writeFileSync(join(root, 'side.js'), 'export const side = true;\n');
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'side work']);
    sh(root, ['checkout', '-q', 'main']);
    writeFileSync(join(root, file), `${SOURCE}// main moved on\n`);
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'main work']);
    sh(root, ['merge', '-q', '--no-ff', '--no-gpg-sign', '-m', 'merge side', 'side']);

    // The merge itself introduced no lines, so it produces no run at all.
    const recorded = recordCommit(root, { now: START });
    expect(recorded.run).toBeNull();
  });

  it('keeps an agent line through a merge that touched the same file', () => {
    const { root, file } = setup();
    turn(root, file, 'const b = 2;', 'const b = 22;', 'bump b');
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'agent work']);

    sh(root, ['checkout', '-q', '-b', 'side']);
    writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8').replace('function go() {', 'export function go() {'));
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'export it']);
    sh(root, ['checkout', '-q', 'main']);
    writeFileSync(join(root, file), `${readFileSync(join(root, file), 'utf8')}// tail\n`);
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'tail']);
    sh(root, ['merge', '-q', '--no-ff', '--no-gpg-sign', '-m', 'merge side', 'side']);

    const claimed = blameFile(openRepo(root), file).spans.filter((span) => span.run?.harness.name === 'claude-code');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.run?.task.intent).toBe('bump b');
  });
});
