/**
 * Anthropic Messages ⇄ OpenAI Responses shape mapping. Pure, no I/O.
 *
 * Request shape and the SSE event vocabulary were captured from the real
 * backend on 2026-09-20 (9 event types, listed in ResponseTranslator below).
 */

export interface OpenAIRequest {
  model: string;
  instructions: string;
  input: unknown[];
  stream: boolean;
  store: boolean;
  tools?: unknown[];
  tool_choice?: string;
  reasoning?: { effort: string };
}

/** Anthropic /v1/messages body → OpenAI Responses body. */
export function anthropicToOpenAI(body: Record<string, unknown>, model: string, effort?: string): OpenAIRequest {
  const req: OpenAIRequest = {
    model,
    instructions: systemText(body['system']),
    input: messagesToInput(body['messages']),
    stream: body['stream'] === true,
    // The backend REFUSES store:true outright (400 "Store must be set to
    // false"), so this is fixed, not a preference.
    store: false,
  };

  const tools = mapTools(body['tools']);
  if (tools.length > 0) req.tools = tools;

  const choice = mapToolChoice(body['tool_choice']);
  if (choice) req.tool_choice = choice;

  if (effort) req.reasoning = { effort };
  return req;
}

function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((b) => (typeof b === 'object' && b !== null && typeof (b as Record<string, unknown>)['text'] === 'string'
      ? (b as Record<string, string>)['text'] : ''))
    .filter(Boolean)
    .join('\n\n');
}

function messagesToInput(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return [];
  const out: unknown[] = [];

  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const m = message as Record<string, unknown>;
    const role = m['role'] === 'assistant' ? 'assistant' : 'user';
    const content = m['content'];

    if (typeof content === 'string') {
      out.push(textItem(role, content));
      continue;
    }
    if (!Array.isArray(content)) continue;

    const parts: unknown[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;

      switch (b['type']) {
        case 'text':
          if (typeof b['text'] === 'string') parts.push(textPart(role, b['text']));
          break;
        case 'image': {
          const src = b['source'];
          if (typeof src === 'object' && src !== null) {
            const s = src as Record<string, unknown>;
            if (s['type'] === 'base64' && typeof s['data'] === 'string') {
              parts.push({ type: 'input_image', image_url: `data:${String(s['media_type'] ?? 'image/png')};base64,${s['data']}` });
            }
          }
          break;
        }
        case 'tool_use':
          // A tool call is its own top-level item, not a content part.
          out.push({
            type: 'function_call',
            name: String(b['name'] ?? ''),
            call_id: String(b['id'] ?? ''),
            arguments: JSON.stringify(b['input'] ?? {}),
          });
          break;
        case 'tool_result':
          out.push({
            type: 'function_call_output',
            call_id: String(b['tool_use_id'] ?? ''),
            output: toolResultText(b['content']),
          });
          break;
      }
    }
    if (parts.length > 0) out.push({ type: 'message', role, content: parts });
  }
  return out;
}

const textItem = (role: string, text: string) => ({ type: 'message', role, content: [textPart(role, text)] });
// The Responses API distinguishes input from output text by role.
const textPart = (role: string, text: string) => ({ type: role === 'assistant' ? 'output_text' : 'input_text', text });

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content
    .map((b) => (typeof b === 'object' && b !== null && typeof (b as Record<string, unknown>)['text'] === 'string'
      ? (b as Record<string, string>)['text'] : ''))
    .filter(Boolean)
    .join('\n');
}

function mapTools(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  const out: unknown[] = [];
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue;
    const t = tool as Record<string, unknown>;
    if (typeof t['name'] !== 'string') continue;
    out.push({
      type: 'function',
      name: t['name'],
      description: typeof t['description'] === 'string' ? t['description'] : '',
      parameters: t['input_schema'] ?? { type: 'object', properties: {} },
    });
  }
  return out;
}

function mapToolChoice(choice: unknown): string | undefined {
  if (typeof choice !== 'object' || choice === null) return undefined;
  const type = (choice as Record<string, unknown>)['type'];
  if (type === 'any') return 'required';
  if (type === 'auto') return 'auto';
  if (type === 'none') return 'none';
  return undefined;
}
