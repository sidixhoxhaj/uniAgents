import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, filterResponseHeaders } from '../src/core/observation.ts';

test('401 is auth_invalid', () => {
  assert.equal(classify(401, {}).kind, 'auth_invalid');
});

test('403 is NOT auth_invalid — it is a permission error, usually an unscoped model', () => {
  // Conflating 403 with 401 reports "needs re-authentication" over a model choice.
  const o = classify(403, {});
  assert.equal(o.kind, 'unknown');
  assert.equal(o.kind === 'unknown' && o.statusCode, 403);
});

test('429 with 5h rejected is quota_exhausted, carrying that window reset', () => {
  const o = classify(429, {
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': '1787191800',
  });
  assert.equal(o.kind, 'quota_exhausted');
  assert.equal(o.kind === 'quota_exhausted' && o.resetsAt?.getTime(), 1787191800 * 1000);
});

test('429 with only 7d rejected is still quota_exhausted — windows are independent', () => {
  // Collapsing the two windows misreads a weekly-cap rejection as a short rate
  // limit, so we would cool down and retry the same dead account.
  const o = classify(429, {
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-status': 'rejected',
    'anthropic-ratelimit-unified-7d-reset': '1787191800',
  });
  assert.equal(o.kind, 'quota_exhausted');
});

test('429 with neither window rejected is a bare rate limit', () => {
  const o = classify(429, { 'retry-after': '30' });
  assert.equal(o.kind, 'rate_limited');
  assert.equal(o.kind === 'rate_limited' && o.retryAfterSeconds, 30);
});

test('429 with no Retry-After reports null, so the caller escalates backoff', () => {
  const o = classify(429, {});
  assert.equal(o.kind, 'rate_limited');
  assert.equal(o.kind === 'rate_limited' && o.retryAfterSeconds, null);
});

test('503 and 529 are unavailable', () => {
  assert.equal(classify(503, {}).kind, 'unavailable');
  assert.equal(classify(529, {}).kind, 'unavailable');
});

test('2xx with 5h utilization is a usage snapshot; utilization is a 0-1 float', () => {
  const o = classify(200, {
    'anthropic-ratelimit-unified-5h-utilization': '0.61',
    'anthropic-ratelimit-unified-5h-reset': '1787191800',
    'anthropic-ratelimit-unified-7d-utilization': '0.205',
  });
  assert.equal(o.kind, 'usage');
  assert.equal(o.kind === 'usage' && o.percent, 61);
  assert.equal(o.kind === 'usage' && o.percent7d, 20.5);
});

test('reset headers parse as Unix epoch seconds, not ISO 8601', () => {
  const o = classify(200, {
    'anthropic-ratelimit-unified-5h-utilization': '0.1',
    'anthropic-ratelimit-unified-5h-reset': '1787191800',
  });
  // 1787191800 as epoch SECONDS. Parsed as milliseconds it would be 1970.
  assert.equal(o.kind === 'usage' && o.resetsAt?.getUTCFullYear(), 2026);
});

test('2xx without utilization headers is unknown, not a fake 0% snapshot', () => {
  // Reporting 0% here would make a spent account look permanently fresh.
  assert.equal(classify(200, {}).kind, 'unknown');
});

test('malformed numbers do not throw or produce NaN', () => {
  const o = classify(200, { 'anthropic-ratelimit-unified-5h-utilization': 'not-a-number' });
  assert.equal(o.kind, 'unknown');
});

test('filterResponseHeaders lowercases and drops anything not allowlisted', () => {
  const out = filterResponseHeaders({
    'Anthropic-RateLimit-Unified-5h-Utilization': '0.5',
    'Set-Cookie': 'session=secret',
    'CF-Ray': 'abc123',
  });
  assert.deepEqual(out, { 'anthropic-ratelimit-unified-5h-utilization': '0.5' });
});

test('filterResponseHeaders takes the first value of a repeated header', () => {
  const out = filterResponseHeaders({ 'retry-after': ['30', '60'] });
  assert.equal(out['retry-after'], '30');
});

// ---- overage: the difference between "included" and "costing money" ----

test('overage in use marks the account exhausted, not merely draining', () => {
  // Anthropic does NOT reject a request when a subscription window fills — it
  // spills into overage, billed to the org's API spend. That is invisible in
  // the utilization percentage, so it is the only signal that separates
  // included quota from real money.
  const o = classify(200, {
    'anthropic-ratelimit-unified-5h-utilization': '1.0',
    'anthropic-ratelimit-unified-overage-utilization': '0.04',
  });
  assert.equal(o.kind, 'usage');
  assert.equal(o.kind === 'usage' && o.overageActive, true);
});

test('zero overage is not overage', () => {
  const o = classify(200, {
    'anthropic-ratelimit-unified-5h-utilization': '0.57',
    'anthropic-ratelimit-unified-overage-utilization': '0.0',
  });
  assert.equal(o.kind === 'usage' && o.overageActive, false);
});

test('an account on a plan without overage reports none', () => {
  const o = classify(200, { 'anthropic-ratelimit-unified-5h-utilization': '0.5' });
  assert.equal(o.kind === 'usage' && o.overageActive, false);
});
