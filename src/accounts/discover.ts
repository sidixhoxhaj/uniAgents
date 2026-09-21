/**
 * Finds the Claude accounts already on this machine. READ-ONLY.
 *
 * This module never writes, never prompts for a login, and never runs an OAuth
 * flow. Accounts come from where the real `claude` CLI already put them:
 *
 *   - macOS: Keychain entries named `Claude Code-credentials[-<suffix>]`
 *   - Linux: `<config dir>/.credentials.json`
 *
 * The `-<suffix>` is the first 8 hex chars of sha256(CLAUDE_CONFIG_DIR), the
 * convention Claude Code uses to isolate one login per config directory. That
 * is why several accounts can coexist: each has its own config dir.
 *
 * If you want another account, you run `claude` and log in — exactly as you
 * would anyway. There is nothing for this tool to store.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface DiscoveredAccount {
  /** Stable id: the keychain service name, or the credentials file path. */
  id: string;
  /** Short human label, e.g. "default" or the config dir name. */
  label: string;
  source: 'keychain' | 'file';
  /** Present only for file-sourced accounts. */
  path?: string;
}

export interface Credential {
  accessToken: string;
  refreshToken: string | null;
  /** null when the stored credential carries no expiry. */
  expiresAt: Date | null;
  scopes: string[];
  subscriptionType: string | null;
}

/** The keychain service name Claude Code uses for a given config directory. */
export function serviceNameForConfigDir(configDir: string): string {
  const suffix = createHash('sha256').update(configDir, 'utf8').digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${suffix}`;
}

/**
 * Enumerate accounts. Lists service NAMES only — never reads a secret value,
 * so this never triggers a keychain authorisation prompt.
 */
export async function discoverAccounts(): Promise<DiscoveredAccount[]> {
  assertSupportedPlatform();
  const found: DiscoveredAccount[] = [];

  if (process.platform === 'darwin') {
    found.push(...(await discoverKeychain()));
  }
  found.push(...(await discoverCredentialFiles()));

  // Stable order so ids and priorities are reproducible across runs: the
  // default login first, then the rest alphabetically.
  found.sort((a, b) => {
    if (a.id === KEYCHAIN_SERVICE) return -1;
    if (b.id === KEYCHAIN_SERVICE) return 1;
    return a.id.localeCompare(b.id);
  });
  return found;
}

async function discoverKeychain(): Promise<DiscoveredAccount[]> {
  let stdout: string;
  try {
    // `dump-keychain` without -d prints metadata only, never secret values.
    stdout = (await exec('security', ['dump-keychain'], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch {
    return []; // no keychain access, or no keychain — not an error worth failing on
  }

  const services = new Set<string>();
  for (const m of stdout.matchAll(/"svce"<blob>="([^"]*Claude Code-credentials[^"]*)"/g)) {
    if (m[1]) services.add(m[1]);
  }

  // NOT every `Claude Code-credentials-*` entry is an account. Claude Code
  // stores MCP connector tokens (Canva, Notion, Linear, …) under the very same
  // service-name pattern, as `{"mcpOAuth": {...}}` with no `claudeAiOauth`.
  // Observed on a real machine: 6 of 8 matching entries were connector caches.
  // Including them puts accounts in the pool that can never serve a request,
  // so each candidate is confirmed by reading it.
  const confirmed = await Promise.all(
    [...services].map(async (service) => {
      try {
        parseCredential(await readKeychainValue(service), service);
        return service;
      } catch {
        return null; // not a Claude account: a connector cache, or unreadable
      }
    }),
  );

  return confirmed
    .filter((s): s is string => s !== null)
    .map((service) => ({
      id: service,
      label: service === KEYCHAIN_SERVICE ? 'default' : service.slice(KEYCHAIN_SERVICE.length + 1),
      source: 'keychain' as const,
    }));
}

/**
 * Credential FILES. This is the whole story on Linux, where Claude Code writes
 * `<config dir>/.credentials.json`; on macOS the Keychain is used instead and
 * this usually finds nothing.
 *
 * Looked at, in order: an explicit CLAUDE_CONFIG_DIR, the default ~/.claude,
 * and any sibling directory that looks like an isolated login (~/.claude-*),
 * which is the convention used to keep several accounts apart.
 */
async function discoverCredentialFiles(): Promise<DiscoveredAccount[]> {
  const home = homedir();
  const candidates = new Map<string, string>(); // path -> label

  const envDir = process.env['CLAUDE_CONFIG_DIR'];
  if (envDir) candidates.set(join(envDir, '.credentials.json'), basename(envDir));
  candidates.set(join(home, '.claude', '.credentials.json'), 'default');

  // Isolated logins live in their own config directories next to ~/.claude.
  try {
    for (const entry of await readdir(home, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.claude' || !entry.name.startsWith('.claude')) continue;
      candidates.set(join(home, entry.name, '.credentials.json'), entry.name.replace(/^\.claude-?/, '') || entry.name);
    }
  } catch {
    // unreadable home directory — the fixed candidates above still apply
  }

  const out: DiscoveredAccount[] = [];
  for (const [path, label] of candidates) {
    try {
      // Read rather than stat: an unparseable or empty file is not an account,
      // and finding that out now beats failing mid-session.
      const raw = await readFile(path, 'utf8');
      if (raw.trim() === '') continue;
      out.push({ id: path, label, source: 'file', path });
    } catch {
      // absent or unreadable — simply not an account
    }
  }
  return out;
}

/**
 * Read one account's credential.
 *
 * On macOS this DOES read a secret value, which may prompt for authorisation
 * the first time this binary asks. Callers should read once and hold the
 * result in memory for the process lifetime rather than re-reading per
 * request.
 */
export async function readCredential(account: DiscoveredAccount): Promise<Credential> {
  const raw = account.source === 'keychain' ? await readKeychainValue(account.id) : await readFile(account.path!, 'utf8');
  return parseCredential(raw, account.id);
}

async function readKeychainValue(service: string): Promise<string> {
  try {
    const { stdout } = await exec('security', ['find-generic-password', '-s', service, '-w'], { maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    throw new AccountError(`Could not read credential for ${service}: ${(err as Error).message}`);
  }
}

/**
 * Claude Code stores `{"claudeAiOauth": {...}}`. Tolerant of shape drift: we
 * look for the token in the nested object first, then at the top level, and
 * fail loudly rather than returning an empty token that would 401 upstream
 * and look like a revoked account.
 */
export function parseCredential(raw: string, id: string): Credential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AccountError(`Credential for ${id} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AccountError(`Credential for ${id} is not a JSON object.`);
  }

  const root = parsed as Record<string, unknown>;

  // A connector-token cache, not an account. Claude Code stores MCP OAuth
  // tokens under the same `Claude Code-credentials-*` service names, so this
  // check is what keeps them out of the rotation pool.
  if (!('claudeAiOauth' in root) && 'mcpOAuth' in root) {
    throw new AccountError(`${id} holds MCP connector tokens, not a Claude login.`);
  }

  const nested = root['claudeAiOauth'];
  const src = (typeof nested === 'object' && nested !== null ? nested : root) as Record<string, unknown>;

  const accessToken = src['accessToken'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new AccountError(`Credential for ${id} has no access token.`);
  }

  const expiresAtRaw = src['expiresAt'];
  const scopes = src['scopes'];
  const refresh = src['refreshToken'];
  const subscription = src['subscriptionType'];

  return {
    accessToken,
    refreshToken: typeof refresh === 'string' && refresh !== '' ? refresh : null,
    // Claude Code writes epoch MILLISECONDS here.
    expiresAt: typeof expiresAtRaw === 'number' && Number.isFinite(expiresAtRaw) ? new Date(expiresAtRaw) : null,
    scopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [],
    subscriptionType: typeof subscription === 'string' ? subscription : null,
  };
}

export function isExpired(credential: Credential, now: Date = new Date()): boolean {
  return credential.expiresAt !== null && now >= credential.expiresAt;
}

/**
 * Where a login would have been found on THIS platform. Naming the macOS
 * Keychain to a Linux user sends them looking for something that does not
 * exist there — a mistake worth not repeating.
 *
 * macOS and Linux only; see assertSupportedPlatform().
 */
export function credentialLocationHint(): string {
  return process.platform === 'darwin' ? 'the login Keychain' : '~/.claude/.credentials.json';
}

/**
 * uniAgents supports macOS and Linux. Windows is not supported — not as an
 * oversight but as a decision: it would mean a DPAPI backend and a separate
 * process-spawning path, neither of which anyone here can verify on real
 * hardware. Failing clearly beats shipping an unverified guess.
 */
export function assertSupportedPlatform(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new AccountError(
      `uniAgents supports macOS and Linux. This platform (${process.platform}) is not supported.`,
    );
  }
}

export class AccountError extends Error {
  override name = 'AccountError';
}
