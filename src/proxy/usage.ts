/**
 * Counts tokens from a response without altering a single byte of it.
 *
 * A STRICT TEE: every chunk is passed through unmodified and in order, while a
 * copy is parsed for usage. Every parse is guarded, so a malformed body costs
 * a token count and never the response.
 *
 * Anthropic SSE reports usage in two places: message_start carries
 * input_tokens, message_delta carries the final output_tokens.
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
          if (event?.message?.usage?.input_tokens) usage.inputTokens = event.message.usage.input_tokens;
          if (event?.usage?.output_tokens) usage.outputTokens = event.usage.output_tokens;
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
