/**
 * Counts tokens from a response without altering a single byte of it.
 *
 * A STRICT TEE: every chunk is passed through unmodified and in order, while a
 * copy is parsed for usage. Every parse is guarded, so a malformed body costs
 * a token count and never the response.
 *
 * Anthropic SSE reports usage in two places: message_start carries the
 * opening counts, message_delta carries the final ones. BOTH carry the full
 * input breakdown, so the last one seen wins for every field.
 *
 * INPUT IS THREE FIELDS, NOT ONE. With prompt caching on — which Claude Code
 * always uses — nearly all input arrives as cached tokens:
 *
 *   input_tokens                  tokens that were neither cached nor read
 *   cache_creation_input_tokens   written to the cache this request
 *   cache_read_input_tokens       served from the cache this request
 *
 * Measured against a live account, 2026-09-21: a request with a 2036-token
 * system prompt reported input_tokens 9, cache_creation 2027 on the first
 * call and cache_read 2027 on the second. Reading only input_tokens scored
 * 99.6% of real, billable input as zero, which understated every window the
 * router reads and every total the Logs page renders.
 */

import { Transform } from 'node:stream';

export interface CountedUsage {
  inputTokens: number;
  outputTokens: number;
}

export function countingTee(onDone: (usage: CountedUsage, durationMs: number) => void): Transform {
  const started = Date.now();
  const usage: CountedUsage = { inputTokens: 0, outputTokens: 0 };
  let buffer = '';

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      // Forward FIRST, always, so a parsing bug can never stall the stream.
      cb(null, chunk);
      try {
        buffer += chunk.toString('utf8');
        // Tolerate CRLF: an upstream using it would otherwise never match and
        // the buffer would grow forever while counting nothing.
        const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const line = block.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const event = JSON.parse(line.slice(5).trim());
          // message_start nests usage under `message`; message_delta has it at
          // the top level. Both carry input, so take whichever this event has.
          const counts = event?.message?.usage ?? event?.usage;
          if (!counts) continue;
          // `!== undefined`, not truthiness: a legitimate 0 must overwrite a
          // stale non-zero, and an absent field must not be read as 0.
          const input = sumInput(counts);
          if (input !== undefined) usage.inputTokens = input;
          if (counts.output_tokens !== undefined) usage.outputTokens = counts.output_tokens;
        }
      } catch {
        // one unparseable block costs a count, never the response
      }
    },
    flush(cb) {
      try {
        onDone(usage, Date.now() - started);
      } catch {
        // reporting must never fail the request
      }
      cb();
    },
  });
}

/**
 * Total billable input across the three fields, or undefined when the event
 * carries none of them. A field that is absent contributes nothing; a field
 * that is present and 0 still makes the total defined.
 */
function sumInput(counts: Record<string, unknown>): number | undefined {
  let total: number | undefined;
  for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    const v = counts[key];
    if (typeof v === 'number' && Number.isFinite(v)) total = (total ?? 0) + v;
  }
  return total;
}
