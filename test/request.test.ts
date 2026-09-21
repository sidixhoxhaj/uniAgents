import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpstreamRequest, rewriteAccountUuid, filterOutboundResponseHeaders } from '../src/proxy/request.ts';

const base = { accessToken: 'tok', method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.alloc(0) };

test('accept-encoding is stripped, or usage numbers become unreadable', () => {
  // Compressed bodies forward fine but nothing can parse the usage out of
  // them, so every window would silently report 0% and rotation never fires.
  const req = buildUpstreamRequest({ ...base, headers: { 'accept-encoding': 'gzip, br', 'x-keep': 'yes' } });
  assert.equal(req.headers['accept-encoding'], undefined);
  assert.equal(req.headers['x-keep'], 'yes');
});

test('inbound credentials and hop-by-hop headers are stripped', () => {
  const req = buildUpstreamRequest({
    ...base,
    headers: { authorization: 'Bearer leaked', 'x-api-key': 'sk-leaked', host: 'localhost', connection: 'keep-alive' },
  });
  assert.equal(req.headers['x-api-key'], undefined);
  assert.equal(req.headers['host'], undefined);
  assert.equal(req.headers['connection'], undefined);
  assert.equal(req.headers['Authorization'], 'Bearer tok'); // replaced, not passed through
});

test('an oversized body is refused rather than proxied', () => {
  assert.throws(() => buildUpstreamRequest({ ...base, body: Buffer.alloc(20_000_001) }), /too large/);
});

test('account_uuid rewrite preserves every sibling field', () => {
  // user_id is a JSON-ENCODED STRING holding account_uuid alongside a session
  // id that must survive. It is not a bare uuid.
  const body = Buffer.from(JSON.stringify({
    model: 'claude-opus-5',
    metadata: { user_id: JSON.stringify({ account_uuid: 'OLD', session_id: 'keep-me' }) },
  }));
  const out = JSON.parse(rewriteAccountUuid(body, 'NEW').toString());
  const userId = JSON.parse(out.metadata.user_id);
  assert.equal(userId.account_uuid, 'NEW');
  assert.equal(userId.session_id, 'keep-me', 'sibling fields must survive the rewrite');
  assert.equal(out.model, 'claude-opus-5');
});

test('unrecognised body shapes pass through untouched rather than being guessed at', () => {
  for (const body of [
    Buffer.from('not json at all'),
    Buffer.from(JSON.stringify({ no: 'metadata' })),
    Buffer.from(JSON.stringify({ metadata: { user_id: 'a-bare-string-not-json' } })),
    Buffer.from(JSON.stringify({ metadata: { user_id: JSON.stringify({ no_account_uuid: 1 }) } })),
  ]) {
    assert.equal(rewriteAccountUuid(body, 'NEW').toString(), body.toString());
  }
});

test('account_uuid is only rewritten on /v1/messages', () => {
  const body = Buffer.from(JSON.stringify({ metadata: { user_id: JSON.stringify({ account_uuid: 'OLD' }) } }));
  const req = buildUpstreamRequest({ ...base, path: '/v1/models', body, accountUuid: 'NEW' });
  assert.ok(req.body.toString().includes('OLD'));
});

test('Content-Length is recomputed only when the body actually changed', () => {
  const body = Buffer.from(JSON.stringify({ metadata: { user_id: JSON.stringify({ account_uuid: 'OLD' }) } }));
  const rewritten = buildUpstreamRequest({ ...base, body, accountUuid: 'NEW' });
  assert.equal(rewritten.headers['Content-Length'], String(rewritten.body.length));

  const untouched = buildUpstreamRequest({ ...base, body: Buffer.from('{}') });
  assert.equal(untouched.headers['Content-Length'], undefined);
});

test('upstream infrastructure headers never reach the client', () => {
  const out = filterOutboundResponseHeaders({
    'content-type': 'text/event-stream',
    'set-cookie': 'session=secret',
    'cf-ray': 'abc',
    server: 'cloudflare',
    'content-length': '123',
    'transfer-encoding': 'chunked',
  });
  assert.equal(out['content-type'], 'text/event-stream');
  for (const gone of ['set-cookie', 'cf-ray', 'server', 'content-length', 'transfer-encoding']) {
    assert.equal(out[gone], undefined, `${gone} must not be relayed`);
  }
});
