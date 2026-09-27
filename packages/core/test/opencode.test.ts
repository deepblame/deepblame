import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvents, captureEvent, openCapture } from '../src/capture';
import { hooks, init } from '../src/commands';
import { blameFile } from '../src/blame';
import { OPENCODE_PLUGIN, OPENCODE_PLUGIN_DIR, openCodePluginInstalled } from '../src/hooks';
import { openRepo } from '../src/repo';
import { applyRevert, planRevert } from '../src/revert';
import { listRuns } from '../src/runs';
import { seal } from '../src/seal';
import { makeRepo, sh } from './helpers';

/**
 * OpenCode reports more than any other harness we support: the prompt, every
 * tool call before and after it runs, and the assistant message's own token
 * count and price. These tests drive the plain JSON shape the plugin sends,
 * which is the same door any other tool can come through.
 */

const SESSION = 'ses_7xK2mQpL9';
const START = new Date('2026-09-27T09:00:00.000Z');

function say(root: string, event: Record<string, unknown>, now = START): void {
  const context = openCapture(root);
  if (context === null) throw new Error('not set up');
  const result = captureEvent({ agent: 'opencode', session: SESSION, cwd: root, ...event }, context, now);
  appendEvents(context, result.events);
}

function setup(contents = 'alpha\nbeta\ngamma\n'): { root: string; file: string } {
  const root = makeRepo({ commits: true });
  init(root, { now: START });
  const file = 'src.ts';
  writeFileSync(join(root, file), contents);
  sh(root, ['add', file]);
  sh(root, ['commit', '-q', '--no-gpg-sign', '-m', 'base']);
  return { root, file };
}

/** One OpenCode turn, exactly the sequence the plugin sends. */
function turn(root: string, file: string, from: string, to: string): void {
  const path = join(root, file);
  say(root, { kind: 'prompt', text: 'rename beta to BETA' });
  say(root, { kind: 'write-pre', path });
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  say(root, { kind: 'tool', tool: 'edit', args: { filePath: path, oldString: from, newString: to }, ok: true });
  say(root, { kind: 'write', path, tool: 'edit', old: from, new: to });
  say(root, {
    kind: 'usage',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    input: 4210,
    output: 318,
    cache_read: 18_000,
    cache_write: 900,
    usd: 0.0412,
  });
  say(root, { kind: 'end', reason: 'session.idle' }, new Date(START.getTime() + 8000));
  seal(openRepo(root), { now: new Date(START.getTime() + 8000) });
}

describe('recording OpenCode', () => {
  it('turns one turn into one run, with the prompt and the tool call', () => {
    const { root, file } = setup();
    turn(root, file, 'beta', 'BETA');

    const runs = listRuns(openRepo(root));
    expect(runs).toHaveLength(1);
    const run = runs[0]?.run;
    expect(run?.harness.name).toBe('opencode');
    expect(run?.task.intent).toBe('rename beta to BETA');
    expect(run?.tool_calls.map((call) => call.name)).toEqual(['edit']);
    expect(run?.files_written.map((written) => written.path)).toEqual([file]);
  });

  it('takes the price from OpenCode rather than a rate table of ours', () => {
    const { root, file } = setup();
    turn(root, file, 'beta', 'BETA');

    const run = listRuns(openRepo(root))[0]?.run;
    expect(run?.model).toEqual({ provider: 'anthropic', name: 'claude-sonnet-4-20250514', version: null });
    expect(run?.cost?.usd).toBeCloseTo(0.0412, 6);
    expect(run?.cost?.source).toBe('harness');
    expect(run?.cost?.input_tokens).toBe(4210);
    expect(run?.cost?.output_tokens).toBe(318);
    expect(run?.cost?.cache_read_tokens).toBe(18_000);
    expect(run?.cost?.cache_write_tokens).toBe(900);
  });

  it('blames the line it wrote, and nothing else', () => {
    const { root, file } = setup();
    turn(root, file, 'beta', 'BETA');

    const result = blameFile(openRepo(root), file);
    const claimed = result.spans.filter((span) => span.run !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.from).toBe(2);
    expect(claimed[0]?.run?.harness.name).toBe('opencode');
  });

  it('can be reverted without losing what a person wrote afterwards', () => {
    const { root, file } = setup();
    turn(root, file, 'beta', 'BETA');
    writeFileSync(join(root, file), `${readFileSync(join(root, file), 'utf8')}mine\n`);

    const repo = openRepo(root);
    applyRevert(repo, planRevert(repo, { agent: 'opencode' }));
    expect(readFileSync(join(root, file), 'utf8')).toBe('alpha\nbeta\ngamma\nmine\n');
  });

  it('records a read, and ignores a kind it does not know', () => {
    const { root, file } = setup();
    say(root, { kind: 'prompt', text: 'have a look' });
    say(root, { kind: 'read', path: join(root, file) });
    say(root, { kind: 'daydream', about: 'electric sheep' });
    say(root, { kind: 'end' }, new Date(START.getTime() + 1000));
    seal(openRepo(root), { now: new Date(START.getTime() + 1000) });

    const run = listRuns(openRepo(root))[0]?.run;
    expect(run?.files_read.map((read) => read.path)).toEqual([file]);
    expect(run?.tool_calls).toHaveLength(0);
  });

  it('ignores an event with no agent, no session or a harness we have no name for', () => {
    const { root } = setup();
    const context = openCapture(root);
    if (context === null) throw new Error('not set up');
    expect(captureEvent({ kind: 'prompt', text: 'hi', session: SESSION }, context, START).events).toHaveLength(0);
    expect(captureEvent({ kind: 'prompt', text: 'hi', agent: 'opencode' }, context, START).events).toHaveLength(0);
    expect(
      captureEvent({ kind: 'prompt', text: 'hi', agent: 'some-new-tool', session: SESSION }, context, START).events,
    ).toHaveLength(0);
  });

  it('closes the turn on end and only then', () => {
    const { root } = setup();
    const context = openCapture(root);
    if (context === null) throw new Error('not set up');
    expect(captureEvent({ agent: 'opencode', session: SESSION, kind: 'prompt', text: 'x' }, context, START).seal).toBe(false);
    expect(captureEvent({ agent: 'opencode', session: SESSION, kind: 'end' }, context, START).seal).toBe(true);
  });

  it('keeps a path outside the repository out of the ledger', () => {
    const { root } = setup();
    const context = openCapture(root);
    if (context === null) throw new Error('not set up');
    const outside = captureEvent(
      { agent: 'opencode', session: SESSION, kind: 'write-pre', path: '/etc/hosts' },
      context,
      START,
    );
    expect(outside.events).toHaveLength(0);
  });
});

describe('the OpenCode plugin file', () => {
  it('is installed, detected and removed again', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: START });
    const file = join(root, OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN);
    expect(openCodePluginInstalled(root)).toBe(false);

    const installed = hooks(root, 'install', { agent: 'opencode', hookCommand: 'deepblame-capture' });
    expect(installed.changes[0]?.changed).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(openCodePluginInstalled(root)).toBe(true);

    // Installing again changes nothing.
    expect(hooks(root, 'install', { agent: 'opencode', hookCommand: 'deepblame-capture' }).changes[0]?.changed).toBe(false);

    hooks(root, 'uninstall', {});
    expect(existsSync(file)).toBe(false);
  });

  it('leaves a plugin file somebody else wrote alone', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: START });
    const file = join(root, OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN);
    hooks(root, 'install', { agent: 'opencode', hookCommand: 'deepblame-capture' });
    writeFileSync(file, 'export const NotOurs = async () => ({});\n');
    hooks(root, 'uninstall', {});
    expect(readFileSync(file, 'utf8')).toBe('export const NotOurs = async () => ({});\n');
  });

  it('writes valid JavaScript that hands events to the command we chose', () => {
    const root = makeRepo({ commits: true });
    init(root, { now: START });
    hooks(root, 'install', { agent: 'opencode', hookCommand: '/usr/local/bin/deepblame-capture' });
    const source = readFileSync(join(root, OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN), 'utf8');

    expect(source).toContain('"/usr/local/bin/deepblame-capture"');
    expect(source).toContain('"--agent","opencode"');
    // The hooks it registers are the ones OpenCode's own types define.
    for (const hook of ['chat.message', 'tool.execute.before', 'tool.execute.after', 'event']) {
      expect(source).toContain(hook);
    }
    expect(source).toContain('session.idle');
    expect(source.startsWith('// DeepBlame')).toBe(true);
    // Parsed by node as a module, so a typo can never reach somebody's editor.
    expect(() =>
      execFileSync(process.execPath, ['--input-type=module', '--check'], { input: source, stdio: 'pipe' }),
    ).not.toThrow();
  });
});
