import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choose, observe, recoverExpired, cooldownDeadline, MAX_COOLDOWN_SECONDS } from '../src/core/router.ts';
import type { AccountRuntime, Snapshot } from '../src/core/router.ts';

const NOW = new Date('2026-09-20T12:00:00Z');

function account(id: string, over: Partial<AccountRuntime> = {}): AccountRuntime {
  return {
    id,
    priority: 1,
    switchThreshold: 95,
    state: 'eligible',
    usagePercent: null,
    usagePercent7d: null,
    cooldownUntil: null,
    resetsAt: null,
    resetsAt7d: null,
    overagePercent: 0,
    unretryableStreak: 0,
    ...over,
  };
}

const snap = (accounts: AccountRuntime[], currentId: string | null = null): Snapshot => ({ accounts, currentId });

// ---- choose ----

test('stays on the current account while it is eligible (sticky)', () => {
  const d = choose(snap([account('a'), account('b')], 'a'));
  assert.deepEqual(d, { accountId: 'a', reason: 'sticky' });
});

test('rotates away when the current account is no longer eligible', () => {
  const d = choose(snap([account('a', { state: 'exhausted' }), account('b')], 'a'));
  assert.deepEqual(d, { accountId: 'b', reason: 'rotated' });
});

test('lowest priority number wins', () => {
  const d = choose(snap([account('a', { priority: 5 }), account('b', { priority: 2 })]));
  assert.equal(d.accountId, 'b');
});

test('at equal priority, a known sooner reset is preferred', () => {
  const soon = new Date(NOW.getTime() + 60_000);
  const later = new Date(NOW.getTime() + 600_000);
  const d = choose(snap([account('a', { resetsAt: later }), account('b', { resetsAt: soon })]));
  assert.equal(d.accountId, 'b');
});

test('an unknown reset sorts last within its priority band, not first', () => {
  const soon = new Date(NOW.getTime() + 60_000);
  const d = choose(snap([account('a', { resetsAt: null }), account('b', { resetsAt: soon })]));
  assert.equal(d.accountId, 'b');
});

test('no eligible account reports none_available rather than picking a dead one', () => {
  const d = choose(snap([account('a', { state: 'exhausted' }), account('b', { state: 'auth_invalid' })], 'a'));
  assert.deepEqual(d, { accountId: null, reason: 'none_available' });
});

// ---- observe ----

test('usage below threshold keeps the account eligible', () => {
  const s = observe(snap([account('a')]), 'a', { kind: 'usage', percent: 40, resetsAt: null, percent7d: null, resetsAt7d: null, overageActive: false, overagePercent: 0 }, NOW);
  assert.equal(s.accounts[0]!.state, 'eligible');
  assert.equal(s.accounts[0]!.usagePercent, 40);
});

test('usage at or above threshold moves the account to draining', () => {
  const s = observe(snap([account('a', { switchThreshold: 95 })]), 'a', { kind: 'usage', percent: 95, resetsAt: null, percent7d: null, resetsAt7d: null, overageActive: false, overagePercent: 0 }, NOW);
  assert.equal(s.accounts[0]!.state, 'draining');
});

test('a bare rate limit never rotates away — it is a cooldown, not a state change', () => {
  const s = observe(snap([account('a')]), 'a', { kind: 'rate_limited', retryAfterSeconds: 30 }, NOW);
  assert.equal(s.accounts[0]!.state, 'cooldown');
  assert.equal(s.accounts[0]!.cooldownUntil?.getTime(), NOW.getTime() + 30_000);
});

test('REGRESSION: a usage snapshot with no reset header must not clobber a known reset', () => {
  // The Python version overwrote resetsAt with null whenever the header was
  // missing. Recovery requires a reset time to compare against, so a draining
  // account was stranded out of rotation until the process restarted.
  const known = new Date(NOW.getTime() + 300_000);
  const s = observe(
    snap([account('a', { resetsAt: known, switchThreshold: 95 })]),
    'a',
    { kind: 'usage', percent: 96, resetsAt: null, percent7d: null, resetsAt7d: null, overageActive: false, overagePercent: 0 },
    NOW,
  );
  assert.equal(s.accounts[0]!.state, 'draining');
  assert.equal(s.accounts[0]!.resetsAt?.getTime(), known.getTime(), 'known reset must survive a missing header');
});

test('observe never mutates the input snapshot', () => {
  const input = snap([account('a')]);
  observe(input, 'a', { kind: 'auth_invalid' }, NOW);
  assert.equal(input.accounts[0]!.state, 'eligible');
});

test('an unknown observation leaves state untouched', () => {
  const s = observe(snap([account('a', { usagePercent: 12 })]), 'a', { kind: 'unknown', statusCode: 418 }, NOW);
  assert.equal(s.accounts[0]!.state, 'eligible');
  assert.equal(s.accounts[0]!.usagePercent, 12);
});

// ---- backoff ----

test('a Retry-After is honoured in full', () => {
  assert.equal(cooldownDeadline(NOW, 45, 0).getTime(), NOW.getTime() + 45_000);
});

test('no Retry-After escalates exponentially from 30s', () => {
  assert.equal(cooldownDeadline(NOW, null, 1).getTime(), NOW.getTime() + 30_000);
  assert.equal(cooldownDeadline(NOW, null, 2).getTime(), NOW.getTime() + 60_000);
  assert.equal(cooldownDeadline(NOW, null, 3).getTime(), NOW.getTime() + 120_000);
});

test('backoff is capped at 30 minutes however long the streak', () => {
  assert.equal(cooldownDeadline(NOW, null, 99).getTime(), NOW.getTime() + MAX_COOLDOWN_SECONDS * 1000);
  assert.equal(cooldownDeadline(NOW, 99999, 0).getTime(), NOW.getTime() + MAX_COOLDOWN_SECONDS * 1000);
});

test('a Retry-After resets the escalation streak; its absence grows it', () => {
  let s = observe(snap([account('a')]), 'a', { kind: 'rate_limited', retryAfterSeconds: null }, NOW);
  assert.equal(s.accounts[0]!.unretryableStreak, 1);
  s = observe(s, 'a', { kind: 'rate_limited', retryAfterSeconds: null }, NOW);
  assert.equal(s.accounts[0]!.unretryableStreak, 2);
  s = observe(s, 'a', { kind: 'rate_limited', retryAfterSeconds: 10 }, NOW);
  assert.equal(s.accounts[0]!.unretryableStreak, 0);
});

test('a success resets the escalation streak', () => {
  let s = observe(snap([account('a', { unretryableStreak: 4 })]), 'a', { kind: 'rate_limited', retryAfterSeconds: null }, NOW);
  assert.equal(s.accounts[0]!.unretryableStreak, 5);
  s = observe(s, 'a', { kind: 'usage', percent: 10, resetsAt: null, percent7d: null, resetsAt7d: null, overageActive: false, overagePercent: 0 }, NOW);
  assert.equal(s.accounts[0]!.unretryableStreak, 0);
});

// ---- recovery ----

test('an expired cooldown returns the account to service', () => {
  const past = new Date(NOW.getTime() - 1000);
  const s = recoverExpired(snap([account('a', { state: 'cooldown', cooldownUntil: past })]), NOW);
  assert.equal(s.accounts[0]!.state, 'eligible');
  assert.equal(s.accounts[0]!.cooldownUntil, null);
});

test('a cooldown still in the future is left alone', () => {
  const future = new Date(NOW.getTime() + 60_000);
  const s = recoverExpired(snap([account('a', { state: 'cooldown', cooldownUntil: future })]), NOW);
  assert.equal(s.accounts[0]!.state, 'cooldown');
});

test('a refilled window returns an exhausted account to service and clears stale usage', () => {
  const past = new Date(NOW.getTime() - 1000);
  const s = recoverExpired(snap([account('a', { state: 'exhausted', resetsAt: past, usagePercent: 100 })]), NOW);
  assert.equal(s.accounts[0]!.state, 'eligible');
  assert.equal(s.accounts[0]!.usagePercent, null);
});

test('auth_invalid never self-recovers — it needs the user to re-run claude', () => {
  const past = new Date(NOW.getTime() - 1000);
  const s = recoverExpired(snap([account('a', { state: 'auth_invalid', resetsAt: past })]), NOW);
  assert.equal(s.accounts[0]!.state, 'auth_invalid');
});

// ---- the whole point ----

test('end to end: an exhausted account hands over and the session continues', () => {
  let s = snap([account('a', { priority: 1 }), account('b', { priority: 2 })], 'a');
  assert.equal(choose(s).accountId, 'a');

  s = observe(s, 'a', { kind: 'quota_exhausted', resetsAt: new Date(NOW.getTime() + 3600_000) }, NOW);
  const d = choose(s);
  assert.equal(d.accountId, 'b');
  assert.equal(d.reason, 'rotated');

  // ...and when a's window refills, it rejoins rotation on its own.
  const later = new Date(NOW.getTime() + 3600_001);
  s = recoverExpired(s, later);
  assert.equal(s.accounts[0]!.state, 'eligible');
});

test('an account that has started billing overage is taken out of rotation', () => {
  // The whole point of the tool is to spend included quota, not money. An
  // account in overage must hand over even though the request succeeded.
  const s = observe(
    snap([account('a'), account('b', { priority: 2 })], 'a'),
    'a',
    { kind: 'usage', percent: 100, resetsAt: null, percent7d: null, resetsAt7d: null, overageActive: true, overagePercent: 0 },
    NOW,
  );
  assert.equal(s.accounts[0]!.state, 'exhausted');
  assert.equal(choose(s).accountId, 'b', 'rotation must move to an account still inside its quota');
});

test('a disabled account never rejoins the pool on its own', () => {
  // Disabling is a user decision, not a quota condition. Recovery must not
  // silently undo it the way it does for an exhausted window.
  const past = new Date(NOW.getTime() - 1000);
  const s = recoverExpired(snap([account('a', { state: 'disabled', resetsAt: past, cooldownUntil: past })]), NOW);
  assert.equal(s.accounts[0]!.state, 'disabled');
  assert.equal(choose(s).accountId, null, 'and it is never chosen');
});

test('REGRESSION: an observation never puts a disabled account back in the pool', () => {
  // Refreshing usage probes every account, including disabled ones. A usage
  // observation sets state to eligible, so a background refresh silently
  // undid the user's decision to remove an account from the pool.
  const s = observe(
    snap([account('a', { state: 'disabled' })]),
    'a',
    { kind: 'usage', percent: 4, resetsAt: null, percent7d: 9, resetsAt7d: null, overageActive: false, overagePercent: 0 },
    NOW,
  );
  assert.equal(s.accounts[0]!.state, 'disabled', 'still out of the pool');
  assert.equal(s.accounts[0]!.usagePercent, 4, 'but its numbers still refresh');
  assert.equal(choose(s).accountId, null, 'and it is never chosen');
});

test('a disabled account is not revived by a quota or auth observation either', () => {
  for (const o of [
    { kind: 'quota_exhausted' as const, resetsAt: null },
    { kind: 'auth_invalid' as const },
    { kind: 'rate_limited' as const, retryAfterSeconds: 5 },
  ]) {
    const s = observe(snap([account('a', { state: 'disabled' })]), 'a', o, NOW);
    assert.equal(s.accounts[0]!.state, 'disabled', `${o.kind} must not change a disabled account`);
  }
});
