import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvents, captureClaudeCode, init, openCapture, openRepo, seal } from '@deepblame/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { activate } from '../src/extension';
import { FakeEditor, stub } from './fake-editor';
import { makeRepo, sh } from '../../core/test/helpers';

/**
 * The extension driven end to end: a real repository, a real ledger written by
 * a real captured turn, and a stand-in editor recording what it was told to
 * draw. Everything here is checkable outside VS Code. What is not — how the
 * mark looks in a given theme, where the hover box lands — is left to the
 * person who installs it.
 */

const SESSION = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
const START = new Date('2026-09-27T09:00:00.000Z');

/** An agent turn that rewrites one line, recorded the way the hooks record it. */
function agentTurn(root: string, file: string, from: string, to: string, prompt: string): void {
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

function repoWithOneAgentLine(): string {
  const root = makeRepo({ commits: true });
  init(root, { now: START });
  writeFileSync(join(root, 'app.ts'), 'one\ntwo\nthree\nfour\n');
  sh(root, ['add', '-A']);
  sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'base']);
  agentTurn(root, 'app.ts', 'two', 'TWO', 'change the second line');
  return root;
}

/** Starts the extension and waits out its debounce. */
async function start(root: string, editor: FakeEditor | null): Promise<void> {
  stub.reset();
  stub.folder = root;
  stub.editor = editor;
  activate({ subscriptions: [] } as never);
  await settle();
}

function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 600));
}

/** The left-edge marks and the end-of-line label, in that order of creation. */
const BAND = 0;
const LABEL = 1;

beforeEach(() => {
  stub.reset();
});

describe('what the extension draws', () => {
  it('marks the line the agent wrote and leaves the rest alone', async () => {
    const root = repoWithOneAgentLine();
    await start(root, new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8')));

    // Line 2 of the file, which is index 1.
    expect(stub.decorations[BAND]?.drawn.map((one) => one.range.slice(0, 3))).toEqual([[1, 0, 1]]);
  });

  it('puts the label on the cursor\'s line, and nowhere else', async () => {
    const root = repoWithOneAgentLine();
    const editor = new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8'), 1);
    await start(root, editor);

    expect(stub.decorations[LABEL]?.drawn[0]?.contentText).toBe('Claude Code · change the second line');

    // Move off that line and the label goes with the cursor.
    editor.at(3);
    stub.fire('selection', { textEditor: editor });
    expect(stub.decorations[LABEL]?.drawn).toEqual([]);
  });

  it('says in the status bar how much of the file is not the person\'s', async () => {
    const root = repoWithOneAgentLine();
    await start(root, new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8')));

    expect(stub.statusBar.visible).toBe(true);
    expect(stub.statusBar.text).toContain('25% agent-written');
    expect(stub.statusBar.tooltip).toContain('1 line of 4 lines written by an agent');
  });

  it('draws nothing for a file no agent has touched', async () => {
    const root = repoWithOneAgentLine();
    writeFileSync(join(root, 'mine.ts'), 'a\nb\n');
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'mine']);
    await start(root, new FakeEditor(join(root, 'mine.ts'), 'a\nb\n'));

    expect(stub.decorations[BAND]?.drawn).toEqual([]);
    expect(stub.statusBar.visible).toBe(false);
  });

  it('stays quiet in a repository where DeepBlame was never set up', async () => {
    const bare = makeRepo({ commits: true });
    writeFileSync(join(bare, 'app.ts'), 'one\n');
    sh(bare, ['add', '-A']);
    sh(bare, ['commit', '-q', '--no-gpg-sign', '-m', 'base']);
    await start(bare, new FakeEditor(join(bare, 'app.ts'), 'one\n'));

    expect(stub.decorations[BAND]?.drawn).toEqual([]);
    expect(stub.shown).toEqual([]);
  });

  it('does not carry one file\'s marks over to the next one opened', async () => {
    const root = repoWithOneAgentLine();
    const editor = new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8'));
    await start(root, editor);
    expect(stub.decorations[BAND]?.drawn).toHaveLength(1);

    stub.editor = new FakeEditor(join(root, 'other.ts'), 'x\ny\n');
    stub.fire('activeEditor', stub.editor);
    // Cleared at once, before the ledger is asked again.
    expect(stub.decorations[BAND]?.drawn).toEqual([]);
  });

  it('moves the marks as the person types, without asking the ledger again', async () => {
    const root = repoWithOneAgentLine();
    const editor = new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8'));
    await start(root, editor);
    expect(stub.decorations[BAND]?.drawn[0]?.range[0]).toBe(1);

    // Two lines typed in at the top push the agent's line down.
    editor.text = `zero\nhalf\n${editor.text}`;
    stub.fire('change', {
      document: editor.document,
      contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'zero\nhalf\none' }],
    });
    expect(stub.decorations[BAND]?.drawn[0]?.range[0]).toBe(3);
  });

  it('lets go of a line the person edits by hand, rather than keep claiming it', async () => {
    const root = repoWithOneAgentLine();
    const editor = new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8'));
    await start(root, editor);

    stub.fire('change', {
      document: editor.document,
      contentChanges: [{ range: { start: { line: 1 }, end: { line: 1 } }, text: 'mine now' }],
    });
    expect(stub.decorations[BAND]?.drawn).toEqual([]);
  });
});

describe('the hover', () => {
  it('answers on an agent line with who, why and how sure', async () => {
    const root = repoWithOneAgentLine();
    const editor = new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8'));
    await start(root, editor);

    const provider = stub.hovers[0]?.provider;
    const answer = provider?.provideHover(editor.document, { line: 1 }) as { contents: { value: string; isTrusted: unknown } };
    expect(answer.contents.value).toContain('**Claude Code**');
    expect(answer.contents.value).toContain('change the second line');
    expect(answer.contents.value).toContain('100% sure');
    // Only the two links may run, and nothing else.
    expect(answer.contents.isTrusted).toEqual({ enabledCommands: ['deepblame.undoRun', 'deepblame.showRun'] });
  });

  it('says nothing at all on a line nobody recorded', async () => {
    const root = repoWithOneAgentLine();
    const editor = new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8'));
    await start(root, editor);

    expect(stub.hovers[0]?.provider.provideHover(editor.document, { line: 3 })).toBeNull();
  });
});

describe('undoing a run from the editor', () => {
  it('asks first, and writes only when the person says so', async () => {
    const root = repoWithOneAgentLine();
    const editor = new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8'));
    await start(root, editor);
    const runId = runIdOf(root);

    // The person closes the dialog.
    stub.answers = [undefined];
    await stub.commands.get('deepblame.undoRun')?.(runId);
    expect(stub.asked[0]?.message).toBe('Undo what Claude Code did in 1 file?');
    expect(stub.asked[0]?.detail).toContain('app.ts');
    expect(readFileSync(join(root, 'app.ts'), 'utf8')).toContain('TWO');

    // And now they mean it.
    stub.answers = ['Undo it'];
    await stub.commands.get('deepblame.undoRun')?.(runId);
    expect(readFileSync(join(root, 'app.ts'), 'utf8')).toBe('one\ntwo\nthree\nfour\n');
    expect(stub.shown.at(-1)).toBe('Put 1 file back.');
  });

  it('says so plainly when the run is not in the ledger', async () => {
    const root = repoWithOneAgentLine();
    await start(root, new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8')));

    await stub.commands.get('deepblame.undoRun')?.('99999999-9999-4999-8999-999999999999');
    expect(stub.shown.at(-1)).toContain('no longer in the ledger');
  });

  it('opens the whole run when asked for the detail', async () => {
    const root = repoWithOneAgentLine();
    await start(root, new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8')));

    stub.commands.get('deepblame.showRun')?.(runIdOf(root));
    const opened = stub.opened[0];
    expect(opened?.language).toBe('json');
    expect(JSON.parse(opened?.content ?? '{}').task.intent).toBe('change the second line');
  });
});

describe('turning it off', () => {
  it('clears everything and remembers the choice', async () => {
    const root = repoWithOneAgentLine();
    await start(root, new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8')));
    expect(stub.decorations[BAND]?.drawn).toHaveLength(1);

    await stub.commands.get('deepblame.toggle')?.();
    expect(stub.decorations[BAND]?.drawn).toEqual([]);
    expect(stub.statusBar.visible).toBe(false);
    expect(stub.settings.get('deepblame.enabled')).toBe(false);

    await stub.commands.get('deepblame.toggle')?.();
    expect(stub.decorations[BAND]?.drawn).toHaveLength(1);
  });

  it('draws nothing when the setting starts off', async () => {
    const root = repoWithOneAgentLine();
    stub.reset();
    stub.settings.set('deepblame.enabled', false);
    stub.folder = root;
    stub.editor = new FakeEditor(join(root, 'app.ts'), readFileSync(join(root, 'app.ts'), 'utf8'));
    activate({ subscriptions: [] } as never);
    await settle();

    expect(stub.decorations[BAND]?.drawn).toEqual([]);
  });
});

/** The one run in this repository's ledger. */
function runIdOf(root: string): string {
  const listing = sh(root, ['ls-tree', '-r', '--name-only', 'refs/deepblame/ledger', '--', 'runs']);
  const first = listing.split('\n')[0] ?? '';
  return first.replace('runs/', '').replace('.json', '');
}
