/**
 * Everything the user chose: profile aliases, rotation order, which accounts
 * are in the pool, model parity, and settings.
 *
 * Written ATOMICALLY (temp file + rename) on every change, so a crash mid-write
 * cannot leave a truncated file that fails to parse on next start. The whole
 * file is small enough that rewriting it is cheaper than reasoning about
 * partial updates.
 *
 * Keyed by an account's DISCOVERY ID — its keychain service name or credentials
 * path — which is stable across restarts. An id that no longer resolves is
 * KEPT, not deleted: a login can be temporarily unreadable, and silently
 * dropping someone's alias because one keychain read failed is worse than a
 * stale entry.
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ensureDataDir, filePath, CONFIG_FILE } from './paths.ts';

export interface ProfileConfig {
  /** Shown instead of the email. null means "use the email". */
  alias: string | null;
  /** Rotation position, 1-based. Lower serves first. */
  order: number;
  /** Out of the pool entirely when false. */
  enabled: boolean;
}

export interface ParityRow {
  claude: string;
  gpt: string;
}

export interface Settings {
  language: string;
  theme: 'auto' | 'light' | 'dark';
  notifications: Record<string, boolean>;
}

export interface Config {
  version: number;
  profiles: Record<string, ProfileConfig>;
  parity: ParityRow[];
  settings: Settings;
  /**
   * Model forced onto every request, chosen on the dashboard. Null means
   * "whatever the client asked for", which is what clearing the picker
   * restores. A fresh config starts on DEFAULT_MODEL instead.
   */
  activeModel: string | null;
}

export const CONFIG_VERSION = 1;

/**
 * No model is forced by default: `unicode` passes no `--model` and the
 * session starts on whatever the user's own Claude Code default is.
 *
 * uniAgents is a launcher, not a model manager. Overriding the account
 * default on every launch is what made `/model` feel broken — the user set
 * a default, and something else quietly ignored it. Picking a model on the
 * dashboard is an opt-in, not the resting state.
 */
export const DEFAULT_MODEL = null;

export function defaultConfig(): Config {
  return {
    version: CONFIG_VERSION,
    profiles: {},
    parity: [],
    settings: {
      language: 'en',
      theme: 'auto',
      notifications: { rotated: true, exhausted: true, reset: false, auth: true },
    },
    activeModel: DEFAULT_MODEL,
  };
}

/**
 * Read the config. A missing, unreadable or corrupt file yields defaults
 * rather than throwing: the tool must start even if its own state is damaged.
 */
export async function loadConfig(): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(filePath(CONFIG_FILE), 'utf8');
  } catch {
    return defaultConfig();
  }

  try {
    return normalise(JSON.parse(raw));
  } catch {
    return defaultConfig();
  }
}

/**
 * Coerce whatever is on disk into a usable Config. Every field is checked,
 * because a hand-edited file is an explicitly supported thing to do — the
 * whole point of plain JSON is that people edit it.
 */
function normalise(parsed: unknown): Config {
  const base = defaultConfig();
  if (typeof parsed !== 'object' || parsed === null) return base;
  const root = parsed as Record<string, unknown>;

  const profiles: Record<string, ProfileConfig> = {};
  const rawProfiles = root['profiles'];
  if (typeof rawProfiles === 'object' && rawProfiles !== null) {
    for (const [id, value] of Object.entries(rawProfiles as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const p = value as Record<string, unknown>;
      profiles[id] = {
        alias: typeof p['alias'] === 'string' && p['alias'] !== '' ? p['alias'] : null,
        order: Number.isFinite(p['order']) ? Number(p['order']) : 0,
        enabled: p['enabled'] !== false, // absent means enabled
      };
    }
  }

  const parity: ParityRow[] = [];
  if (Array.isArray(root['parity'])) {
    for (const row of root['parity']) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Record<string, unknown>;
      if (typeof r['claude'] === 'string' && typeof r['gpt'] === 'string') {
        parity.push({ claude: r['claude'], gpt: r['gpt'] });
      }
    }
  }

  const rawSettings = (typeof root['settings'] === 'object' && root['settings'] !== null
    ? root['settings']
    : {}) as Record<string, unknown>;
  const theme = rawSettings['theme'];

  return {
    version: CONFIG_VERSION,
    profiles,
    parity,
    settings: {
      language: typeof rawSettings['language'] === 'string' ? rawSettings['language'] : base.settings.language,
      theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
      notifications: {
        ...base.settings.notifications,
        ...booleansOnly(rawSettings['notifications']),
      },
    },
    // Absent, null and empty all mean the same thing: force nothing, and let
    // Claude Code start on the user's own default.
    activeModel: typeof root['activeModel'] === 'string' && root['activeModel'] !== ''
      ? root['activeModel']
      : null,
  };
}

/** Keep only the boolean entries; a hand-edited "yes" must not become truthy. */
function booleansOnly(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/**
 * Write atomically: a temp file in the same directory, then rename. Rename is
 * atomic within a filesystem, so a reader either sees the old file or the new
 * one — never a half-written one.
 *
 * Returns false on failure rather than throwing. Persistence is bookkeeping;
 * a read-only disk must not break a working session.
 */
export async function saveConfig(config: Config): Promise<boolean> {
  if (!(await ensureDataDir())) return false;

  const target = filePath(CONFIG_FILE);
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temp, target);
    return true;
  } catch {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(temp);
    } catch {
      // the temp file may not exist; nothing to clean up
    }
    return false;
  }
}
