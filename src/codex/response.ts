/**
 * Translates the Codex SSE stream into Anthropic Messages SSE, incrementally.
 *
 * The OpenAI event vocabulary was captured from the real backend on
 * 2026-09-20 — exactly these nine, in this order:
 *
 *   response.created            response.output_text.done
 *   response.in_progress        response.content_part.done
 *   response.output_item.added  response.output_item.done
 *   response.content_part.added response.completed
 *   response.output_text.delta
 *
 * Anthropic's client expects: message_start, content_block_start,
 * content_block_delta*, content_block_stop, message_delta, message_stop.
 *
 * Feed bytes in, get Anthropic SSE bytes out. Stateful by necessity (block
 * indices and the final usage must be tracked across events), but it touches
 * nothing outside itself.
 */

export interface TranslatedUsage {
  inputTokens: number;
  outputTokens: number;
}

export class ResponseTranslator {
  private buffer = '';
  private started = false;
  private blockOpen = false;
  private blockIndex = -1;
  private ended = false;
  usage: TranslatedUsage = { inputTokens: 0, outputTokens: 0 };
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';

  private readonly model: string;
  private readonly messageId: string;

  // Explicit fields, not parameter properties: Node's strip-only TypeScript
  // support cannot desugar `constructor(private x)` — it needs codegen — so
  // that syntax typechecks but fails at runtime. `verbatimModuleSyntax` plus
  // `erasableSyntaxOnly` in tsconfig now catch this at typecheck time.
  constructor(model: string, messageId = `msg_${randomId()}`) {
    this.model = model;
    this.messageId = messageId;
  }

  /** Feed a raw chunk; returns Anthropic SSE bytes to forward (possibly empty). */
  feed(chunk: string): string {
    this.buffer += chunk;
    let out = '';
    // SSE blocks are separated by a blank line. Tolerate CRLF: an upstream
    // that switched line endings would otherwise never match and the buffer
    // would grow forever while emitting nothing.
    const normalised = this.buffer.replace(/\r\n/g, '\n');
    const blocks = normalised.split('\n\n');
    this.buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      const data = block.split('\n').find((l) => l.startsWith('data:'));
      if (!data) continue;
      const payload = data.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;
      try {
        out += this.event(JSON.parse(payload));
      } catch {
        // A malformed event costs one event, never the stream.
      }
    }
    return out;
  }

  private event(e: Record<string, unknown>): string {
    switch (e['type']) {
      case 'response.created':
        return this.start();

      case 'response.output_text.delta': {
        const delta = typeof e['delta'] === 'string' ? e['delta'] : '';
        if (delta === '') return '';
        let out = this.start();
        if (!this.blockOpen) {
          this.blockIndex++;
          this.blockOpen = true;
          out += sse('content_block_start', {
            type: 'content_block_start', index: this.blockIndex,
            content_block: { type: 'text', text: '' },
          });
        }
        return out + sse('content_block_delta', {
          type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'text_delta', text: delta },
        });
      }

      case 'response.output_item.done': {
        const item = e['item'];
        if (typeof item !== 'object' || item === null) return '';
        const i = item as Record<string, unknown>;
        if (i['type'] !== 'function_call') return '';

        // A tool call arrives complete; emit it as one input_json_delta so the
        // client sees the same shape Anthropic sends.
        this.stopReason = 'tool_use';
        let out = this.closeBlock();
        this.blockIndex++;
        const args = typeof i['arguments'] === 'string' ? i['arguments'] : '{}';
        out += sse('content_block_start', {
          type: 'content_block_start', index: this.blockIndex,
          content_block: { type: 'tool_use', id: String(i['call_id'] ?? ''), name: String(i['name'] ?? ''), input: {} },
        });
        out += sse('content_block_delta', {
          type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'input_json_delta', partial_json: args },
        });
        out += sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex });
        return out;
      }

      case 'response.completed': {
        const response = e['response'];
        if (typeof response === 'object' && response !== null) {
          const usage = (response as Record<string, unknown>)['usage'];
          if (typeof usage === 'object' && usage !== null) {
            const u = usage as Record<string, unknown>;
            this.usage = {
              inputTokens: num(u['input_tokens']),
              outputTokens: num(u['output_tokens']),
            };
          }
          if ((response as Record<string, unknown>)['status'] === 'incomplete') this.stopReason = 'max_tokens';
        }
        return this.end();
      }

      default:
        return '';
    }
  }

  private start(): string {
    if (this.started) return '';
    this.started = true;
    return sse('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId, type: 'message', role: 'assistant', model: this.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private closeBlock(): string {
    if (!this.blockOpen) return '';
    this.blockOpen = false;
    return sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex });
  }

  /**
   * Terminal events, emitted EXACTLY once. Both response.completed and a
   * stream that simply ends route through here: without the guard a normal
   * completion emitted message_delta/message_stop twice, which was visible
   * in the real transcript.
   */
  private end(): string {
    if (this.ended || !this.started) return '';
    this.ended = true;
    let out = this.closeBlock();
    out += sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: { output_tokens: this.usage.outputTokens },
    });
    return out + sse('message_stop', { type: 'message_stop' });
  }

  /** Called when the upstream stream ends; a no-op if it ended cleanly. */
  finish(): string {
    return this.end();
  }
}

/** Collapse a translated Anthropic SSE stream into one non-streaming body. */
export function assembleMessage(anthropicSse: string, model: string): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  let text = '';
  let stopReason = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };
  let id = `msg_${randomId()}`;

  for (const block of anthropicSse.replace(/\r\n/g, '\n').split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try {
      const e = JSON.parse(line.slice(5).trim());
      if (e.type === 'message_start') { id = e.message?.id ?? id; usage = e.message?.usage ?? usage; }
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') content.push({ ...e.content_block });
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') text += e.delta.text;
      if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') {
        const last = content[content.length - 1];
        if (last) { try { last['input'] = JSON.parse(e.delta.partial_json); } catch { last['input'] = {}; } }
      }
      if (e.type === 'message_delta') {
        stopReason = e.delta?.stop_reason ?? stopReason;
        if (e.usage?.output_tokens) usage = { ...usage, output_tokens: e.usage.output_tokens };
      }
    } catch { /* one bad event never fails the assembly */ }
  }

  if (text !== '') content.unshift({ type: 'text', text });
  return { id, type: 'message', role: 'assistant', model, content, stop_reason: stopReason, stop_sequence: null, usage };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 14);
}
