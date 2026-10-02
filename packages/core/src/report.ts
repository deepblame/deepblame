import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '@deepblame/protocol';
import { blameFile } from './blame';
import { parseDiff } from './diffmap';
import { tryGit } from './git';
import type { Repo } from './repo';

/**
 * What a reviewer wants to know before reading a diff: how much of this was
 * written by an agent, which one, and what it was asked to do.
 *
 * Only the lines this change actually touches are counted. Blaming the whole
 * file would tell you about work that was reviewed weeks ago and say nothing
 * about the change in front of you.
 */

/**
 * A ref the report was asked to compare against, which this repository does
 * not have. Its own class because the CLI has to say so plainly: this runs in
 * CI, where the base is a variable somebody else fills in, and a shrug reads
 * as "no agent wrote any of this".
 */
export class NoSuchRefError extends Error {
  override name = 'NoSuchRefError';
  constructor(readonly ref: string) {
    super(`no such commit in this repository: ${ref}`);
  }
}

export interface AgentShare {
  agent: string;
  lines: number;
  /** Turns behind those lines, newest first, capped for readability. */
  runs: { id: string; intent: string | null; model: string | null; usd: number | null }[];
}

export interface FileShare {
  path: string;
  /** Lines this change added or altered. */
  changed: number;
  /** Of those, how many an agent is known to have written. */
  byAgents: number;
}

export interface ReportResult {
  base: string;
  head: string;
  files: FileShare[];
  agents: AgentShare[];
  /** Lines this change touches, across every file. */
  changed: number;
  /** Of those, how many a recorded agent wrote. */
  byAgents: number;
  /** Files in the diff that no longer exist, so nothing can be said. */
  skipped: number;
}

/** Turns behind any one agent's lines; more than this is noise in a comment. */
const MAX_RUNS = 5;

export function reportRange(repo: Repo, base: string, head = 'HEAD'): ReportResult {
  const cwd = repo.root;
  const empty: ReportResult = { base, head, files: [], agents: [], changed: 0, byAgents: 0, skipped: 0 };
  // A ref that does not resolve used to come out as "no lines changed", which
  // in a pull request comment reads as "no agent wrote any of this". This runs
  // in CI, where the base is a variable somebody else fills in, so the one
  // thing it must not do is answer confidently about a comparison it never
  // made.
  for (const ref of [base, head]) {
    if (tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd }) === null) {
      throw new NoSuchRefError(ref);
    }
  }
  // Two dots, not three: what this branch changed relative to where it forked.
  const merge = tryGit(['merge-base', base, head], { cwd }) ?? base;
  const names = tryGit(['diff', '--name-only', '--diff-filter=ACMR', `${merge}..${head}`], { cwd });
  if (names === null || names === '') return empty;

  const result: ReportResult = { ...empty, files: [], agents: [] };
  const byAgent = new Map<string, { lines: number; runs: Map<string, Run> }>();

  for (const path of names.split('\n').filter((line) => line !== '')) {
    if (!existsSync(join(cwd, path))) {
      result.skipped += 1;
      continue;
    }
    const touched = addedLines(repo, merge, head, path);
    if (touched.size === 0) continue;

    let claimed = 0;
    try {
      for (const span of blameFile(repo, path).spans) {
        if (span.run === null) continue;
        for (let line = span.from; line <= span.to; line += 1) {
          if (!touched.has(line)) continue;
          claimed += 1;
          const name = span.run.harness.name;
          const bucket = byAgent.get(name) ?? { lines: 0, runs: new Map() };
          bucket.lines += 1;
          bucket.runs.set(span.run.run_id, span.run);
          byAgent.set(name, bucket);
        }
      }
    } catch {
      // A file blame cannot read is a file this report says nothing about.
      result.skipped += 1;
      continue;
    }

    result.files.push({ path, changed: touched.size, byAgents: claimed });
    result.changed += touched.size;
    result.byAgents += claimed;
  }

  result.agents = [...byAgent.entries()]
    .map(([agent, bucket]) => ({
      agent,
      lines: bucket.lines,
      runs: [...bucket.runs.values()]
        .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
        .slice(0, MAX_RUNS)
        .map((run) => ({
          id: run.run_id.replace(/-/g, '').slice(0, 7),
          intent: run.task.intent ?? null,
          model: run.model?.name ?? null,
          usd: run.cost?.usd ?? null,
        })),
    }))
    .sort((a, b) => b.lines - a.lines);

  result.files.sort((a, b) => b.byAgents - a.byAgents || a.path.localeCompare(b.path));
  return result;
}

/** Line numbers this change added or altered, in the file as it stands now. */
function addedLines(repo: Repo, base: string, head: string, path: string): Set<number> {
  const out = tryGit(['diff', '--no-color', '--no-ext-diff', '--unified=0', `${base}..${head}`, '--', path], {
    cwd: repo.root,
  });
  const lines = new Set<number>();
  if (out === null) return lines;
  for (const hunk of parseDiff(out)) {
    for (let at = hunk.newStart; at < hunk.newStart + hunk.newLen; at += 1) lines.add(at);
  }
  return lines;
}
