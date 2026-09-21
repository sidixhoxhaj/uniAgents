/**
 * Classifies an upstream response into an explicit Observation.
 *
 * Pure and deterministic. Takes ONLY the status code and an allowlist of
 * response headers — never a response body. That is precisely what lets the
 * proxy forward bodies as opaque streams while still making rotation
 * decisions from structured data.
 *
 * See docs/PROTOCOL.md for the wire-format facts this file depends on.
 */

export type Observation =
  | {
      kind: 'usage';
      percent: number;
      resetsAt: Date | null;
      percent7d: number | null;
      resetsAt7d: Date | null;
      /**
       * Overage is PAID usage billed to the account's API spend once the
       * included subscription window is used up. Anthropic does not reject a
       * request when the window fills — it silently spills into overage — so
       * this is the only signal that distinguishes "still included" from
       * "now costing money".
       */
      overageActive: boolean;
      /** How far into paid overage, 0-100. Zero when none is in use. */
      overagePercent: number;
    }
  | { kind: 'quota_exhausted'; resetsAt: Date | null }
  | { kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { kind: 'unavailable'; retryAfterSeconds: number | null }
  | { kind: 'auth_invalid' }
  | { kind: 'unknown'; statusCode: number };

/**
 * The unified rate-limit headers Anthropic returns, and their wire format:
 *
 *   anthropic-ratelimit-unified-5h-status:      allowed | rejected
 *   anthropic-ratelimit-unified-5h-reset:       1787191800   Unix EPOCH SECONDS, not ISO 8601
 *   anthropic-ratelimit-unified-5h-utilization: 0.61         0-1 FLOAT, not a remaining/limit pair
 *   anthropic-ratelimit-unified-7d-*:           same shapes
 *
 * Getting these shapes wrong is silent: a mis-parsed utilization reads as 0%
 * and the account looks permanently fresh.
 */
export const ALLOWED_HEADERS = [
  'anthropic-ratelimit-unified-status',
  'anthropic-ratelimit-unified-5h-status',
  'anthropic-ratelimit-unified-5h-utilization',
  'anthropic-ratelimit-unified-5h-reset',
  'anthropic-ratelimit-unified-7d-status',
  'anthropic-ratelimit-unified-7d-utilization',
  'anthropic-ratelimit-unified-7d-reset',
  'anthropic-ratelimit-unified-reset',
  'anthropic-ratelimit-unified-overage-status',
  'anthropic-ratelimit-unified-overage-utilization',
  'retry-after',
] as const;

/** Restrict arbitrary response headers to the allowlist, lowercased. */
export function filterResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    lower[k.toLowerCase()] = Array.isArray(v) ? (v[0] ?? '') : v;
  }
  const out: Record<string, string> = {};
  for (const name of ALLOWED_HEADERS) {
    const value = lower[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * `headers` must already be lowercased and restricted to ALLOWED_HEADERS by
 * the caller — this function does not filter.
 */
export function classify(statusCode: number, headers: Record<string, string>): Observation {
  if (statusCode === 401) return { kind: 'auth_invalid' };

  // 403 is deliberately NOT auth_invalid. 401 (authentication_error) means the
  // credential is rejected; 403 (permission_error) means the credential is
  // valid but not allowed to do this specific thing — usually a model it isn't
  // scoped for. Treating them alike reports "needs re-authentication" over a
  // model choice. It falls through to `unknown`, which is relayed untouched.
  if (statusCode === 429) {
    // The two windows are checked INDEPENDENTLY, not as `5h or 7d`. An account
    // can have 5h headroom while the weekly cap is what rejected the request.
    // Collapsing them misclassifies quota exhaustion as a bare rate limit, and
    // we would cool down and retry the same dead account instead of rotating.
    if (headers['anthropic-ratelimit-unified-5h-status'] === 'rejected') {
      return { kind: 'quota_exhausted', resetsAt: parseReset(headers['anthropic-ratelimit-unified-5h-reset']) };
    }
    if (headers['anthropic-ratelimit-unified-7d-status'] === 'rejected') {
      return { kind: 'quota_exhausted', resetsAt: parseReset(headers['anthropic-ratelimit-unified-7d-reset']) };
    }
    return { kind: 'rate_limited', retryAfterSeconds: parseFloatOrNull(headers['retry-after']) };
  }

  if (statusCode === 503 || statusCode === 529) {
    return { kind: 'unavailable', retryAfterSeconds: parseFloatOrNull(headers['retry-after']) };
  }

  if (statusCode >= 200 && statusCode < 300) {
    const utilization = parseFloatOrNull(headers['anthropic-ratelimit-unified-5h-utilization']);
    if (utilization !== null) {
      const utilization7d = parseFloatOrNull(headers['anthropic-ratelimit-unified-7d-utilization']);
      const overage = parseFloatOrNull(headers['anthropic-ratelimit-unified-overage-utilization']);
      return {
        kind: 'usage',
        percent: round2(utilization * 100),
        resetsAt: parseReset(headers['anthropic-ratelimit-unified-5h-reset']),
        percent7d: utilization7d === null ? null : round2(utilization7d * 100),
        resetsAt7d: parseReset(headers['anthropic-ratelimit-unified-7d-reset']),
        // Any overage at all means this account has started costing money.
        overageActive: overage !== null && overage > 0,
        overagePercent: overage === null ? 0 : round2(overage * 100),
      };
    }
  }

  return { kind: 'unknown', statusCode };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseFloatOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Anthropic sends Unix epoch seconds; ISO 8601 is accepted as a fallback. */
function parseReset(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const epoch = Number.parseFloat(value);
  if (Number.isFinite(epoch)) {
    const d = new Date(epoch * 1000);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const iso = new Date(value);
  return Number.isNaN(iso.getTime()) ? null : iso;
}
