/**
 * The Codex path: sends a translated request to the ChatGPT backend and
 * streams the answer back as Anthropic SSE.
 *
 * Endpoint and headers verified against the real backend on 2026-09-20.
 * Unlike the Anthropic path this CANNOT be a byte-for-byte relay — every
 * chunk is translated — so the module owns its own HTTPS call rather than
 * sharing proxy/upstream.ts.
 */

import https from 'node:https';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { CodexCredential } from './credential.ts';
import { anthropicToOpenAI } from './translate.ts';
import { ResponseTranslator } from './response.ts';
import { modelFor, effortFor } from './models.ts';

export const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ORIGINATOR = 'codex_cli_rs';
const CODEX_CLI_VERSION = '0.155.1';

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 16 });

export interface CodexResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  raw: IncomingMessage;
  discard(): void;
}

/**
 * Resolves once status and headers are in, with the body still unread — the
 * same contract as proxy/upstream.ts, so the gateway can classify and rotate
 * before committing anything to the client.
 */
export function sendCodex(
  credential: CodexCredential,
  anthropicBody: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<CodexResponse> {
  const requestedModel = typeof anthropicBody['model'] === 'string' ? anthropicBody['model'] : '';
  const openaiBody = anthropicToOpenAI(anthropicBody, modelFor(requestedModel), effortFor(requestedModel));
  const payload = Buffer.from(JSON.stringify(openaiBody), 'utf8');

  const url = new URL(CODEX_URL);
  const sessionId = randomUUID();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'Content-Length': String(payload.length),
    originator: ORIGINATOR,
    'User-Agent': `${ORIGINATOR}/${CODEX_CLI_VERSION} (${process.platform}; ${process.arch})`,
    'session-id': sessionId,
    'thread-id': sessionId,
    'x-client-request-id': sessionId,
  };
  // Required for a subscription login; an API-key login must NOT send it.
  if (credential.authMode === 'chatgpt' && credential.accountId) {
    headers['ChatGPT-Account-ID'] = credential.accountId;
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      { agent, method: 'POST', hostname: url.hostname, path: url.pathname, headers, timeout: timeoutMs },
      (res) => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        raw: res,
        discard() { res.resume(); res.destroy(); },
      }),
    );
    req.on('timeout', () => req.destroy(new CodexTransportError(`Codex timed out after ${timeoutMs}ms`)));
    req.on('error', (err) => reject(err instanceof CodexTransportError ? err : new CodexTransportError(err.message, { cause: err })));
    req.write(payload);
    req.end();
  });
}

/**
 * Wraps the raw OpenAI stream as an async iterable of Anthropic SSE chunks.
 * A truncated upstream still emits a well-formed close, so the client sees a
 * complete message rather than a stream that simply stops.
 */
export async function* translateStream(res: IncomingMessage, model: string): AsyncGenerator<Buffer> {
  const translator = new ResponseTranslator(model);
  res.setEncoding('utf8');
  for await (const chunk of res) {
    const out = translator.feed(chunk as string);
    if (out !== '') yield Buffer.from(out, 'utf8');
  }
  const tail = translator.finish();
  if (tail !== '') yield Buffer.from(tail, 'utf8');
}

export class CodexTransportError extends Error {
  override name = 'CodexTransportError';
}

export function closeCodexPool(): void {
  agent.destroy();
}
