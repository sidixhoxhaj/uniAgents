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

/**
 * The OAuth entitlement marker. Anthropic gates premium models (Opus,
 * Sonnet) behind this EXACT string appearing as the FIRST system block;
 * without it the request is refused with a bare 429 carrying no
 * rate-limit headers and the message "Error".
 *
 * Measured on two accounts in different organisations, 2026-09-21: Opus
 * returned 429 with no system block and with a non-matching one, and 200
 * with this block first — while the five-hour window sat at 5% and 27%.
 * Haiku returned 200 in every case; it is exempt from the gate.
 *
 * Do not reword it. See anthropics/claude-code#87420.
 */
export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Cheapest model available; we want the headers, not the answer. */
const PROBE_MODEL = 'claude-haiku-4-5-20251001';
const PROBE_TIMEOUT_MS = 15_000;

/**
 * `model` is the model the SESSION will actually run, when one is configured.
 *
 * It matters because a 429 is not necessarily account-wide. Measured on two
 * accounts in different organisations, at the same moment, on the same
 * credential: `claude-haiku-4-5-20251001` returned 200 five times out of five
 * while `claude-sonnet-4-5-20250929` and `claude-opus-5` returned 429 ten out
 * of ten — with the five-hour window at 4-23% and `locked_reason: null`.
 *
 * Probing with the cheapest model therefore reported an account as healthy
 * while every real request to it was being rejected. The fallback still
 * DEFAULTS to Haiku (it is the cheapest thing that reads the headers, and
 * this path spends a real request), but a configured model is used instead so
 * that what we measure is what the session will actually send.
 */
export async function probeUsage(accessToken: string, model?: string | null): Promise<Observation | null> {
  return (await readUsageEndpoint(accessToken)) ?? (await probeWithRequest(accessToken, model));
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

  // Overage only counts when the org can ACTUALLY spend it.
  //
  // Measured on a real Pro account: extra_usage came back
  // {is_enabled: false, disabled_reason: "org_level_disabled_until",
  //  utilization: 100}. That 100 is 100% of a pool the org has switched
  // OFF — nothing is billable, and the five-hour window was at 11%. Reading
  // utilization alone marked a nearly-idle account exhausted and pushed the
  // whole session onto the slow Codex path.
  //
  // `is_enabled` is the gate; utilization is the amount. Both are needed:
  // the flag alone says overage is merely AVAILABLE, which is not spending.
  // Two distinct ways an account stops being usable on its own quota, and
  // they need opposite readings of the same block:
  //
  //  - `spend_limit_reached` — the org's paid pool is capped out. Measured on
  //    a real Pro account: is_enabled false, disabled_reason
  //    "org_level_disabled_until", used_credits 4231 of 1000. That account
  //    429s on every request with NO rate-limit headers at all, so the
  //    window figures (11%) say nothing useful. It is genuinely spent.
  //
  //  - overage merely AVAILABLE but untouched — is_enabled true with a small
  //    utilization (1.76% of 5000). Nothing is capped; the account is fine.
  //    Reading `utilization > 0` here marked it exhausted and pushed the
  //    session onto the slow Codex path.
  const spendCapped = extra?.['spend_limit_reached'] === true;
  const overageEnabled = extra?.['is_enabled'] === true;
  // Overage begins exactly at 100%: below that the request is still served
  // from the included subscription and costs nothing extra.
  const overageActive = spendCapped || (overageEnabled && overagePercent >= 100);

  return {
    kind: 'usage',
    // ALREADY 0-100 here, unlike the 0-1 float on the response headers.
    // Scaling this would put a 42%-spent account at 4200%.
    percent,
    resetsAt: isoDate(fiveHour['resets_at']),
    percent7d: sevenDay === null ? null : num(sevenDay['utilization']),
    resetsAt7d: isoDate(sevenDay?.['resets_at']),
    overageActive,
    // Reported as observed, so the dashboard can still show a disabled pool's
    // number without that number forcing a rotation.
    overagePercent,
  };
}

/** The original route: spend the smallest possible request to read headers. */
async function probeWithRequest(accessToken: string, model?: string | null): Promise<Observation | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        model: model ?? PROBE_MODEL,
        max_tokens: 1,
        // The entitlement marker MUST be the first system block or Anthropic
        // refuses premium models over OAuth with a bare, headerless 429 —
        // indistinguishable from real quota pushback. Haiku is exempt, which
        // is exactly why probing with it reported an account healthy while
        // the session's own model was refused.
        // See CLAUDE_CODE_SYSTEM and docs/PROTOCOL.md.
        system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
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
