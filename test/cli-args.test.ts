/**
 * Argument passthrough. `unicode` must be transparent: anything meant for
 * `claude` reaches it byte for byte, including flags whose names collide with
 * ours. Getting this wrong silently mangles the user's command.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { withDefaultModel } from '../src/cli/code.ts';

/** Mirrors the split in src/cli/index.ts. */
function split(rest: string[]): { port: string | undefined; noStats: boolean; passthrough: string[] } {
  const { values, tokens } = parseArgs({
    args: rest,
    options: { port: { type: 'string' }, 'no-stats': { type: 'boolean' } },
    strict: false,
    tokens: true,
  });
  const terminator = tokens.find((t) => t.kind === 'option-terminator');
  const ours = new Set<number>();
  for (const t of tokens) {
    if (terminator && t.index > terminator.index) break;
    if (t.kind === 'option' && (t.name === 'port' || t.name === 'no-stats')) {
      ours.add(t.index);
      if (t.name === 'port' && t.value !== undefined && !t.inlineValue) ours.add(t.index + 1);
    }
  }
  if (terminator) ours.add(terminator.index);
  return {
    port: values['port'] as string | undefined,
    noStats: values['no-stats'] === true,
    passthrough: rest.filter((_, i) => !ours.has(i)),
  };
}

test('our flags are consumed and everything else passes through', () => {
  const r = split(['--port', '4399', '--model', 'opus']);
  assert.equal(r.port, '4399');
  assert.deepEqual(r.passthrough, ['--model', 'opus']);
});

test('--port=N inline form does not swallow the next argument', () => {
  const r = split(['--port=4399', '--model', 'opus']);
  assert.equal(r.port, '4399');
  assert.deepEqual(r.passthrough, ['--model', 'opus']);
});

test('everything after -- reaches claude verbatim, and -- itself is removed', () => {
  const r = split(['--port', '4399', '--', '-p', 'hello world']);
  assert.equal(r.port, '4399');
  assert.deepEqual(r.passthrough, ['-p', 'hello world']);
});

test('REGRESSION: a flag after -- that shares our name is NOT consumed by us', () => {
  // Found end to end: `--` was being dropped as an unrecognised positional,
  // so `-p` reached claude without its value.
  const r = split(['--', '--port', '9999', '-p', 'prompt']);
  assert.equal(r.port, undefined, 'after --, --port belongs to claude');
  assert.deepEqual(r.passthrough, ['--port', '9999', '-p', 'prompt']);
});

test('no arguments at all is valid — a plain interactive session', () => {
  const r = split([]);
  assert.deepEqual(r.passthrough, []);
  assert.equal(r.noStats, false);
});

test('--no-stats is consumed without disturbing passthrough order', () => {
  const r = split(['--no-stats', '-p', 'x']);
  assert.equal(r.noStats, true);
  assert.deepEqual(r.passthrough, ['-p', 'x']);
});

/* ---- the session's starting model ---- */

test('the configured model is passed to claude as --model', () => {
  // Claude Code's own default is published by Anthropic (currently Opus) and
  // no local setting changes it, so --model is how a session starts on
  // something else.
  assert.deepEqual(withDefaultModel([], 'claude-sonnet-5'), ['--model', 'claude-sonnet-5']);
  assert.deepEqual(
    withDefaultModel(['-p', 'hi'], 'claude-sonnet-5'),
    ['--model', 'claude-sonnet-5', '-p', 'hi'],
  );
});

test('an explicit --model from the user always wins', () => {
  for (const args of [['--model', 'opus'], ['--model=opus'], ['-m', 'opus']]) {
    assert.deepEqual(withDefaultModel(args, 'claude-sonnet-5'), args);
  }
});

test('a cleared override leaves the arguments alone', () => {
  assert.deepEqual(withDefaultModel(['-p', 'hi'], null), ['-p', 'hi']);
});

test('REGRESSION: --model after -- belongs to claude, not to us', () => {
  // Everything after `--` is the user's prompt. Treating a --model in there
  // as "already set" would skip our default for a session that never asked.
  assert.deepEqual(
    withDefaultModel(['--', '-p', '--model is a flag'], 'claude-sonnet-5'),
    ['--model', 'claude-sonnet-5', '--', '-p', '--model is a flag'],
  );
});
