import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, STATE_DIR } from '@deepblame/protocol';
import type { TranscriptUsage } from './transcript';

/**
 * Turning tokens into money needs a rate, and rates change without warning.
 * So: a small table of the ones we know, a repository-level override that
 * always wins, and a null result rather than a guess for anything else. A
 * wrong number in a cost report is worse than no number.
 */

export interface Rate {
  /** US dollars per million tokens. */
  input: number;
  output: number;
  cache_write?: number;
  cache_read?: number;
}

/** Matched by longest prefix, so dated model ids resolve without an update. */
const RATES: Readonly<Record<string, Rate>> = {
  'claude-opus-4': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  'claude-sonnet-4': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  'claude-haiku-4': { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 },
  'claude-3-5-sonnet': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  'claude-3-opus': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
};

export type RateTable = Readonly<Record<string, Rate>>;

/** Rates written in `.deepblame/config.json` under `pricing`, if any. */
export function readRates(root: string): RateTable {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(root, STATE_DIR, CONFIG_FILE), 'utf8'));
    if (!isRecord(raw) || !isRecord(raw['pricing'])) return {};
    const rates: Record<string, Rate> = {};
    for (const [model, value] of Object.entries(raw['pricing'])) {
      if (!isRecord(value)) continue;
      const input = asRate(value['input']);
      const output = asRate(value['output']);
      if (input === null || output === null) continue;
      rates[model] = {
        input,
        output,
        ...(asRate(value['cache_write']) === null ? {} : { cache_write: asRate(value['cache_write']) as number }),
        ...(asRate(value['cache_read']) === null ? {} : { cache_read: asRate(value['cache_read']) as number }),
      };
    }
    return rates;
  } catch {
    return {};
  }
}

export function rateFor(model: string | null, overrides: RateTable = {}): Rate | null {
  if (model === null) return null;
  const table = { ...RATES, ...overrides };
  let best: { key: string; rate: Rate } | null = null;
  for (const [key, rate] of Object.entries(table)) {
    if (!model.startsWith(key)) continue;
    if (best === null || key.length > best.key.length) best = { key, rate };
  }
  return best?.rate ?? null;
}

/**
 * What the turn cost. Null when we have no rate for the model: the caller
 * shows a dash and the repository can add the rate to its config.
 */
export function priceUsd(usage: TranscriptUsage, overrides: RateTable = {}): { usd: number | null; source: 'rates' | 'harness' } {
  if (usage.harness_usd !== null) return { usd: round(usage.harness_usd), source: 'harness' };
  const rate = rateFor(usage.model, overrides);
  if (rate === null) return { usd: null, source: 'rates' };
  const perMillion =
    usage.input_tokens * rate.input +
    usage.output_tokens * rate.output +
    usage.cache_write_tokens * (rate.cache_write ?? rate.input) +
    usage.cache_read_tokens * (rate.cache_read ?? rate.input / 10);
  return { usd: round(perMillion / 1_000_000), source: 'rates' };
}

/** Sub-cent precision, because a single turn often costs less than a cent. */
function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

function asRate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
