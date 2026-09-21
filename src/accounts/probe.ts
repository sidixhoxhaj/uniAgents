/**
 * Reads an account's current quota without waiting for you to send something.
 *
 * Two routes, tried in order:
 *
 *  1. `GET /api/oauth/usage` — the endpoint Claude Code's own client reads.
 *     It costs NO quota, and it carries more than the response headers do:
 *     real overage spend in currency, and a `locked_reason` per window.
 *     This is the Anthropic counterpart to Codex's `wham/usage`.
 *
 *  2. A one-token Haiku request, purely to read the rate-limit headers off
 *     the response. This is the original route and it does spend a request.
 *     Kept as a fallback because (1) is private and undocumented: it is
 *     rate-limited (measured: a second account 429'd on a back-to-back
 *     read), and it can change shape without notice.
 *
 * Used at startup so the stats page has real numbers the moment it opens,
 * and by `unicode usage`. Shared deliberately: two copies would drift.
 */

import { classify, filterResponseHeaders } from '../core/observation.ts';
import type { Observation } from '../core/observation.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Cheapest model available; we want the headers, not the answer. */
const PROBE_MODEL = 'claude-haiku-4-5-20251001';
const PROBE_TIMEOUT_MS = 15_000;

export async function probeUsage(accessToken: string): Promise<Observation | null> {
  return (await readUsageEndpoint(accessToken)) ?? (await probeWithRequest(accessToken));
}

/**
 * The free route. Returns null on anything unexpected — a 429, an auth
 * error, a changed shape — so the caller falls back rather than reporting
 * an account as having no usage.
 *
 * Verified against a real account 2026-09-21; see docs/PROTOCOL.md.
 */
async function readUsageEndpoint(accessToken: string): Promise<Observation | null> {
  let data: Record<string, unknown>;
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'claude-cli/2.0.0 (external, cli)',
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // 401 is a real answer and worth reporting; everything else falls back.
    if (res.status === 401) return { kind: 'auth_invalid' };
    if (!res.ok) return null;
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  const fiveHour = record(data['five_hour']);
  // No five-hour window means this is not the shape we understand.
  if (fiveHour === null) return null;
  const percent = num(fiveHour['utilization']);
  if (percent === null) return null;

  const sevenDay = record(data['seven_day']);
  // Overage is reported here as real money, not the header's bare float.
  const extra = record(data['extra_usage']);
  const overagePercent = num(extra?.['utilization']) ?? 0;

  return {
    kind: 'usage',
    // ALREADY 0-100 here, unlike the 0-1 float on the response headers.
    // Scaling this would put a 42%-spent account at 4200%.
    percent,
    resetsAt: isoDate(fiveHour['resets_at']),
    percent7d: sevenDay === null ? null : num(sevenDay['utilization']),
    resetsAt7d: isoDate(sevenDay?.['resets_at']),
    // `is_enabled` only says overage is available to spend, not that any has
    // been spent — the utilisation is what separates included from paid.
    overageActive: overagePercent > 0,
    overagePercent,
  };
}

/** The original route: spend the smallest possible request to read headers. */
async function probeWithRequest(accessToken: string): Promise<Observation | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return classify(res.status, filterResponseHeaders(headers));
  } catch {
    return null; // offline or timed out — the account is still usable
  }
}

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** `resets_at` is an ISO 8601 string here — NOT the epoch seconds the
 *  rate-limit headers use. Parsing one as the other dates it to 1970. */
function isoDate(v: unknown): Date | null {
  if (typeof v !== 'string' || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
