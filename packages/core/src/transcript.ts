import { readFileSync, statSync } from 'node:fs';

/**
 * Claude Code writes the conversation to a JSONL file and tells its hooks
 * where it is. That file is the only place the model name and the token
 * counts appear, so the sealer reads it once per turn, off the hot path, and
 * treats every line as untrusted: unknown shapes are skipped, never thrown.
 */

/** A transcript larger than this is left alone rather than stalling a seal. */
const MAX_BYTES = 64 * 1024 * 1024;

export interface TranscriptUsage {
  /** The model that did the work, as the harness names it. */
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  /** Money the harness itself reported, when it reports any. */
  harness_usd: number | null;
  /** Assistant messages counted. Zero means nothing matched the window. */
  messages: number;
}

/** Sums the usage of assistant messages written between two timestamps. */
export function readTranscriptUsage(file: string, fromIso: string, toIso: string): TranscriptUsage | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;

  let text: string;
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const total: TranscriptUsage = {
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    harness_usd: null,
    messages: 0,
  };
  const models = new Map<string, number>();

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry['type'] !== 'assistant') continue;
    const at = Date.parse(asString(entry['timestamp']) ?? '');
    // A tolerance of a second: the hook and the transcript are written by
    // different processes and their clocks are only nearly the same.
    if (!Number.isFinite(at) || at < from - 1000 || at > to + 1000) continue;

    const message = isRecord(entry['message']) ? entry['message'] : {};
    const usage = isRecord(message['usage']) ? message['usage'] : null;
    if (usage === null) continue;

    total.messages += 1;
    total.input_tokens += asCount(usage['input_tokens']);
    total.output_tokens += asCount(usage['output_tokens']);
    total.cache_write_tokens += asCount(usage['cache_creation_input_tokens']);
    total.cache_read_tokens += asCount(usage['cache_read_input_tokens']);

    const model = asString(message['model']);
    if (model !== null) models.set(model, (models.get(model) ?? 0) + 1);

    const reported = entry['costUSD'] ?? message['costUSD'];
    if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
      total.harness_usd = (total.harness_usd ?? 0) + reported;
    }
  }

  if (total.messages === 0) return null;
  // One turn can retry on a different model; the one that spoke most is the one we name.
  total.model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return total;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
