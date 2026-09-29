import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTrace } from '@deepblame/protocol';
import { describe, expect, it } from 'vitest';
import { recordFromRun, runFromRecord } from '../src/agenttrace';
import { blameFile } from '../src/blame';
import { appendEvents, captureClaudeCode, openCapture } from '../src/capture';
import { init, traceExport, traceImport } from '../src/commands';
import { openRepo } from '../src/repo';
import { planRevert } from '../src/revert';
import { listRuns } from '../src/runs';
import { seal } from '../src/seal';
import { makeRepo, scratchDir, sh } from './helpers';

/**
 * Speaking the format the rest of the industry agreed on.
 *
 * The point of these is not that our JSON looks right to us — it is that it
 * validates against the schema Cursor published, and that a record written by
 * somebody else's tool turns into an answer `blame` can give. The schema is
 * checked from a copy of the real one, so a change to the spec shows up here
 * rather than in a stranger's parser.
 */

const SESSION = '3c4d5e6f-7a8b-49c0-b1d2-e3f4a5b6c7d8';

/** The same hash the exporter writes, so a test can pose as another tool. */
function sha256Of(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
const START = new Date('2026-09-28T09:00:00.000Z');

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
  return root;
}

/**
 * The published schema, as a check rather than as a description. Written out
 * by hand from https://agent-trace.dev/schemas/v1/trace-record.json so the
 * suite does not depend on the network, and deliberately strict: the spec sets
 * `additionalProperties: false` at every level, so a field we invent is a
 * record other tools will refuse.
 */
function validate(record: unknown, path = 'record'): string[] {
  const bad: string[] = [];
  const obj = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

  const root = obj(record);
  if (root === null) return [`${path}: not an object`];

  const allowed = ['version', 'id', 'timestamp', 'vcs', 'tool', 'files', 'metadata'];
  for (const key of Object.keys(root)) if (!allowed.includes(key)) bad.push(`${path}.${key}: not in the schema`);
  for (const key of ['version', 'id', 'timestamp', 'files']) {
    if (root[key] === undefined) bad.push(`${path}.${key}: required`);
  }
  if (typeof root['version'] === 'string' && !/^[0-9]+\.[0-9]+$/.test(root['version'])) {
    bad.push(`${path}.version: must match ^[0-9]+\\.[0-9]+$, got ${String(root['version'])}`);
  }
  if (typeof root['id'] !== 'string') bad.push(`${path}.id: must be a string`);
  if (typeof root['timestamp'] !== 'string' || Number.isNaN(Date.parse(root['timestamp'] as string))) {
    bad.push(`${path}.timestamp: must be an RFC 3339 date-time`);
  }

  const vcs = root['vcs'] === undefined ? null : obj(root['vcs']);
  if (root['vcs'] !== undefined) {
    if (vcs === null) bad.push(`${path}.vcs: must be an object`);
    else {
      for (const key of Object.keys(vcs)) if (!['type', 'revision'].includes(key)) bad.push(`${path}.vcs.${key}: not in the schema`);
      if (!['git', 'jj', 'hg', 'svn'].includes(String(vcs['type']))) bad.push(`${path}.vcs.type: not one of git|jj|hg|svn`);
      if (typeof vcs['revision'] !== 'string') bad.push(`${path}.vcs.revision: required`);
    }
  }

  const tool = root['tool'] === undefined ? null : obj(root['tool']);
  if (root['tool'] !== undefined) {
    if (tool === null) bad.push(`${path}.tool: must be an object`);
    else {
      for (const key of Object.keys(tool)) if (!['name', 'version'].includes(key)) bad.push(`${path}.tool.${key}: not in the schema`);
      // Both are required when the object is present — a name with no version
      // is the easy mistake and it makes the record invalid.
      if (typeof tool['name'] !== 'string') bad.push(`${path}.tool.name: required`);
      if (typeof tool['version'] !== 'string') bad.push(`${path}.tool.version: required`);
    }
  }

  const checkContributor = (value: unknown, where: string): void => {
    const one = obj(value);
    if (one === null) return void bad.push(`${where}: must be an object`);
    for (const key of Object.keys(one)) if (!['type', 'model_id'].includes(key)) bad.push(`${where}.${key}: not in the schema`);
    if (!['human', 'ai', 'mixed', 'unknown'].includes(String(one['type']))) bad.push(`${where}.type: not one of human|ai|mixed|unknown`);
    if (one['model_id'] !== undefined && (typeof one['model_id'] !== 'string' || (one['model_id'] as string).length > 250)) {
      bad.push(`${where}.model_id: must be a string of at most 250 characters`);
    }
  };

  if (!Array.isArray(root['files'])) return [...bad, `${path}.files: must be an array`];
  root['files'].forEach((raw, index) => {
    const file = obj(raw);
    const where = `${path}.files[${index}]`;
    if (file === null) return void bad.push(`${where}: must be an object`);
    for (const key of Object.keys(file)) if (!['path', 'conversations'].includes(key)) bad.push(`${where}.${key}: not in the schema`);
    if (typeof file['path'] !== 'string') bad.push(`${where}.path: required`);
    if (!Array.isArray(file['conversations'])) return void bad.push(`${where}.conversations: required array`);
    file['conversations'].forEach((rawTalk, talkIndex) => {
      const talk = obj(rawTalk);
      const at = `${where}.conversations[${talkIndex}]`;
      if (talk === null) return void bad.push(`${at}: must be an object`);
      for (const key of Object.keys(talk)) {
        if (!['url', 'contributor', 'ranges', 'related'].includes(key)) bad.push(`${at}.${key}: not in the schema`);
      }
      if (talk['contributor'] !== undefined) checkContributor(talk['contributor'], `${at}.contributor`);
      if (!Array.isArray(talk['ranges'])) return void bad.push(`${at}.ranges: required array`);
      talk['ranges'].forEach((rawRange, rangeIndex) => {
        const one = obj(rawRange);
        const spot = `${at}.ranges[${rangeIndex}]`;
        if (one === null) return void bad.push(`${spot}: must be an object`);
        for (const key of Object.keys(one)) {
          if (!['start_line', 'end_line', 'content_hash', 'contributor'].includes(key)) bad.push(`${spot}.${key}: not in the schema`);
        }
        for (const key of ['start_line', 'end_line']) {
          const value = one[key];
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
            bad.push(`${spot}.${key}: must be an integer of at least 1, got ${String(value)}`);
          }
        }
        if (one['contributor'] !== undefined) checkContributor(one['contributor'], `${spot}.contributor`);
      });
    });
  });
  return bad;
}

describe('writing the standard', () => {
  it('produces a record the published schema accepts', () => {
    const root = setup();
    turn(root, 'app.ts', 'two', 'TWO', 'shout at the second line');

    const report = traceExport(root, { now: START });
    expect(report.records).toHaveLength(1);
    expect(validate(report.records[0])).toEqual([]);
  });

  it('writes a two-part version, because the schema pattern refuses three', () => {
    const root = setup();
    turn(root, 'app.ts', 'two', 'TWO', 'a turn');
    // The example in the spec says 0.1.0, which its own pattern rejects.
    expect(traceExport(root, { now: START }).records[0]?.version).toBe('0.1');
  });

  it('names the tool, the revision and the model', () => {
    const root = setup();
    turn(root, 'app.ts', 'two', 'TWO', 'a turn');
    const record = traceExport(root, { now: START }).records[0];

    expect(record?.tool?.name).toBe('claude-code');
    // Required alongside the name: a record with one and not the other is invalid.
    expect(typeof record?.tool?.version).toBe('string');
    expect(record?.vcs).toEqual({ type: 'git', revision: sh(root, ['rev-parse', 'HEAD']) });
    const who = record?.files[0]?.conversations[0]?.contributor;
    expect(who?.type).toBe('ai');
  });

  it('gives the lines the agent wrote, and a hash of what is on them', () => {
    const root = setup();
    turn(root, 'app.ts', 'two', 'TWO', 'a turn');
    const range = traceExport(root, { now: START }).records[0]?.files[0]?.conversations[0]?.ranges[0];

    expect(range?.start_line).toBe(2);
    expect(range?.end_line).toBe(2);
    // Position-independent tracking is what the field is for, so it has to be
    // a hash of the attributed text and not of the whole file.
    expect(range?.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps our own extras in our own corner of metadata', () => {
    const root = setup();
    turn(root, 'app.ts', 'two', 'TWO', 'shout at the second line');
    const record = traceExport(root, { now: START }).records[0];
    const mine = record?.metadata?.['dev.deepblame'] as Record<string, unknown> | undefined;

    expect(mine?.['intent']).toBe('shout at the second line');
    expect(validate(record)).toEqual([]);
  });

  it('writes one file per record when asked to write', () => {
    const root = setup();
    turn(root, 'app.ts', 'two', 'TWO', 'a turn');
    const out = scratchDir('traces');
    const report = traceExport(root, { now: START, write: true, out });

    expect(report.written).toHaveLength(1);
    const onDisk: unknown = JSON.parse(readFileSync(report.written[0] as string, 'utf8'));
    expect(validate(onDisk)).toEqual([]);
  });

  it('says there is nothing to export rather than writing an empty record', () => {
    const root = setup();
    expect(traceExport(root, { now: START }).records).toEqual([]);
  });
});

describe('reading the standard', () => {
  /** A record as another tool would hand it to us. */
  function foreign(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: '0.1.0',
      id: 'cursor-conversation-12345',
      timestamp: '2026-09-28T08:00:00Z',
      vcs: { type: 'git', revision: sh(root, ['rev-parse', 'HEAD']) },
      tool: { name: 'cursor', version: '2.4.0' },
      files: [
        {
          path: 'app.ts',
          conversations: [
            {
              url: 'https://api.cursor.com/v1/conversations/12345',
              contributor: { type: 'ai', model_id: 'anthropic/claude-opus-4-5-20251101' },
              ranges: [{ start_line: 3, end_line: 3 }],
            },
          ],
        },
      ],
      ...overrides,
    };
  }

  it('accepts the three-part version the spec\'s own example uses', () => {
    const root = setup();
    expect(parseTrace(foreign(root))).toHaveProperty('record');
  });

  it('turns another tool\'s record into something blame can answer with', () => {
    const root = setup();
    const file = join(scratchDir('incoming'), 'cursor.json');
    writeFileSync(file, JSON.stringify(foreign(root)));

    const report = traceImport(root, [file], { now: START });
    expect(report.imported).toBe(1);
    expect(report.tools).toEqual(['cursor']);

    const span = blameFile(openRepo(root), 'app.ts').spans.find((one) => one.from <= 3 && one.to >= 3);
    expect(span?.run?.actor.id).toBe('cursor');
    expect(span?.run?.model?.name).toBe('claude-opus-4-5-20251101');
  });

  it('marks it as reported, never as something we watched', () => {
    const root = setup();
    const file = join(scratchDir('incoming'), 'cursor.json');
    writeFileSync(file, JSON.stringify(foreign(root)));
    traceImport(root, [file], { now: START });

    const span = blameFile(openRepo(root), 'app.ts').spans.find((one) => one.from <= 3 && one.to >= 3);
    expect(span?.reason).toBe('reported');
    // Below anything we saw happen, above nothing.
    expect(span?.confidence).toBe(0.8);
    expect(span?.run?.harness.name).toBe('external');
  });

  it('lets a run we watched take a line back off a reported one', () => {
    const root = setup();
    const file = join(scratchDir('incoming'), 'cursor.json');
    writeFileSync(file, JSON.stringify(foreign(root)));
    traceImport(root, [file], { now: START });
    // We then watch our own agent rewrite that very line.
    turn(root, 'app.ts', 'three', 'THREE', 'our own agent');

    const span = blameFile(openRepo(root), 'app.ts').spans.find((one) => one.from <= 3 && one.to >= 3);
    expect(span?.run?.harness.name).toBe('claude-code');
    expect(span?.reason).not.toBe('reported');
  });

  it('refuses to revert reported lines, because a trace has no before-image', () => {
    const root = setup();
    const file = join(scratchDir('incoming'), 'cursor.json');
    writeFileSync(file, JSON.stringify(foreign(root)));
    traceImport(root, [file], { now: START });

    const plan = planRevert(openRepo(root), { agent: 'external' });
    expect(plan.files.every((one) => one.write === null)).toBe(true);
    expect(plan.files[0]?.status).toBe('unverifiable');
    // And nothing is ever proposed for deletion just because the before is unknown.
    expect(plan.files.some((one) => one.write?.kind === 'delete')).toBe(false);
  });

  it('follows a reported line through a later edit, like any other', () => {
    const root = setup();
    const file = join(scratchDir('incoming'), 'cursor.json');
    writeFileSync(file, JSON.stringify(foreign(root)));
    traceImport(root, [file], { now: START });
    // Two lines added above push the reported line from 3 to 5.
    writeFileSync(join(root, 'app.ts'), `zero\nhalf\n${readFileSync(join(root, 'app.ts'), 'utf8')}`);

    const span = blameFile(openRepo(root), 'app.ts').spans.find((one) => one.from <= 5 && one.to >= 5);
    expect(span?.run?.actor.id).toBe('cursor');
  });

  it('drops a claim it cannot tie to any state of this repository, and says so', () => {
    const root = setup();
    const file = join(scratchDir('incoming'), 'elsewhere.json');
    // A revision we have never seen and no content hash: nothing to check the
    // claim against, so there is no honest way to answer for those lines.
    writeFileSync(file, JSON.stringify(foreign(root, { vcs: { type: 'git', revision: 'f'.repeat(40) } })));

    const report = traceImport(root, [file], { now: START });
    expect(report.imported).toBe(0);
    expect(report.unresolved).toBe(1);
    expect(report.rejected.join(' ')).toContain('matches a state of this repository');
  });

  it('takes in a claim from another clone by the hash the spec puts there', () => {
    const root = setup();
    const file = join(scratchDir('incoming'), 'otherclone.json');
    // Unknown revision, but the range says what text it covers — and that text
    // is line 3 of our file.
    const hashed = foreign(root, {
      vcs: { type: 'git', revision: 'f'.repeat(40) },
      files: [
        {
          path: 'app.ts',
          conversations: [
            {
              contributor: { type: 'ai', model_id: 'anthropic/claude-opus-4-5' },
              ranges: [{ start_line: 3, end_line: 3, content_hash: sha256Of('three') }],
            },
          ],
        },
      ],
    });
    writeFileSync(file, JSON.stringify(hashed));

    const report = traceImport(root, [file], { now: START });
    expect(report.imported).toBe(1);
    expect(report.unresolved).toBe(0);
    expect(blameFile(openRepo(root), 'app.ts').spans.find((one) => one.from <= 3 && one.to >= 3)?.reason).toBe('reported');
  });

  it('refuses a hash that does not match what is actually on the line', () => {
    const root = setup();
    const file = join(scratchDir('incoming'), 'mismatch.json');
    const wrong = foreign(root, {
      vcs: { type: 'git', revision: 'f'.repeat(40) },
      files: [
        {
          path: 'app.ts',
          conversations: [{ ranges: [{ start_line: 3, end_line: 3, content_hash: sha256Of('something else') }] }],
        },
      ],
    });
    writeFileSync(file, JSON.stringify(wrong));

    expect(traceImport(root, [file], { now: START }).imported).toBe(0);
  });

  it('reads a file holding a list of records', () => {
    const root = setup();
    const file = join(scratchDir('incoming'), 'many.json');
    writeFileSync(file, JSON.stringify([foreign(root), foreign(root, { id: 'second' })]));
    expect(traceImport(root, [file], { now: START }).imported).toBe(2);
  });

  it('reads every record in a directory', () => {
    const root = setup();
    const dir = scratchDir('incoming');
    writeFileSync(join(dir, 'a.json'), JSON.stringify(foreign(root)));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(foreign(root, { id: 'second' })));
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    expect(traceImport(root, [dir], { now: START }).imported).toBe(2);
  });

  it('does not take the same record in twice', () => {
    const root = setup();
    const file = join(scratchDir('incoming'), 'cursor.json');
    writeFileSync(file, JSON.stringify(foreign(root)));
    traceImport(root, [file], { now: START });
    expect(traceImport(root, [file], { now: START }).imported).toBe(0);
    expect(listRuns(openRepo(root)).filter((one) => one.run.harness.name === 'external')).toHaveLength(1);
  });

  it('says what it could not read instead of failing silently', () => {
    const root = setup();
    const dir = scratchDir('incoming');
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'wrong.json'), JSON.stringify({ version: '0.1', id: 'x' }));

    const report = traceImport(root, [dir], { now: START });
    expect(report.imported).toBe(0);
    expect(report.rejected).toHaveLength(2);
    expect(report.rejected.join(' ')).toContain('not JSON');
  });

  it('does not export what it imported, so a trace cannot echo around a team', () => {
    const root = setup();
    const file = join(scratchDir('incoming'), 'cursor.json');
    writeFileSync(file, JSON.stringify(foreign(root)));
    traceImport(root, [file], { now: START });
    turn(root, 'app.ts', 'two', 'TWO', 'ours');

    const records = traceExport(root, { now: START }).records;
    expect(records).toHaveLength(1);
    expect(records[0]?.tool?.name).toBe('claude-code');
  });
});

describe('a round trip', () => {
  it('survives being written out and read back by us', () => {
    const mine = setup();
    turn(mine, 'app.ts', 'two', 'TWO', 'shout at the second line');
    const record = traceExport(mine, { now: START }).records[0];
    expect(record).toBeDefined();

    // Another repository with the same history, as a colleague's would be.
    const theirs = makeRepo({ commits: true });
    init(theirs, { now: START });
    writeFileSync(join(theirs, 'app.ts'), readFileSync(join(mine, 'app.ts'), 'utf8'));
    sh(theirs, ['add', '-A']);
    sh(theirs, ['commit', '-q', '--no-gpg-sign', '-m', 'same content']);

    const file = join(scratchDir('shared'), 'ours.json');
    writeFileSync(file, JSON.stringify(record));
    const report = traceImport(theirs, [file], { now: START });

    expect(report.imported).toBe(1);
    expect(report.tools).toEqual(['claude-code']);
  });

  it('keeps the model and the intent across the trip', () => {
    const root = setup();
    turn(root, 'app.ts', 'two', 'TWO', 'shout at the second line');
    const record = traceExport(root, { now: START }).records[0];
    if (record === undefined) throw new Error('no record');

    const back = runFromRecord(openRepo(root), record);
    expect(back?.run?.task.intent).toBe('shout at the second line');
    expect(back?.tool).toBe('claude-code');
  });

  it('gives a record with no usable id a stable one of its own', () => {
    const root = setup();
    turn(root, 'app.ts', 'two', 'TWO', 'a turn');
    const entry = listRuns(openRepo(root))[0];
    if (entry === undefined) throw new Error('no run');
    const record = recordFromRun(openRepo(root), entry.run);
    if (record === null) throw new Error('no record');

    const once = runFromRecord(openRepo(root), { ...record, id: 'not-a-uuid' })?.run?.run_id;
    const twice = runFromRecord(openRepo(root), { ...record, id: 'not-a-uuid' })?.run?.run_id;
    expect(once).toBe(twice);
    expect(once).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
