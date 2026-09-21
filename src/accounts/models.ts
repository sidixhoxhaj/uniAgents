/**
 * Which Claude models a pooled subscription login may actually ask for.
 *
 * Read from the catalog Claude Code itself caches, the same way the Codex
 * side reads `models_cache.json` rather than trusting a constant: model ids
 * drift, and a hardcoded list goes wrong silently.
 *
 *   ~/.claude/cache/model-catalog/published-<hash>.json
 *     → document.surfaces.cc.model_selector_config[].models[]
 *
 * Two things measured on a real machine (2026-09-21) that this file exists
 * to respect:
 *
 *   - `offered_on` is a DEPLOYMENT gate, not a plan gate. On this machine
 *     `claude-opus-4-1-20250805` lists only `bedrock` and `vertex`, so a
 *     first-party subscription login cannot serve it. Offering it would let
 *     the user pick a model that fails on every request. Only entries
 *     carrying `first_party` are returned.
 *   - The cache goes stale within about an hour of being fetched and Claude
 *     Code refetches it from a hosted endpoint. We never refetch: this is a
 *     read-only tool, and a stale list of real model ids beats inventing
 *     one. A missing or unparseable cache yields an empty list, never an
 *     error — the picker simply has nothing to offer.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeModel {
  id: string;
  /** Display name from the catalog ("Opus 5"), never derived from the id. */
  name: string;
  /** The catalog's own grouping: headline models vs the longer tail. */
  section: string;
}

export function claudeCatalogDir(): string {
  const configured = process.env['CLAUDE_CONFIG_DIR'];
  const base = configured !== undefined && configured !== '' ? configured : join(homedir(), '.claude');
  return join(base, 'cache', 'model-catalog');
}

let cached: ClaudeModel[] | null = null;

/**
 * Model ids a first-party login can actually use. Memoised for the process
 * lifetime: the catalog cannot change under us without Claude Code rewriting
 * it, and re-reading a 200 KB file per dashboard poll is pure waste.
 */
export async function loadClaudeModels(dir = claudeCatalogDir()): Promise<ClaudeModel[]> {
  if (cached !== null) return cached;
  cached = await readCatalog(dir);
  return cached;
}

async function readCatalog(dir: string): Promise<ClaudeModel[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith('published-') && f.endsWith('.json') && f !== 'published-floor.json');
  } catch {
    return [];
  }

  const out = new Map<string, ClaudeModel>();
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, file), 'utf8'));
    } catch {
      continue; // a half-written or rotated cache file is not an error here
    }
    for (const model of modelsIn(parsed)) out.set(model.id, model);
  }
  return [...out.values()];
}

/**
 * Walks to `document.surfaces.cc.model_selector_config[].models[]` one step
 * at a time. The shape is Claude Code's private cache, not a documented API,
 * so every level is checked rather than assumed — a changed shape must yield
 * no models, not a crash on a dashboard request.
 */
function modelsIn(root: unknown): ClaudeModel[] {
  const surfaces = record(record(record(root)?.['document'])?.['surfaces']);
  const cc = record(surfaces?.['cc']);
  const configs = cc?.['model_selector_config'];
  if (!Array.isArray(configs)) return [];

  const out: ClaudeModel[] = [];
  for (const config of configs) {
    const models = record(config)?.['models'];
    if (!Array.isArray(models)) continue;
    for (const entry of models) {
      const m = record(entry);
      if (m === null) continue;
      const id = m['id'];
      if (typeof id !== 'string' || id === '') continue;
      // A model not offered first-party cannot serve a Keychain login.
      const offered = m['offered_on'];
      if (!Array.isArray(offered) || !offered.includes('first_party')) continue;
      out.push({
        id,
        name: typeof m['name'] === 'string' && m['name'] !== '' ? m['name'] : id,
        section: typeof m['section'] === 'string' ? m['section'] : 'main',
      });
    }
  }
  return out;
}

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Reset memoisation — tests only. */
export function resetClaudeModelCache(): void {
  cached = null;
}
