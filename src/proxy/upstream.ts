/**
 * The one module that opens a real socket to Anthropic.
 *
 * THE INVARIANT THIS FILE EXISTS TO PROTECT:
 *
 *   Status and headers arrive BEFORE any body byte is read, and this function
 *   resolves at exactly that moment. The caller therefore gets to classify the
 *   response and decide whether to rotate to another account while the body is
 *   still untouched on the socket. Once the caller starts piping `body`, that
 *   response is COMMITTED — no retry can happen underneath it, because the
 *   client has already seen bytes.
 *
 * `node:https` gives us this for free: the 'response' event fires after the
 * header block and before the body stream is consumed. A promise-based client
 * that resolves with a buffered body would destroy the property silently,
 * which is why this is hand-rolled rather than using fetch().
 */

import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { UpstreamRequest } from './request.ts';

export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * One pooled agent for the process. Keep-alive matters: without it every
 * request pays a full TLS handshake, which on a chatty session is the single
 * largest avoidable latency cost.
 */
const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: DEFAULT_TIMEOUT_MS,
});

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Live, unread stream. Reading it commits the response. */
  body: IncomingMessage;
  /** Discard an uncommitted response and free its socket. */
  discard(): void;
}

export function sendUpstream(req: UpstreamRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<UpstreamResponse> {
  const url = new URL(req.url);
  if (url.protocol !== 'https:') {
    // Loopback http:// is a different trust boundary; never send a credential over it.
    return Promise.reject(new UpstreamError(`refusing to send upstream over ${url.protocol}`));
  }

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        agent,
        method: req.method,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: req.headers,
        timeout: timeoutMs,
      },
      (res) => {
        // Fires after the header block, before the body is read. This is the
        // decision point the whole design depends on.
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
          discard() {
            res.resume(); // drain so the pooled socket can be reused
            res.destroy();
          },
        });
      },
    );

    // Nagle off upstream too. The request body is written in one or two
    // chunks and then we wait on the response, which is exactly the pattern
    // Nagle delays: the final short segment is held back waiting for an ACK
    // that only arrives once the peer has the whole body. That is dead time
    // on the front of every single request.
    request.on('socket', (socket) => socket.setNoDelay(true));

    request.on('timeout', () => {
      request.destroy(new UpstreamError(`upstream timed out after ${timeoutMs}ms`));
    });
    // Normalised here so every caller handles one error type. In the Python
    // version this was two different exception classes, and a retry path that
    // caught only one of them leaked in-flight state.
    request.on('error', (err) => {
      reject(err instanceof UpstreamError ? err : new UpstreamError(err.message, { cause: err }));
    });

    if (req.body.length > 0) request.write(req.body);
    request.end();
  });
}

export class UpstreamError extends Error {
  override name = 'UpstreamError';
}

/** Close pooled sockets. Called on shutdown. */
export function closeUpstreamPool(): void {
  agent.destroy();
}
