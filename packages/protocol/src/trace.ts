import * as z from 'zod';

/**
 * Agent Trace: the interchange format the agent vendors agreed on.
 *
 * Cursor published the RFC in January 2026 and Anthropic, Cognition,
 * Cloudflare, Vercel and Google are behind it, which means three of the four
 * agents this records already have a shared way of saying who wrote a line.
 * A tool that only speaks its own format is a tool nobody else can read, so
 * DeepBlame writes the standard and reads it.
 *
 * What the standard does not carry is the thing our ledger exists for: the
 * file contents before and after. A trace says "an agent wrote lines 42 to 67";
 * it cannot say what stood there first, so it cannot be undone. That is the
 * honest boundary between what we import and what we watched ourselves, and it
 * is kept visible rather than smoothed over.
 *
 * Spec: https://agent-trace.dev — schema at /schemas/v1/trace-record.json.
 */

/**
 * The schema's own pattern is `^[0-9]+\.[0-9]+$`, so the three-part version in
 * the published example does not validate against it. We write two parts and
 * accept whatever we are given.
 */
export const TRACE_VERSION = '0.1';

const contributor = z.strictObject({
  type: z.enum(['human', 'ai', 'mixed', 'unknown']),
  model_id: z.string().max(250).optional(),
});

const range = z.strictObject({
  start_line: z.int().min(1),
  end_line: z.int().min(1),
  content_hash: z.string().optional(),
  contributor: contributor.optional(),
});

const conversation = z.strictObject({
  url: z.string().optional(),
  contributor: contributor.optional(),
  ranges: z.array(range),
  related: z.array(z.strictObject({ type: z.string(), url: z.string() })).optional(),
});

export const TraceRecordSchema = z.strictObject({
  version: z.string().regex(/^[0-9]+\.[0-9]+(\.[0-9]+)?$/),
  id: z.string().min(1),
  timestamp: z.string().min(1),
  vcs: z.strictObject({ type: z.enum(['git', 'jj', 'hg', 'svn']), revision: z.string() }).optional(),
  tool: z.strictObject({ name: z.string(), version: z.string() }).optional(),
  files: z.array(z.strictObject({ path: z.string(), conversations: z.array(conversation) })),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type TraceRecord = z.infer<typeof TraceRecordSchema>;
export type TraceContributor = z.infer<typeof contributor>;

/** Our own corner of `metadata`, namespaced the way the spec's example does. */
export const TRACE_VENDOR = 'dev.deepblame';

export function parseTrace(input: unknown): { record: TraceRecord } | { error: string } {
  const result = TraceRecordSchema.safeParse(input);
  if (result.success) return { record: result.data };
  const first = result.error.issues[0];
  return { error: first === undefined ? 'not an Agent Trace record' : `${first.path.join('.')}: ${first.message}` };
}
