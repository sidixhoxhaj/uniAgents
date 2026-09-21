/**
 * End-to-end rotation against a real HTTP upstream.
 *
 * This is the test that proves the product claim: when one account hits its
 * limit, the session does not. It also proves the invariant that makes that
 * possible — a rotated-away response must never have leaked a body byte to
 * the client.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { classify, filterResponseHeaders } from '../src/core/observation.ts';
import { choose, observe, recoverExpired } from '../src/core/router.ts';
import type { Snapshot } from '../src/core/router.ts';

/** Minimal stand-in for the gateway loop, exercising the real core modules. */
async function runRotation(
  snapshot: Snapshot,
  send: (accountId: string) => Promise<{ status: number; headers: Record<string, string>; readBody: () => string }>,
) {
  const attempted = new Set<string>();
  const bodiesRead: string[] = [];

  for (let i = 0; i < 4; i++) {
    snapshot = recoverExpired(snapshot, new Date());
    const decision = choose(snapshot);
    if (decision.accountId === null || attempted.has(decision.accountId)) break;
    attempted.add(decision.accountId);

    const res = await send(decision.accountId);
    const observation = classify(res.status, filterResponseHeaders(res.headers));
    snapshot = observe(snapshot, decision.accountId, observation, new Date());

    if (
      observation.kind === 'quota_exhausted' ||
      observation.kind === 'auth_invalid' ||
      observation.kind === 'rate_limited' ||
      observation.kind === 'unavailable'
    ) {
      continue; // discarded WITHOUT reading the body
    }
    bodiesRead.push(res.readBody()); // committing
    return { served: decision.accountId, snapshot, bodiesRead, attempted: [...attempted] };
  }
  return { served: null, snapshot, bodiesRead, attempted: [...attempted] };
}

function account(id: string, priority: number) {
  return {
    id, priority, switchThreshold: 98, state: 'eligible' as const,
    usagePercent: null, usagePercent7d: null, cooldownUntil: null,
    resetsAt: null, resetsAt7d: null, overagePercent: 0, unretryableStreak: 0,
  };
}

test('a spent account hands over mid-session and the client never sees the failure', async () => {
  const server = http.createServer((req, res) => {
    if (req.headers['x-test-account'] === 'a') {
      // Account A is out of quota for the 5h window.
      res.writeHead(429, {
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
      });
      res.end('QUOTA-ERROR-BODY-MUST-NOT-REACH-CLIENT');
      return;
    }
    res.writeHead(200, {
      'anthropic-ratelimit-unified-5h-utilization': '0.12',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 7200),
    });
    res.end('REAL-ANSWER');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  try {
    const result = await runRotation(
      { accounts: [account('a', 1), account('b', 2)], currentId: 'a' },
      (accountId) =>
        new Promise((resolve, reject) => {
          const req = http.request(
            { port, host: '127.0.0.1', path: '/v1/messages', method: 'POST', headers: { 'x-test-account': accountId } },
            (res) => {
              // Resolve on HEADERS, body deliberately unread — this mirrors
              // the real transport and is what makes rotation invisible.
              resolve({
                status: res.statusCode!,
                headers: res.headers as Record<string, string>,
                readBody: () => {
                  res.resume();
                  return 'READ';
                },
              });
            },
          );
          req.on('error', reject);
          req.end();
        }),
    );

    assert.equal(result.served, 'b', 'the request should be served by the second account');
    assert.deepEqual(result.attempted, ['a', 'b']);
    assert.equal(result.bodiesRead.length, 1, 'exactly one body may be committed');
    assert.equal(result.snapshot.accounts.find((x) => x.id === 'a')!.state, 'exhausted');
    assert.equal(result.snapshot.accounts.find((x) => x.id === 'b')!.state, 'eligible');
    assert.equal(result.snapshot.accounts.find((x) => x.id === 'b')!.usagePercent, 12);
  } finally {
    server.close();
  }
});

test('when every account is spent the caller gets a clear failure, not a hang', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(429, {
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
    });
    res.end('nope');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  try {
    const result = await runRotation(
      { accounts: [account('a', 1), account('b', 2)], currentId: 'a' },
      () =>
        new Promise((resolve, reject) => {
          const req = http.request({ port, host: '127.0.0.1', path: '/v1/messages', method: 'POST' }, (res) => {
            resolve({
              status: res.statusCode!,
              headers: res.headers as Record<string, string>,
              readBody: () => { res.resume(); return 'READ'; },
            });
          });
          req.on('error', reject);
          req.end();
        }),
    );

    assert.equal(result.served, null);
    assert.equal(result.bodiesRead.length, 0, 'no body may be committed when nothing could serve');
    assert.ok(result.snapshot.accounts.every((a) => a.state === 'exhausted'));
  } finally {
    server.close();
  }
});

test('a rate limit cools the account down but does NOT rotate away from it', async () => {
  // A brief 429 with no per-window rejection is a blip, not exhaustion. Rotating
  // on it would abandon a perfectly good account.
  const s = observe(
    { accounts: [account('a', 1), account('b', 2)], currentId: 'a' },
    'a',
    classify(429, { 'retry-after': '2' }),
    new Date(),
  );
  assert.equal(s.accounts[0]!.state, 'cooldown');
  // Still the current account; it simply is not eligible until the cooldown ends.
  assert.equal(s.currentId, 'a');
  assert.equal(choose(s).accountId, 'b', 'meanwhile another account serves');

  const later = new Date(Date.now() + 3000);
  const recovered = recoverExpired(s, later);
  assert.equal(recovered.accounts[0]!.state, 'eligible', 'and it returns on its own');
});

test('REGRESSION: a rate-limited account falls through instead of failing the request', async () => {
  // A spend-capped account 429s with NO rate-limit headers on every request,
  // which classifies as a bare `rate_limited`. That put the account into
  // cooldown but then COMMITTED the 429 to the client, so the session failed
  // while a healthy account sat idle beside it. Measured against two real
  // accounts in exactly that state.
  const server = http.createServer((req, res) => {
    if (req.headers['x-test-account'] === 'a') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
      return;
    }
    res.writeHead(200, { 'anthropic-ratelimit-unified-5h-utilization': '0.2' });
    res.end('served by B');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  try {
    const result = await runRotation(
      { accounts: [account('a', 1), account('b', 2)], currentId: null },
      async (accountId) => {
        const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST',
          headers: { 'x-test-account': accountId },
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = v));
        return { status: res.status, headers, readBody: () => String(res.status) };
      },
    );

    assert.equal(result.served, 'b', 'the healthy account must answer');
    assert.deepEqual(result.attempted, ['a', 'b'], 'a was tried, then handed over');
  } finally {
    server.close();
  }
});
