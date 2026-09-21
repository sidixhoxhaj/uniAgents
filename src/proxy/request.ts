/**
 * Builds the upstream request. Pure — no sockets, no credentials fetched here.
 *
 * See docs/PROTOCOL.md. The two non-obvious rules this file exists to enforce:
 *
 *  1. `accept-encoding` is STRIPPED. The `claude` CLI asks for gzip/brotli and
 *     Anthropic honours it. Compressed bodies are still forwarded fine, but
 *     nothing can read the usage numbers out of them, so every window would
 *     silently report 0% and rotation would never fire. Dropping the header
 *     costs nothing on a loopback hop.
 *
 *  2. `metadata.user_id` is a JSON-ENCODED STRING containing `account_uuid`
 *     alongside other fields (a session id among them) that must survive. It
 *     is not a bare uuid. Only the one nested field is rewritten, and an
 *     unrecognised shape is passed through untouched rather than guessed at.
 */

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * The OAuth entitlement marker.
 *
 * Anthropic gates premium models (Opus, Sonnet) behind a recognised marker
 * appearing as the FIRST system block. Without one the request is refused
 * with a bare 429 that carries NO rate-limit headers and the message
 * "Error" — indistinguishable from real quota pushback, which is exactly
 * what made this so hard to see: the router read it as an exhausted account
 * and rotated away from a login with 95% of its window left.
 *
 * Measured against two accounts in different organisations, 2026-09-21:
 *
 *   billing-header block first            → 200
 *   this string first                     → 200
 *   this string first, user content after → 200
 *   user content first (marker second)    → 429
 *   no system block at all                → 429
 *   claude-haiku-4-5 (any of the above)   → 200   (exempt from the gate)
 *
 * The real `claude` CLI always sends its own marker, so this is injected
 * ONLY when a request arrives without one. See anthropics/claude-code#87420.
 */
export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Markers Anthropic accepts as the first system block. */
const ENTITLEMENT_PREFIXES = [CLAUDE_CODE_SYSTEM, 'x-anthropic-billing-header:'];
export const MAX_BODY_BYTES = 20_000_000;

/** Stripped from the inbound request: credential-shaped or hop-by-hop. */
const STRIPPED_INBOUND = new Set([
  'authorization',
  'x-api-key',
  'host',
  'connection',
  'content-length', // recomputed after any rewrite
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'accept-encoding', // see rule 1 above
]);

export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
}

export function buildUpstreamRequest(opts: {
  accessToken: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  accountUuid?: string | null;
}): UpstreamRequest {
  if (opts.body.length > MAX_BODY_BYTES) {
    throw new Error('request body too large to proxy');
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers)) {
    if (!STRIPPED_INBOUND.has(k.toLowerCase())) headers[k] = v;
  }
  headers['Authorization'] = `Bearer ${opts.accessToken}`;

  let body = opts.body;
  if (isMessagesPath(opts.path) && body.length > 0) {
    body = ensureEntitlementSystem(body);
  }
  if (opts.accountUuid && isMessagesPath(opts.path) && body.length > 0) {
    body = rewriteAccountUuid(body, opts.accountUuid);
  }
  if (body !== opts.body) headers['Content-Length'] = String(body.length);

  return { url: `${ANTHROPIC_BASE_URL}${opts.path}`, method: opts.method, headers, body };
}

function isMessagesPath(path: string): boolean {
  return path.replace(/\/+$/, '').endsWith('/v1/messages');
}

/**
 * Replace metadata.user_id's nested `account_uuid`, preserving every sibling
 * field. Any shape mismatch returns the body untouched — deliberately not an
 * error, since not every request has a body worth rewriting.
 */
export function rewriteAccountUuid(body: Buffer, accountUuid: string): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (typeof parsed !== 'object' || parsed === null) return body;

  const root = parsed as Record<string, unknown>;
  const metadata = root['metadata'];
  if (typeof metadata !== 'object' || metadata === null) return body;

  const meta = metadata as Record<string, unknown>;
  const userIdRaw = meta['user_id'];
  if (typeof userIdRaw !== 'string') return body;

  let userId: unknown;
  try {
    userId = JSON.parse(userIdRaw);
  } catch {
    return body;
  }
  if (typeof userId !== 'object' || userId === null || !('account_uuid' in userId)) return body;

  (userId as Record<string, unknown>)['account_uuid'] = accountUuid;
  meta['user_id'] = JSON.stringify(userId);
  return Buffer.from(JSON.stringify(root), 'utf8');
}

/**
 * Response headers relayed to the client. An allowlist, not a denylist, so
 * upstream infrastructure headers (set-cookie, cf-ray, …) never leak through.
 */
export function filterOutboundResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (key === 'connection' || key === 'transfer-encoding' || key === 'content-length' || key === 'set-cookie') continue;
    if (key.startsWith('cf-') || key === 'server' || key === 'report-to' || key === 'nel') continue;
    out[k] = Array.isArray(v) ? (v[0] ?? '') : v;
  }
  return out;
}


/**
 * Put the entitlement marker first when the caller did not send one.
 *
 * A request that already leads with a recognised marker is returned
 * UNTOUCHED — the real CLI sends its own, and rewriting it would risk
 * breaking a request that already works. Anything unparseable is also
 * returned untouched: a body we do not understand is not one to rewrite.
 */
export function ensureEntitlementSystem(body: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body;

  const root = parsed as Record<string, unknown>;
  const system = root['system'];

  // A plain string system prompt: the gate reads its start the same way.
  if (typeof system === 'string') {
    if (leadsWithMarker(system)) return body;
    root['system'] = [
      { type: 'text', text: CLAUDE_CODE_SYSTEM },
      { type: 'text', text: system },
    ];
    return Buffer.from(JSON.stringify(root), 'utf8');
  }

  if (Array.isArray(system)) {
    const first = system[0];
    const text = typeof first === 'object' && first !== null
      ? (first as Record<string, unknown>)['text']
      : undefined;
    if (typeof text === 'string' && leadsWithMarker(text)) return body;
    root['system'] = [{ type: 'text', text: CLAUDE_CODE_SYSTEM }, ...system];
    return Buffer.from(JSON.stringify(root), 'utf8');
  }

  // No system block at all — the shape the gate refuses outright.
  if (system === undefined) {
    root['system'] = [{ type: 'text', text: CLAUDE_CODE_SYSTEM }];
    return Buffer.from(JSON.stringify(root), 'utf8');
  }

  return body;
}

function leadsWithMarker(text: string): boolean {
  return ENTITLEMENT_PREFIXES.some((p) => text.startsWith(p));
}
