/**
 * Reads the ChatGPT/Codex login the real `codex` CLI already created.
 *
 * READ-ONLY, like the Claude side: we never log in, never write, never
 * refresh-and-persist. The credential lives in ~/.codex/auth.json (or
 * $CODEX_HOME/auth.json), written by `codex login`.
 *
 * Verified against a real enterprise account, 2026-09-20.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexCredential {
  accessToken: string;
  accountId: string | null;
  /** "chatgpt" for a subscription; an API key login reports otherwise. */
  authMode: string;
  /** From the id_token's claims — display only, never drives routing. */
  planType: string | null;
}

export function codexHome(): string {
  return process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
}

export async function readCodexCredential(home = codexHome()): Promise<CodexCredential> {
  let raw: string;
  try {
    raw = await readFile(join(home, 'auth.json'), 'utf8');
  } catch {
    throw new CodexError(`No Codex login found in ${home}. Run \`codex\` and sign in first.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CodexError(`${home}/auth.json is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new CodexError(`${home}/auth.json is not an object.`);

  const root = parsed as Record<string, unknown>;
  const tokens = root['tokens'];
  if (typeof tokens !== 'object' || tokens === null) {
    throw new CodexError(`${home}/auth.json has no tokens — sign in with \`codex\` again.`);
  }

  const t = tokens as Record<string, unknown>;
  const accessToken = t['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new CodexError(`${home}/auth.json has no access token.`);
  }

  const accountId = t['account_id'];
  const authMode = root['auth_mode'];

  return {
    accessToken,
    accountId: typeof accountId === 'string' && accountId !== '' ? accountId : null,
    authMode: typeof authMode === 'string' ? authMode : 'chatgpt',
    planType: typeof t['id_token'] === 'string' ? planFromIdToken(t['id_token']) : null,
  };
}

/**
 * The plan name lives in a namespaced claim of the id_token. Best-effort and
 * display-only: a malformed or expired id_token must never stop a request,
 * because the ACCESS token is what authorises it and they expire separately.
 */
function planFromIdToken(idToken: string): string | null {
  try {
    const payload = idToken.split('.')[1];
    if (payload === undefined) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const auth = claims['https://api.openai.com/auth'];
    const plan = auth?.['chatgpt_plan_type'];
    return typeof plan === 'string' ? plan : null;
  } catch {
    return null;
  }
}

export class CodexError extends Error {
  override name = 'CodexError';
}
