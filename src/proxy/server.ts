/**
 * The loopback server. Two jobs on one port:
 *
 *   /stats, /api/*  →  the read-only stats page and its feed
 *   everything else →  proxied upstream
 *
 * The proxy is the catch-all, so any path not explicitly recognised is
 * forwarded. That is deliberate: Anthropic can add endpoints without this
 * tool needing to know about them.
 *
 * Auth: requests must carry the session token this process generated at
 * startup. It exists only in memory and is passed to the child `claude` via
 * an environment variable. Without it any local process could spend your
 * quota through the open port.
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Gateway } from './gateway.ts';
import { filterOutboundResponseHeaders, MAX_BODY_BYTES } from './request.ts';
import { assets } from '../dashboard/serve.ts';
import { flush } from '../store/log.ts';
import { buildHistory } from '../store/history.ts';

export const DEFAULT_PORT = 4317;
const LOOPBACK = '127.0.0.1';

export class ProxyServer {
  readonly gateway = new Gateway();
  private server: http.Server | null = null;
  private sseClients = new Set<ServerResponse>();

  async listen(port = DEFAULT_PORT): Promise<number> {
    await this.gateway.init();

    const push = () => this.broadcast('state', this.snapshotPayload());
    this.gateway.on('rotate', push);
    this.gateway.on('auth_invalid', push);
    this.gateway.on('usage', push);
    this.gateway.on('activity', push);

    this.server = http.createServer((req, res) => {
      this.route(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy(); // mid-body: the status line is already out, so just drop it
      });
    });
    // HTTP/1.1 keep-alive. The Python version left this at the stdlib default
    // of HTTP/1.0, so every request reconnected.
    this.server.keepAliveTimeout = 65_000;
    this.server.headersTimeout = 70_000;

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, LOOPBACK, () => {
        const addr = this.server!.address();
        if (typeof addr === 'string' || addr === null || addr.address !== LOOPBACK) {
          // Refuse to serve credentials on anything but loopback.
          this.server!.close();
          reject(new Error(`refusing to run: bound to ${JSON.stringify(addr)}, not ${LOOPBACK}`));
          return;
        }
        resolve(addr.port);
      });
    });
  }

  async close(): Promise<void> {
    for (const c of this.sseClients) c.end();
    this.sseClients.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    // History is appended without awaiting so requests never wait on a disk;
    // a clean shutdown must let those land or the last events are lost.
    await flush();
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    if (path === '/health') return this.json(res, 200, { status: 'ok', accounts: this.gateway.accountCount });
    const asset = assets()[path];
    if (asset) return this.static(res, asset);
    if (path === '/api/stats') return this.json(res, 200, this.snapshotPayload());
    if (path === '/api/events') return this.sse(req, res);

    // The Logs page. Read-only aggregation over what is already on disk.
    if (path === '/api/history') {
      const month = new URL(req.url ?? '/', 'http://x').searchParams.get('month') ?? undefined;
      return this.json(res, 200, await buildHistory(month, 200, this.gateway.view().map((a) => a.id)));
    }

    // What this process is costing. Real numbers rather than a decorative
    // placeholder, since the panel exists to answer "is it heavy?".
    if (path === '/api/process') {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      const upSeconds = process.uptime();
      return this.json(res, 200, {
        pid: process.pid,
        uptimeSeconds: upSeconds,
        // Average CPU across the process lifetime: total CPU microseconds
        // over wall-clock. An instantaneous figure would need sampling.
        cpuPercent: upSeconds > 0 ? ((cpu.user + cpu.system) / 1e6 / upSeconds) * 100 : 0,
        memoryBytes: mem.rss,
      });
    }

    // Look for logins created since startup. A POST because it changes the
    // pool, even though it only ever reads from the machine.
    if (path === '/api/scan') {
      if (req.method !== 'POST') return this.json(res, 405, { error: 'method_not_allowed' });
      const result = await this.gateway.rescan();
      this.broadcast('state', this.snapshotPayload());
      return this.json(res, 200, result);
    }

    // Every model the pool can serve, merged and deduplicated, plus which
    // one is currently forced (null when requests pass through untouched).
    if (path === '/api/models') {
      return this.json(res, 200, {
        models: await this.gateway.models(),
        active: this.gateway.preferences.activeModel,
      });
    }

    // Preferences the dashboard can change. POST-only: a GET must never mutate.
    if (path === '/api/config') {
      if (req.method === 'GET') return this.json(res, 200, this.gateway.preferences);
      if (req.method === 'POST') return this.updateConfig(req, res);
      return this.json(res, 405, { error: 'method_not_allowed' });
    }
    // Re-read every account's quota on demand. Read-only in the sense that
    // matters: it changes nothing, it just asks the provider again.
    if (path === '/api/refresh') {
      await this.gateway.refreshUsage();
      return this.json(res, 200, this.snapshotPayload());
    }

    return this.proxy(req, res, path);
  }

  private async proxy(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!this.authorised(req)) {
      return this.json(res, 401, { error: 'unauthorised', message: 'Missing or invalid session token.' });
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      return this.json(res, 413, { error: 'body_too_large' });
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers[k] = Array.isArray(v) ? (v[0] ?? '') : v;
    }

    const result = await this.gateway.handle(req.method ?? 'GET', path, headers, body);

    if (result.body === null) {
      return this.json(res, result.status, {
        type: 'error',
        error: { type: 'api_error', message: errorMessage(result.error) },
      });
    }

    res.writeHead(result.status, filterOutboundResponseHeaders(result.headers));
    // Stream straight through, unmodified. Errors after this point cannot be
    // reported as HTTP — the status line is already sent — so the connection
    // is dropped instead, which is what a truncated stream looks like anyway.
    result.body.on('error', () => res.destroy());
    res.on('close', () => result.body?.destroy());
    result.body.pipe(res);
  }

  /**
   * Apply a dashboard change. Local-only and read-mostly, but still narrow:
   * exactly three shapes are accepted and anything else is rejected, so a
   * stray POST cannot reach arbitrary state.
   */
  private async updateConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      return this.json(res, 413, { error: 'body_too_large' });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return this.json(res, 400, { error: 'invalid_json' });
    }

    try {
      if (typeof payload['profileId'] === 'string' && typeof payload['changes'] === 'object' && payload['changes']) {
        await this.gateway.setProfile(payload['profileId'], payload['changes'] as never);
      } else if (Array.isArray(payload['parity'])) {
        await this.gateway.setParity(payload['parity'] as never);
      } else if (typeof payload['settings'] === 'object' && payload['settings']) {
        await this.gateway.setSettings(payload['settings'] as never);
      // Presence, not truthiness: null is the meaningful "clear the override"
      // value and would be skipped by a plain truthy check.
      } else if ('activeModel' in payload) {
        const wanted = payload['activeModel'];
        if (wanted !== null && typeof wanted !== 'string') {
          return this.json(res, 400, { error: 'invalid_model' });
        }
        if (!(await this.gateway.setActiveModel(wanted))) {
          return this.json(res, 400, { error: 'unknown_model' });
        }
      } else {
        return this.json(res, 400, { error: 'unrecognised_change' });
      }
    } catch (err) {
      return this.json(res, 500, { error: 'save_failed', message: (err as Error).message });
    }

    this.broadcast('state', this.snapshotPayload());
    return this.json(res, 200, { ok: true, config: this.gateway.preferences });
  }

  /**
   * A caller is authorised if it presents the OAuth credential of an account
   * we pool — which the `claude` CLI sends of its own accord to a custom
   * base URL.
   *
   * The port is loopback-only, so this defends against other processes on
   * this machine spending your quota, not against the network. It replaced
   * an injected `ANTHROPIC_AUTH_TOKEN`: that worked, but setting it made
   * Claude Code drop every claude.ai-hosted MCP connector. See
   * docs/PROTOCOL.md.
   */
  private authorised(req: IncomingMessage): boolean {
    const header = req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (raw === undefined || !raw.startsWith('Bearer ')) return false;
    return this.gateway.authorisesCaller(raw.slice(7));
  }

  private sse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`event: state\ndata: ${JSON.stringify(this.snapshotPayload())}\n\n`);
    this.sseClients.add(res);
    req.on('close', () => this.sseClients.delete(res));
  }

  /** Everything the stats page renders, in one shape. */
  private snapshotPayload(): unknown {
    return {
      accounts: this.gateway.view(),
      totals: this.gateway.activity.totals,
      events: this.gateway.activity.recent(30),
      startedAt: this.gateway.startedAt.toISOString(),
      config: this.gateway.preferences,
    };
  }

  private broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.sseClients) c.write(frame);
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    const payload = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  }

  private static(res: ServerResponse, asset: { body: string; type: string }): void {
    res.writeHead(200, {
      'Content-Type': asset.type,
      'Content-Length': Buffer.byteLength(asset.body),
      'Cache-Control': 'no-store',
      // Same-origin only: no external script, style, image or connection. An
      // asset blocked by CSP renders nothing and logs nothing, so everything
      // the page needs is served from here.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(asset.body);
  }
}

function errorMessage(code: string | undefined): string {
  if (code === 'no_account_available') {
    return 'Every account is currently rate limited or exhausted. They rejoin automatically when their window resets.';
  }
  return 'Could not reach any account. Check your connection and try again.';
}

/** Enforces the cap WHILE reading, so an oversized body is never buffered. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
