/**
 * Which GPT model answers a Claude model, and how hard it reasons.
 *
 * Claude Code asks for a Claude model; something has to choose. The names
 * below were read from a REAL account's model cache on 2026-09-20 — the
 * predecessor hardcoded `gpt-5.1-codex`, which this backend now rejects
 * outright with 400 "not supported when using Codex with a ChatGPT account".
 * That is why the list is discovered at runtime where possible rather than
 * trusted from a constant.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codexHome } from './credential.ts';

/** Fallbacks, used when the cache cannot be read. Verified working. */
const DEFAULT_MAP: Array<{ match: RegExp; model: string; effort: string }> = [
  { match: /opus/i, model: 'gpt-5.6-terra', effort: 'high' },
  { match: /sonnet/i, model: 'gpt-5.6-terra', effort: 'medium' },
  { match: /haiku/i, model: 'gpt-5.6-luna', effort: 'low' },
  { match: /fable/i, model: 'gpt-5.6-sol', effort: 'high' },
];

const FALLBACK_MODEL = 'gpt-5.6-terra';
const FALLBACK_EFFORT = 'medium';

let available: string[] | null = null;

/** Model ids this account may actually use, from the codex CLI's own cache. */
export async function loadAvailableModels(home = codexHome()): Promise<string[]> {
  if (available !== null) return available;
  try {
    const cache = JSON.parse(await readFile(join(home, 'models_cache.json'), 'utf8'));
    const ids = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object' || node === null) return;
      for (const [k, v] of Object.entries(node)) {
        if ((k === 'id' || k === 'slug') && typeof v === 'string' && v.startsWith('gpt-')) ids.add(v);
        walk(v);
      }
    };
    walk(cache);
    available = [...ids];
  } catch {
    available = [];
  }
  return available;
}

/** The GPT model that should answer a given Claude model. */
export function modelFor(claudeModel: string): string {
  const row = DEFAULT_MAP.find((r) => r.match.test(claudeModel));
  const chosen = row?.model ?? FALLBACK_MODEL;
  // Only substitute when we positively know the model is unavailable; an
  // empty list means "cache unreadable", not "nothing is available".
  if (available !== null && available.length > 0 && !available.includes(chosen)) {
    return available.includes(FALLBACK_MODEL) ? FALLBACK_MODEL : (available[0] ?? chosen);
  }
  return chosen;
}

export function effortFor(claudeModel: string): string {
  return DEFAULT_MAP.find((r) => r.match.test(claudeModel))?.effort ?? FALLBACK_EFFORT;
}

/** Reset memoisation — tests only. */
export function resetModelCache(): void {
  available = null;
}
