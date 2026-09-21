/**
 * Token counting off a real SSE body.
 *
 * The bug these guard: input arrives as THREE fields once prompt caching is
 * on, and the counter read only one of them. Measured against a live account
 * on 2026-09-21, a 2036-token system prompt reported input_tokens 9 with the
 * other 2027 in cache_creation — so 99.6% of billable input scored as zero,
 * understating every window the router reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { countingTee, type CountedUsage } from '../src/proxy/usage.ts';

/** Feed `chunks` through the tee; return what was counted and what came out. */
async function run(chunks: string[]): Promise<{ usage: CountedUsage; forwarded: string }> {
  let usage: CountedUsage = { inputTokens: -1, outputTokens: -1 };
  const tee = countingTee((u) => { usage = u; });
  const out: Buffer[] = [];
  await pipeline(
    Readable.from(chunks.map((c) => Buffer.from(c, 'utf8'))),
    tee,
    async function* (src) { for await (const c of src) out.push(c as Buffer); },
  );
  return { usage, forwarded: Buffer.concat(out).toString('utf8') };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// The exact shapes captured from the live API, 2026-09-21.
const CACHE_WRITE = sse('message_start', {
  type: 'message_start',
  message: { usage: { input_tokens: 9, cache_creation_input_tokens: 2027, cache_read_input_tokens: 0, output_tokens: 5 } },
});
const CACHE_WRITE_DELTA = sse('message_delta', {
  type: 'message_delta',
  usage: { input_tokens: 9, cache_creation_input_tokens: 2027, cache_read_input_tokens: 0, output_tokens: 5 },
});

test('cached input is counted — the 99.6% that used to vanish', async () => {
  const { usage } = await run([CACHE_WRITE, CACHE_WRITE_DELTA]);
  // 9 + 2027 + 0. Reading input_tokens alone gave 9.
  assert.equal(usage.inputTokens, 2036);
  assert.equal(usage.outputTokens, 5);
});

test('cache reads count too — a cache hit is still billable input', async () => {
  const { usage } = await run([
    sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 2027, output_tokens: 3 } } }),
    sse('message_delta', { type: 'message_delta', usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 2027, output_tokens: 3 } }),
  ]);
  assert.equal(usage.inputTokens, 2036);
});

test('message_delta revises the final counts — the last event wins', async () => {
  // Both events carry input. A delta that revises downward must not be
  // ignored, which a truthiness guard on the first value would do.
  const { usage } = await run([
    sse('message_start', { message: { usage: { input_tokens: 100, output_tokens: 1 } } }),
    sse('message_delta', { type: 'message_delta', usage: { input_tokens: 40, output_tokens: 900 } }),
  ]);
  assert.equal(usage.inputTokens, 40);
  assert.equal(usage.outputTokens, 900);
});

test('a legitimate zero overwrites an earlier count', async () => {
  // The motivating truthiness bug: `if (usage.output_tokens)` skips 0, so a
  // stale non-zero survived into the record.
  const { usage } = await run([
    sse('message_start', { message: { usage: { input_tokens: 50, output_tokens: 7 } } }),
    sse('message_delta', { type: 'message_delta', usage: { input_tokens: 0, output_tokens: 0 } }),
  ]);
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 0);
});

test('an event carrying no usage leaves the counts alone', async () => {
  const { usage } = await run([
    sse('message_start', { message: { usage: { input_tokens: 11, output_tokens: 2 } } }),
    sse('content_block_delta', { type: 'content_block_delta', delta: { text: 'hi' } }),
  ]);
  assert.equal(usage.inputTokens, 11);
  assert.equal(usage.outputTokens, 2);
});

test('every byte is forwarded unchanged, even when usage is unparseable', async () => {
  // The strict-tee property: a parsing failure costs a count, never a byte.
  const body = `${CACHE_WRITE}event: message_delta\ndata: {not json\n\n${CACHE_WRITE_DELTA}`;
  const { forwarded, usage } = await run([body]);
  assert.equal(forwarded, body);
  assert.equal(usage.inputTokens, 2036); // the good events still counted
});

test('counting survives chunk boundaries splitting an event mid-JSON', async () => {
  // A real socket splits wherever it likes; the buffer must stitch it back.
  const whole = CACHE_WRITE + CACHE_WRITE_DELTA;
  const cut = Math.floor(whole.length / 2);
  const { usage, forwarded } = await run([whole.slice(0, cut), whole.slice(cut)]);
  assert.equal(usage.inputTokens, 2036);
  assert.equal(forwarded, whole);
});

test('CRLF line endings are tolerated', async () => {
  const { usage } = await run([(CACHE_WRITE + CACHE_WRITE_DELTA).replace(/\n/g, '\r\n')]);
  assert.equal(usage.inputTokens, 2036);
});
