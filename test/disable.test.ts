/**
 * Disabling an account takes effect IMMEDIATELY, on the live pool.
 *
 * The bug: `setProfile()` marked the account `disabled` but left
 * `snapshot.currentId` pointing at it. `choose()` was right — it refuses a
 * non-eligible account — so the next request did rotate. What stayed wrong
 * was everything derived from `currentId`: the dashboard kept drawing the
 * disabled account as the active one, and the eventual hand-over was logged
 * as though it had been serving right up to that moment.
 *
 * Exercised through the real Gateway rather than the pure router, because
 * the router was never the broken half.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['UNIAGENTS_HOME'] = await mkdtemp(join(tmpdir(), 'uniagents-disable-'));

const { Gateway } = await import('../src/proxy/gateway.ts');
const { choose } = await import('../src/core/router.ts');

/** Install a two-account pool without touching a keychain or the network. */
function pooled() {
  const gateway = new Gateway();
  const snapshot = {
    currentId: 'A',
    accounts: [
      { id: 'A', priority: 1, switchThreshold: 98, state: 'eligible' as const,
        usagePercent: null, usagePercent7d: null, cooldownUntil: null,
        resetsAt: null, resetsAt7d: null, overagePercent: 0, unretryableStreak: 0 },
      { id: 'B', priority: 2, switchThreshold: 98, state: 'eligible' as const,
        usagePercent: null, usagePercent7d: null, cooldownUntil: null,
        resetsAt: null, resetsAt7d: null, overagePercent: 0, unretryableStreak: 0 },
    ],
  };
  // The pool is private state; a test is allowed to seed it.
  (gateway as unknown as { snapshot: typeof snapshot }).snapshot = snapshot;
  return gateway;
}

function snapshotOf(gateway: ReturnType<typeof pooled>) {
  return (gateway as unknown as { snapshot: Parameters<typeof choose>[0] }).snapshot;
}

test('REGRESSION: disabling the serving account clears it as active', async () => {
  const gateway = pooled();
  assert.equal(gateway.view().find((a) => a.id === 'A')?.active, true);

  await gateway.setProfile('A', { enabled: false });

  const a = gateway.view().find((v) => v.id === 'A')!;
  assert.equal(a.state, 'disabled');
  // The bug: this stayed true, so the page showed a disabled account serving.
  assert.equal(a.active, false, 'a disabled account must not be shown as active');
  assert.equal(snapshotOf(gateway).currentId, null);
});

test('the next request after a disable goes to the other account', async () => {
  const gateway = pooled();
  await gateway.setProfile('A', { enabled: false });

  assert.equal(choose(snapshotOf(gateway)).accountId, 'B');
});

test('disabling an account that is NOT serving leaves the active one alone', async () => {
  const gateway = pooled();
  await gateway.setProfile('B', { enabled: false });

  assert.equal(snapshotOf(gateway).currentId, 'A', 'the serving account is untouched');
  assert.equal(gateway.view().find((v) => v.id === 'A')?.active, true);
  assert.equal(choose(snapshotOf(gateway)).accountId, 'A');
});

test('re-enabling returns the account to rotation', async () => {
  const gateway = pooled();
  await gateway.setProfile('A', { enabled: false });
  await gateway.setProfile('A', { enabled: true });

  assert.equal(gateway.view().find((v) => v.id === 'A')?.state, 'eligible');
  // Priority 1, and nothing is sticky any more, so it serves again.
  assert.equal(choose(snapshotOf(gateway)).accountId, 'A');
});

test('disabling every account leaves nothing to serve rather than a stale pointer', async () => {
  const gateway = pooled();
  await gateway.setProfile('A', { enabled: false });
  await gateway.setProfile('B', { enabled: false });

  assert.equal(choose(snapshotOf(gateway)).accountId, null);
  assert.equal(snapshotOf(gateway).currentId, null);
  assert.equal(gateway.view().every((v) => !v.active), true);
});

test('REGRESSION: a non-inference path does not 503 when only Codex is eligible', async () => {
  // Claude Code calls /v1/models, /api/oauth/profile and friends while
  // starting up. These spend no quota, so quota state is irrelevant to them.
  //
  // The bug: they went through rotation. With both Claude accounts rate
  // limited, rotation picked Codex, `attemptCodex()` declines every
  // non-messages shape, the attempt loop ran out, and the CLI got a hard
  // 503 — then retried and stalled. Measured: ~9s to answer "hello" while
  // the inference call itself took 1.6s.
  const gateway = pooled();
  const snapshot = snapshotOf(gateway) as unknown as {
    accounts: { id: string; state: string }[];
    currentId: string | null;
  };
  // Both Claude accounts out of rotation, exactly as measured.
  snapshot.accounts[0]!.state = 'exhausted';
  snapshot.accounts[1]!.state = 'cooldown';

  let sentVia: string | null = null;
  // Stand in for the network: passthrough() must still pick a Claude
  // account and send, despite neither being eligible.
  (gateway as unknown as { credentialFor: (id: string) => Promise<unknown> }).credentialFor =
    async (id: string) => { sentVia = id; return null; };

  const result = await gateway.handle('GET', '/v1/models', {}, Buffer.alloc(0));

  assert.notEqual(sentVia, null, 'a quota-spent account must still serve a free endpoint');
  assert.notEqual(sentVia, 'codex:chatgpt', 'Codex cannot serve this shape');
  // credentialFor returned null for every account, so 503 is the honest
  // answer here — what matters is that it TRIED rather than declining on
  // quota state.
  assert.equal(result.status, 503);
});

test('an inference path still goes through rotation', async () => {
  const gateway = pooled();
  let rotated = false;
  (gateway as unknown as { credentialFor: (id: string) => Promise<unknown> }).credentialFor =
    async () => { rotated = true; return null; };

  await gateway.handle('POST', '/v1/messages', {}, Buffer.from('{}'));
  assert.equal(rotated, true, '/v1/messages must not bypass rotation');
});

// ---- what a PROBE is allowed to change ----

const { foldableFromProbe } = await import('../src/proxy/gateway.ts');

test('REGRESSION: a probe rate limit does not take an account out of rotation', () => {
  // The probe is a diagnostic: one synthetic request, sent before any real
  // traffic, on a model the session may not even use. Folding a 429 from it
  // into rotation state parked the account in cooldown — backing off to 30
  // minutes — without a single real request having been tried, and the
  // session spent itself on the slow Codex fallback instead.
  //
  // Measured on two accounts in different organisations: the cheap probe
  // model answered 200 five times out of five while the session's model
  // answered 429 ten out of ten, on the same credential. Either direction is
  // the wrong thing to act on before real traffic.
  assert.equal(foldableFromProbe({ kind: 'rate_limited', retryAfterSeconds: null }), false);
  assert.equal(foldableFromProbe({ kind: 'unavailable', retryAfterSeconds: 30 }), false);
});

test('a probe may still report usage and a rejected credential', () => {
  // The guard must drop only load-shaped answers. Usage is what the stats
  // page exists to show and takes nothing out of service; a rejected
  // credential is a fact about the account, not about load.
  assert.equal(
    foldableFromProbe({
      kind: 'usage', percent: 42, resetsAt: null, percent7d: null,
      resetsAt7d: null, overageActive: false, overagePercent: 0,
    }),
    true,
  );
  assert.equal(foldableFromProbe({ kind: 'auth_invalid' }), true);
});
