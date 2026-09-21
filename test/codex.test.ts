import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCodex, filterCodexHeaders } from '../src/codex/observation.ts';
import { anthropicToOpenAI } from '../src/codex/translate.ts';
import { ResponseTranslator, assembleMessage } from '../src/codex/response.ts';

const NOW = new Date('2026-09-20T12:00:00Z');

// ---- observation: the Codex wire format is NOT Anthropic's ----

test('used-percent is already 0-100 here, not a 0-1 float', () => {
  // Scaling it the way the Anthropic path does would put a 12%-used account
  // at 1200%, instantly "exhausting" a perfectly healthy account.
  const o = classifyCodex(200, { 'x-codex-primary-used-percent': '12' }, NOW);
  assert.equal(o.kind, 'usage');
  assert.equal(o.kind === 'usage' && o.percent, 12);
});

test('resets are RELATIVE seconds here, not an absolute epoch', () => {
  const o = classifyCodex(200, {
    'x-codex-primary-used-percent': '50',
    'x-codex-primary-reset-after-seconds': '3600',
  }, NOW);
  assert.equal(o.kind === 'usage' && o.resetsAt?.getTime(), NOW.getTime() + 3600_000);
});

test('a zero or empty reset means no window, not "resets right now"', () => {
  // Seen on a real usage-based plan: all window fields are 0. Treating that
  // as an immediate reset would make an exhausted account look recoverable.
  for (const value of ['0', '', undefined]) {
    const o = classifyCodex(200, {
      'x-codex-primary-used-percent': '50',
      ...(value === undefined ? {} : { 'x-codex-primary-reset-after-seconds': value }),
    }, NOW);
    assert.equal(o.kind === 'usage' && o.resetsAt, null);
  }
});

test('a credit-based plan with no credits left is exhausted, not rate limited', () => {
  // Backing off and retrying would never help: waiting does not add credits.
  const o = classifyCodex(429, {
    'x-codex-credits-unlimited': 'False',
    'x-codex-credits-has-credits': 'False',
  }, NOW);
  assert.equal(o.kind, 'quota_exhausted');
});

test('Python-cased booleans are parsed — the backend sends True/False', () => {
  const stillHasCredits = classifyCodex(429, {
    'x-codex-credits-unlimited': 'False',
    'x-codex-credits-has-credits': 'True',
    'retry-after': '30',
  }, NOW);
  assert.equal(stillHasCredits.kind, 'rate_limited');
});

test('a window at 100% is exhausted and reports when it refills', () => {
  const o = classifyCodex(429, {
    'x-codex-secondary-used-percent': '100',
    'x-codex-secondary-reset-after-seconds': '600',
  }, NOW);
  assert.equal(o.kind, 'quota_exhausted');
  assert.equal(o.kind === 'quota_exhausted' && o.resetsAt?.getTime(), NOW.getTime() + 600_000);
});

test('401 is auth_invalid; 5xx is unavailable', () => {
  assert.equal(classifyCodex(401, {}, NOW).kind, 'auth_invalid');
  assert.equal(classifyCodex(500, {}, NOW).kind, 'unavailable');
  assert.equal(classifyCodex(503, {}, NOW).kind, 'unavailable');
});

test('only the known codex headers survive filtering', () => {
  const out = filterCodexHeaders({ 'X-Codex-Primary-Used-Percent': '5', 'set-cookie': 'x', 'x-codex-turn-state': 'secret' });
  assert.deepEqual(out, { 'x-codex-primary-used-percent': '5' });
});

// ---- request translation ----

test('store is always false — the backend rejects true outright', () => {
  const r = anthropicToOpenAI({ messages: [] }, 'gpt-5.6-terra');
  assert.equal(r.store, false);
});

test('system becomes instructions, from a string or a block array', () => {
  assert.equal(anthropicToOpenAI({ system: 'be terse', messages: [] }, 'm').instructions, 'be terse');
  assert.equal(
    anthropicToOpenAI({ system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], messages: [] }, 'm').instructions,
    'a\n\nb',
  );
});

test('text parts are tagged by role — input_text for user, output_text for assistant', () => {
  const r = anthropicToOpenAI({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ],
  }, 'm');
  assert.equal((r.input[0] as any).content[0].type, 'input_text');
  assert.equal((r.input[1] as any).content[0].type, 'output_text');
});

test('tool use and results become top-level items, not content parts', () => {
  const r = anthropicToOpenAI({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' }] },
    ],
  }, 'm');
  assert.equal((r.input[0] as any).type, 'function_call');
  assert.equal((r.input[0] as any).call_id, 'call_1');
  assert.equal(JSON.parse((r.input[0] as any).arguments).path, 'a');
  assert.equal((r.input[1] as any).type, 'function_call_output');
  assert.equal((r.input[1] as any).output, 'file contents');
});

test('tool_choice any maps to required', () => {
  assert.equal(anthropicToOpenAI({ messages: [], tool_choice: { type: 'any' } }, 'm').tool_choice, 'required');
  assert.equal(anthropicToOpenAI({ messages: [], tool_choice: { type: 'auto' } }, 'm').tool_choice, 'auto');
});

// ---- response translation ----

function openaiSse(events: unknown[]): string {
  return events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

test('a text response translates to a well-formed Anthropic stream', () => {
  const t = new ResponseTranslator('claude-opus-5');
  let out = t.feed(openaiSse([
    { type: 'response.created' },
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_text.delta', delta: ' world' },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } },
  ]));
  out += t.finish();

  const events = [...out.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(events, [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
  assert.deepEqual((assembleMessage(out, 'claude-opus-5') as any).content, [{ type: 'text', text: 'Hello world' }]);
});

test('REGRESSION: terminal events are emitted exactly once', () => {
  // Seen in a real transcript: response.completed emitted message_delta and
  // message_stop, then finish() emitted both again, so the client saw the
  // message end twice.
  const t = new ResponseTranslator('m');
  let out = t.feed(openaiSse([
    { type: 'response.created' },
    { type: 'response.output_text.delta', delta: 'hi' },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));
  out += t.finish();
  assert.equal([...out.matchAll(/^event: message_stop$/gm)].length, 1);
  assert.equal([...out.matchAll(/^event: message_delta$/gm)].length, 1);
});

test('a truncated stream still closes cleanly', () => {
  // The upstream died mid-answer; the client must still see a complete
  // message rather than a stream that simply stops.
  const t = new ResponseTranslator('m');
  let out = t.feed(openaiSse([
    { type: 'response.created' },
    { type: 'response.output_text.delta', delta: 'partial' },
  ]));
  out += t.finish();
  const events = [...out.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.equal(events.at(-1), 'message_stop');
  assert.equal(events.filter((e) => e === 'content_block_stop').length, 1);
});

test('a tool call translates to a tool_use block and sets stop_reason', () => {
  const t = new ResponseTranslator('m');
  let out = t.feed(openaiSse([
    { type: 'response.created' },
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"a"}' } },
    { type: 'response.completed', response: {} },
  ]));
  out += t.finish();
  const msg = assembleMessage(out, 'm') as any;
  assert.equal(msg.stop_reason, 'tool_use');
  assert.equal(msg.content[0].type, 'tool_use');
  assert.equal(msg.content[0].name, 'read');
  assert.deepEqual(msg.content[0].input, { path: 'a' });
});

test('events split across chunk boundaries are reassembled', () => {
  const t = new ResponseTranslator('m');
  const full = openaiSse([{ type: 'response.created' }, { type: 'response.output_text.delta', delta: 'split' }]);
  const cut = Math.floor(full.length / 2);
  let out = t.feed(full.slice(0, cut));
  out += t.feed(full.slice(cut));
  out += t.finish();
  assert.match(out, /"text":"split"/);
});

test('a malformed event costs one event, never the stream', () => {
  const t = new ResponseTranslator('m');
  let out = t.feed('event: x\ndata: {not json\n\n');
  out += t.feed(openaiSse([{ type: 'response.created' }, { type: 'response.output_text.delta', delta: 'ok' }]));
  out += t.finish();
  assert.match(out, /"text":"ok"/);
});

test('CRLF line endings are handled', () => {
  // An upstream that switched line endings would otherwise never match the
  // block separator, and the buffer would grow forever emitting nothing.
  const t = new ResponseTranslator('m');
  const out = t.feed('event: x\r\ndata: {"type":"response.created"}\r\n\r\n');
  assert.match(out, /message_start/);
});
