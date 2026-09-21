/**
 * Where uniAgents keeps its data. See docs/STORAGE.md.
 *
 * A visible directory in $HOME, matching what the official CLIs already do
 * (~/.claude, ~/.codex): inspectable with `cat`, backed up by copying, reset
 * with `rm -rf`. No database, no binary format, no migration tool.
 *
 * CREDENTIALS ARE NEVER WRITTEN HERE. They stay where the official CLIs put
 * them and are read without ever being copied. That is the property worth
 * protecting — this directory holds preferences and history, nothing secret.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

export function dataDir(): string {
  return process.env['UNIAGENTS_HOME'] ?? join(homedir(), '.uniagents');
}

export const CONFIG_FILE = 'config.json';
export const USAGE_FILE = 'usage.jsonl';
export const ACTIVITY_FILE = 'activity.jsonl';
export const CACHE_FILE = 'cache.json';

export function filePath(name: string): string {
  return join(dataDir(), name);
}

/**
 * Create the data directory if it is missing. Resolves either way: a failure
 * here must never stop the proxy, only cost us persistence.
 */
export async function ensureDataDir(): Promise<boolean> {
  try {
    // 0o700 — this is the user's own data and nobody else's business.
    await mkdir(dataDir(), { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}
