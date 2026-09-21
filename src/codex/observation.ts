/**
 * Classifies a Codex backend response, the counterpart to core/observation.ts.
 *
 * The wire format is NOTHING like Anthropic's, so it gets its own parser
 * rather than a shared one with special cases. Verified against the real
 * endpoint on 2026-09-20; see docs/PROTOCOL.md.
 *
 *   x-codex-primary-used-percent:          0-100 INTEGER (not a 0-1 float)
 *   x-codex-primary-reset-after-seconds:   SECONDS FROM NOW (not an epoch)
 *   x-codex-secondary-*:                   the second window, same shapes
 *   x-codex-plan-type:                     e.g. enterprise_cbp_usage_based
 *   x-codex-credits-has-credits:           "True" | "False"  (Python-cased!)
 *   x-codex-credits-unlimited:             "True" | "False"
 *
 * Two traps, both of which silently produce wrong numbers rather than errors:
 *   - percentages are already 0-100 here, but 0-1 floats on the Anthropic
 *     side. Multiplying by 100 puts a 12%-used account at 1200%.
 *   - resets are RELATIVE seconds here, absolute epoch seconds there.
 *   - the booleans are Python's "True"/"False", not JSON's "true"/"false".
 */

import type { Observation } from '../core/observation.ts';

export const CODEX_HEADERS = [
  'x-codex-primary-used-percent',
  'x-codex-primary-reset-after-seconds',
  'x-codex-primary-window-minutes',
  'x-codex-secondary-used-percent',
  'x-codex-secondary-reset-after-seconds',
  'x-codex-secondary-window-minutes',
  'x-codex-plan-type',
  'x-codex-credits-has-credits',
  'x-codex-credits-unlimited',
  'retry-after',
] as const;

export function filterCodexHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    lower[k.toLowerCase()] = Array.isArray(v) ? (v[0] ?? '') : v;
  }
  const out: Record<string, string> = {};
  for (const name of CODEX_HEADERS) {
    const value = lower[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export function classifyCodex(statusCode: number, headers: Record<string, string>, now: Date = new Date()): Observation {
  if (statusCode === 401) return { kind: 'auth_invalid' };

  if (statusCode === 429) {
    // A credit-based plan that has run out is exhausted, not rate limited:
    // waiting does not help, so rotation must move on rather than back off.
    if (parseBool(headers['x-codex-credits-unlimited']) === false && parseBool(headers['x-codex-credits-has-credits']) === false) {
      return { kind: 'quota_exhausted', resetsAt: relativeReset(headers['x-codex-primary-reset-after-seconds'], now) };
    }
    // A window at 100% is exhausted and reports when it refills.
    for (const window of ['primary', 'secondary'] as const) {
      const used = parseNumber(headers[`x-codex-${window}-used-percent`]);
      if (used !== null && used >= 100) {
        return { kind: 'quota_exhausted', resetsAt: relativeReset(headers[`x-codex-${window}-reset-after-seconds`], now) };
      }
    }
    return { kind: 'rate_limited', retryAfterSeconds: parseNumber(headers['retry-after']) };
  }

  if (statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 529) {
    return { kind: 'unavailable', retryAfterSeconds: parseNumber(headers['retry-after']) };
  }

  if (statusCode >= 200 && statusCode < 300) {
    const primary = parseNumber(headers['x-codex-primary-used-percent']);
    if (primary !== null) {
      const secondary = parseNumber(headers['x-codex-secondary-used-percent']);
      return {
        kind: 'usage',
        percent: primary, // ALREADY 0-100; do not scale
        resetsAt: relativeReset(headers['x-codex-primary-reset-after-seconds'], now),
        percent7d: secondary,
        resetsAt7d: relativeReset(headers['x-codex-secondary-reset-after-seconds'], now),
        // Codex plans are credit-based: there is no subscription-overage
        // concept, and running out is reported as a 429 instead.
        overageActive: false,
        overagePercent: 0,
      };
    }
  }

  return { kind: 'unknown', statusCode };
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** The backend sends Python-cased booleans. */
function parseBool(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/**
 * Seconds FROM NOW, not an epoch. A zero or absent value means "no window in
 * effect" (seen on usage-based plans) and must not become "resets right now",
 * which would make an exhausted account look instantly recoverable.
 */
function relativeReset(value: string | undefined, now: Date): Date | null {
  const seconds = parseNumber(value);
  if (seconds === null || seconds <= 0) return null;
  return new Date(now.getTime() + seconds * 1000);
}
