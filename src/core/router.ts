/**
 * Pure rotation logic. No I/O, no credentials, no network, no clock of its own.
 *
 * `choose()` picks which account serves the next request. `observe()` folds an
 * Observation into updated per-account state. `recoverExpired()` returns
 * accounts to service when their window has refilled. Everything is passed in,
 * which is what keeps this deterministically testable.
 *
 * Rules:
 *   - Sticky: stay on the current account until it is spent — unless a
 *     HIGHER-priority account has recovered, which reclaims it.
 *   - A bare rate limit is a cooldown, NEVER a rotation away.
 *   - Tie-break: lowest priority number wins; then soonest known reset.
 */

import type { Observation } from './observation.ts';

export type AccountState =
  | 'eligible'
  | 'draining' // threshold crossed; finish in-flight work, take no new requests
  | 'exhausted' // hard quota
  | 'cooldown' // short rate limit or provider unavailable; temporary
  | 'auth_invalid' // needs the user to re-run `claude`
  | 'disabled'; // the user took it out of the pool; never self-recovers

export interface AccountRuntime {
  id: string;
  priority: number;
  switchThreshold: number;
  state: AccountState;
  usagePercent: number | null;
  usagePercent7d: number | null;
  cooldownUntil: Date | null;
  resetsAt: Date | null;
  resetsAt7d: Date | null;
  /** Percent into paid overage, which is why an account can be out of
   *  rotation while its window still shows headroom. */
  overagePercent: number;
  /**
   * Consecutive rate-limit/unavailable observations that carried NO
   * Retry-After, driving the backoff escalation. Reset by any success, or by
   * an observation that does carry a Retry-After.
   */
  unretryableStreak: number;
}

export interface Snapshot {
  accounts: AccountRuntime[];
  currentId: string | null;
}

export interface Decision {
  accountId: string | null;
  reason: 'sticky' | 'rotated' | 'none_available';
}

export const MAX_COOLDOWN_SECONDS = 1800;
const BASE_BACKOFF_SECONDS = 30;

export function choose(snapshot: Snapshot): Decision {
  const current = snapshot.accounts.find((a) => a.id === snapshot.currentId);
  const candidates = snapshot.accounts.filter((a) => a.state === 'eligible');
  if (candidates.length === 0) return { accountId: null, reason: 'none_available' };

  // Sticky — but only against accounts of EQUAL OR LOWER preference.
  //
  // Staying put is right when the alternatives are peers: rotating on a blip
  // abandons a healthy account for no gain. It is wrong when an account the
  // user ranked HIGHER has come back. Measured: once the pool fell through
  // to the Codex fallback, it served the rest of the session from there even
  // after the preferred Claude account left cooldown — every request paying
  // the slow translated path while the fast one sat idle.
  //
  // So stay on the current account unless something strictly preferred is
  // now available.
  if (current && current.state === 'eligible') {
    const better = candidates.some((a) => a.priority < current.priority);
    if (!better) return { accountId: current.id, reason: 'sticky' };
  }

  // Lowest priority number first; then prefer an account with a known, sooner
  // reset (spend the one about to refill anyway). Unknown resets sort last
  // within their band, not first.
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const ax = a.resetsAt === null ? 1 : 0;
    const bx = b.resetsAt === null ? 1 : 0;
    if (ax !== bx) return ax - bx;
    if (a.resetsAt && b.resetsAt) return a.resetsAt.getTime() - b.resetsAt.getTime();
    return 0;
  });

  return { accountId: candidates[0]!.id, reason: 'rotated' };
}

/** Returns a NEW snapshot; the input is never mutated. */
export function observe(snapshot: Snapshot, accountId: string, observation: Observation, now: Date): Snapshot {
  return {
    currentId: snapshot.currentId,
    accounts: snapshot.accounts.map((a) => (a.id === accountId ? apply(a, observation, now) : a)),
  };
}

function apply(a: AccountRuntime, o: Observation, now: Date): AccountRuntime {
  // A disabled account is a user decision. An observation may still refresh
  // its numbers — the dashboard shows usage for accounts out of the pool —
  // but nothing an observation says may put it back into rotation.
  if (a.state === 'disabled') {
    return o.kind === 'usage'
      ? {
          ...a,
          usagePercent: o.percent,
          usagePercent7d: o.percent7d,
          resetsAt: o.resetsAt ?? a.resetsAt,
          resetsAt7d: o.resetsAt7d ?? a.resetsAt7d,
          overagePercent: o.overagePercent,
        }
      : a;
  }

  switch (o.kind) {
    case 'usage':
      return {
        ...a,
        // Overage is PAID usage: once a window is spent, Anthropic does not
        // reject the request, it bills the org's API spend instead. Treat
        // that as exhausted so rotation moves to an account still inside its
        // included quota, rather than quietly spending money.
        state: o.overageActive ? 'exhausted' : o.percent >= a.switchThreshold ? 'draining' : 'eligible',
        usagePercent: o.percent,
        usagePercent7d: o.percent7d,
        // Only overwrite a known reset time with another known one. The Python
        // version clobbered this with null whenever the header was missing,
        // which stranded a draining account out of rotation until restart,
        // because recovery requires a reset time to compare against.
        resetsAt: o.resetsAt ?? a.resetsAt,
        resetsAt7d: o.resetsAt7d ?? a.resetsAt7d,
        overagePercent: o.overagePercent,
        unretryableStreak: 0, // a success: this account works again
      };

    case 'quota_exhausted':
      return { ...a, state: 'exhausted', resetsAt: o.resetsAt ?? a.resetsAt };

    case 'rate_limited':
    case 'unavailable': {
      // A headerless 429 is only a spend cap when the account is ACTUALLY
      // spent. Measured: both pooled accounts returned 429 for Sonnet and
      // Opus while returning 200 for Haiku on the same credential, with the
      // five-hour window at 5% and 27% and `locked_reason: null`. That is a
      // model being unavailable, not an account being out of quota — but the
      // escalating backoff buried an account with 95% of its window left for
      // up to 30 minutes, and the session fell through to the slow fallback.
      //
      // So the streak only escalates when the account looks genuinely spent.
      // With known headroom the cooldown stays at the base step, which is
      // long enough to stop a hot loop and short enough that the account
      // comes back for the next request.
      const hasHeadroom = a.usagePercent !== null && a.usagePercent < a.switchThreshold;
      const streak = o.retryAfterSeconds !== null || hasHeadroom ? 0 : a.unretryableStreak + 1;
      return {
        ...a,
        state: 'cooldown',
        cooldownUntil: cooldownDeadline(now, o.retryAfterSeconds, streak),
        unretryableStreak: streak,
      };
    }

    case 'auth_invalid':
      return { ...a, state: 'auth_invalid' };

    case 'unknown':
      return a;
  }
}

/** Move cooled-down / refilled accounts back to eligible. Call before choose(). */
export function recoverExpired(snapshot: Snapshot, now: Date): Snapshot {
  return {
    currentId: snapshot.currentId,
    accounts: snapshot.accounts.map((a) => {
      // A disabled account is a user decision, not a quota condition: no
      // amount of waiting should put it back in the pool.
      if (a.state === 'disabled') return a;
      if (a.state === 'cooldown' && a.cooldownUntil && now >= a.cooldownUntil) {
        return { ...a, state: 'eligible', cooldownUntil: null };
      }
      if ((a.state === 'exhausted' || a.state === 'draining') && a.resetsAt && now >= a.resetsAt) {
        return { ...a, state: 'eligible', resetsAt: null, usagePercent: null };
      }
      return a;
    }),
  };
}

/**
 * A Retry-After is a trustworthy signal and is honoured in full (capped only
 * defensively). NO Retry-After on a 429 is, per Anthropic's docs, what a
 * spend-cap/billing rejection looks like — it keeps failing until access
 * resumes. A flat retry would hammer it forever, so back off exponentially
 * from 30s, doubling per consecutive failure, capped at 30 minutes. A
 * transient blip self-heals in a step or two; a stuck account reaches the
 * ceiling in about six.
 */
export function cooldownDeadline(now: Date, retryAfterSeconds: number | null, streak: number): Date {
  // streak 0 means "no escalation": either a Retry-After was given, or the
  // account still has quota and this was not a spend cap.
  const seconds =
    retryAfterSeconds !== null
      ? Math.min(retryAfterSeconds, MAX_COOLDOWN_SECONDS)
      : streak === 0
        ? BASE_BACKOFF_SECONDS
        : Math.min(BASE_BACKOFF_SECONDS * 2 ** Math.max(0, streak - 1), MAX_COOLDOWN_SECONDS);
  return new Date(now.getTime() + seconds * 1000);
}
