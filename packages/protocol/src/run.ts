import * as z from 'zod';

/**
 * Bump only with a migration. Every record in the ledger carries it, and
 * readers refuse versions they do not understand instead of guessing.
 */
export const SCHEMA_VERSION = 1;

export const HARNESS_IDS = ['opencode', 'claude-code', 'codex', 'cursor', 'git'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha256 hex digest');
/** Git object id: sha1 (40 hex) or sha256 (64 hex) repositories. */
const gitOid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'expected a git object id');
const timestamp = z.iso.datetime({ offset: true });
const count = z.int().nonnegative();

export const HunkSchema = z.strictObject({
  old_start: count,
  old_len: count,
  new_start: count,
  new_len: count,
});

export const ToolCallSchema = z.strictObject({
  name: z.string().min(1),
  args_sha256: sha256,
  result_sha256: sha256.nullable(),
  ts: timestamp,
  ok: z.boolean(),
});

export const FileReadSchema = z.strictObject({
  path: z.string().min(1),
  blob_sha: gitOid.nullable(),
});

export const FileWriteSchema = z
  .strictObject({
    path: z.string().min(1),
    /** null when the run created the file. */
    pre_blob_sha: gitOid.nullable(),
    /** null when the run deleted the file. */
    post_blob_sha: gitOid.nullable(),
    hunks: z.array(HunkSchema),
  })
  .refine((w) => w.pre_blob_sha !== null || w.post_blob_sha !== null, {
    message: 'a write needs a pre or a post blob; both null means nothing happened',
    path: ['post_blob_sha'],
  });

/**
 * One agent run: the single input every adapter produces and every later
 * stage (provenance, blame, revert, sync) consumes. Prompts and code never
 * appear here in the clear by default, only their hashes.
 */
export const RunSchema = z
  .strictObject({
    schema_version: z.literal(SCHEMA_VERSION),
    run_id: z.uuid(),
    session_id: z.uuid(),
    parent_run_id: z.uuid().nullable(),

    harness: z.strictObject({
      name: z.enum(HARNESS_IDS),
      version: z.string().min(1).nullable(),
    }),
    model: z
      .strictObject({
        provider: z.string().min(1),
        name: z.string().min(1),
        version: z.string().min(1).nullable(),
      })
      .nullable(),
    actor: z.strictObject({
      type: z.enum(['agent', 'human']),
      id: z.string().min(1),
    }),

    task: z.strictObject({
      prompt_sha256: sha256.nullable(),
      /** Stays local unless the team explicitly opts in to syncing prompts. */
      prompt_text: z.string().optional(),
      intent: z.string().max(120).optional(),
    }),

    started_at: timestamp,
    ended_at: timestamp.nullable(),

    tool_calls: z.array(ToolCallSchema),
    files_read: z.array(FileReadSchema),
    files_written: z.array(FileWriteSchema),

    tests: z
      .strictObject({
        command: z.string().min(1),
        passed: count,
        failed: count,
        ts: timestamp,
      })
      .optional(),
    cost: z
      .strictObject({
        input_tokens: count,
        output_tokens: count,
        usd: z.number().nonnegative(),
      })
      .optional(),

    env: z.strictObject({
      branch: z.string().min(1).nullable(),
      head_commit: gitOid.nullable(),
      worktree_id: z.string().min(1),
      host_id: z.string().min(1),
    }),
  })
  .superRefine((run, ctx) => {
    if (run.parent_run_id === run.run_id) {
      ctx.addIssue({ code: 'custom', message: 'a run cannot be its own parent', path: ['parent_run_id'] });
    }
    if (run.ended_at !== null && Date.parse(run.ended_at) < Date.parse(run.started_at)) {
      ctx.addIssue({ code: 'custom', message: 'ended_at is earlier than started_at', path: ['ended_at'] });
    }
  });

export type Run = z.infer<typeof RunSchema>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** Validates untrusted input (adapter output, queue lines) with readable errors. */
export function parseRun(input: unknown): ParseResult<Run> {
  const result = RunSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${where}: ${issue.message}`;
    }),
  };
}
