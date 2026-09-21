/**
 * Reads Codex usage from the account's own usage endpoint.
 *
 * This is what the ChatGPT UI shows ("8.94 of 1,250 credits used · 99%
 * remaining · resets Oct 1"), and it is far better than what the response
 * headers give: it needs no request to be spent, and on a credit-based plan
 * the headers report nothing usable at all (every window field reads 0).
 *
 *   GET https://chatgpt.com/backend-api/wham/usage
 *   Authorization: Bearer <access token>
 *   ChatGPT-Account-ID: <account id>
 *   OpenAI-Beta: codex-1
 *
 * This is a PRIVATE endpoint used by Codex's own clients, not a documented
 * API. It can change without notice, so every field is read defensively and
 * any failure degrades to "no usage reported" rather than breaking anything.
 * Verified against a real enterprise account 2026-09-20.
 */

import { readCodexCredential } from './credential.ts';
import type { CodexCredential } from './credential.ts';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TIMEOUT_MS = 12_000;

export interface CodexUsage {
  /** Percent of the allowance consumed, 0-100. */
  percent: number | null;
  used: number | null;
  limit: number | null;
  /** "credit", or whatever unit the plan is metered in. */
  unit: string | null;
  resetsAt: Date | null;
  planType: string | null;
  email: string | null;
  hasCredits: boolean | null;
  unlimited: boolean | null;
  /** The spend cap has been hit; requests will fail until it resets. */
  limitReached: boolean;
}

export async function fetchCodexUsage(credential?: CodexCredential): Promise<CodexUsage | null> {
  let cred = credential;
  if (!cred) {
    try {
      cred = await readCodexCredential();
    } catch {
      return null; // not signed in
    }
  }

  let data: Record<string, unknown>;
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        'OpenAI-Beta': 'codex-1',
        originator: 'codex_cli_rs',
        'User-Agent': `codex_cli_rs/0.155.1 (${process.platform}; ${process.arch})`,
        Accept: 'application/json',
        ...(cred.accountId ? { 'ChatGPT-Account-ID': cred.accountId } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  const credits = asRecord(data['credits']);
  const spend = asRecord(data['spend_control']);
  const limitBlock = asRecord(spend?.['individual_limit']);

  // A rolling rate_limit is reported instead of spend controls on some plans;
  // prefer whichever one is actually populated.
  const rate = asRecord(data['rate_limit']);

  const used = num(limitBlock?.['used']);
  const limit = num(limitBlock?.['limit']);
  const usedPercent =
    num(limitBlock?.['used_percent']) ??
    (used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null) ??
    num(rate?.['used_percent']);

  return {
    percent: usedPercent === null ? null : Math.round(usedPercent * 100) / 100,
    used,
    limit,
    unit: str(limitBlock?.['unit']),
    resetsAt: epochSeconds(limitBlock?.['reset_at']) ?? afterSeconds(limitBlock?.['reset_after_seconds']) ?? afterSeconds(rate?.['resets_in_seconds']),
    planType: str(data['plan_type']),
    email: str(data['email']),
    hasCredits: bool(credits?.['has_credits']),
    unlimited: bool(credits?.['unlimited']),
    limitReached: bool(spend?.['reached']) === true || bool(credits?.['overage_limit_reached']) === true,
  };
}

/** Numbers arrive as JSON strings here ("1250", "8.9437…"), not as numbers. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function epochSeconds(v: unknown): Date | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return new Date(n * 1000);
}

function afterSeconds(v: unknown): Date | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return new Date(Date.now() + n * 1000);
}
