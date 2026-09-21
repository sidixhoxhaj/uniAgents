/**
 * Transport-level guarantees. The no-retry-after-commit invariant itself is
 * proven end to end in server.test.ts against a real HTTP upstream.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { sendUpstream, UpstreamError } from '../src/proxy/upstream.ts';

test('a non-https upstream is refused outright — a credential must never go over http', async () => {
  await assert.rejects(
    () => sendUpstream({ url: 'http://api.anthropic.com/v1/messages', method: 'POST', headers: {}, body: Buffer.alloc(0) }),
    /refusing to send upstream over http:/,
  );
});

test('a refused connection surfaces as UpstreamError, not a raw socket error', async () => {
  // Every transport failure must normalise to ONE error type. The Python
  // version had two exception classes and a retry path that caught only one,
  // which leaked in-flight state on the other.
  await assert.rejects(
    () => sendUpstream({ url: 'https://127.0.0.1:1/v1/messages', method: 'POST', headers: {}, body: Buffer.alloc(0) }, 2000),
    (err: unknown) => {
      assert.ok(err instanceof UpstreamError, `expected UpstreamError, got ${(err as Error).name}`);
      return true;
    },
  );
});

test('a failed TLS handshake also normalises to UpstreamError', async () => {
  const server = https.createServer({}, () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(
      () => sendUpstream({ url: `https://127.0.0.1:${port}/x`, method: 'GET', headers: {}, body: Buffer.alloc(0) }, 1500),
      (err: unknown) => err instanceof UpstreamError,
    );
  } finally {
    server.close();
  }
});
