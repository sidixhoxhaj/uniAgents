/**
 * `unicode` — start a Claude Code session that survives usage limits.
 *
 * Starts the proxy, points `claude` at it, and hands over the terminal. The
 * proxy lives exactly as long as the session: nothing idles in the background
 * and nothing is left behind.
 *
 * Terminal fidelity (verified in docs/PHASE0-SPIKE.md): Node cannot exec-replace
 * the way Python's os.execvp did, so we spawn with stdio inherited. The child
 * receives the IDENTICAL file descriptors — same device, same inode — so its
 * TUI, raw mode and terminal size all behave exactly as if you had typed
 * `claude` yourself. What we must do by hand is what exec got for free:
 * forward signals, and re-report the child's exit status faithfully.
 */

import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { ProxyServer, DEFAULT_PORT } from '../proxy/server.ts';
import { closeUpstreamPool } from '../proxy/upstream.ts';
import { credentialLocationHint } from '../accounts/discover.ts';

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

/**
 * Start the session on the configured model by passing `--model`.
 *
 * Claude Code's own default is published by Anthropic in a signed catalog
 * (`~/.claude/cache/model-catalog/`) — currently Opus — and there is no
 * local setting that changes it. `--model` is the supported way to override
 * it, and unlike rewriting the model on the wire it leaves the session
 * honest: the status line shows what is really answering, and `/model`
 * switches freely afterwards because nothing downstream contradicts it.
 *
 * An explicit `--model` in the user's own arguments always wins.
 */
export function withDefaultModel(args: string[], model: string | null): string[] {
  if (model === null) return args;

  // Only look before `--`; after it, the flag belongs to claude's prompt.
  const end = args.indexOf('--');
  const scan = end === -1 ? args : args.slice(0, end);
  if (scan.some((a) => a === '--model' || a === '-m' || a.startsWith('--model='))) return args;

  return ['--model', model, ...args];
}

export async function cmdCode(opts: { port?: number | undefined; showStats: boolean; claudeArgs: string[] }): Promise<number> {
  const server = new ProxyServer();

  let port: number;
  try {
    port = await server.listen(opts.port ?? DEFAULT_PORT);
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? `Port ${opts.port ?? DEFAULT_PORT} is already in use. Pass --port to pick another.`
      : `Could not start the local proxy: ${(err as Error).message}`;
    console.error(msg);
    return 1;
  }

  const count = server.gateway.accountCount;
  if (count === 0) {
    console.error(`No Claude accounts found — looked in ${credentialLocationHint()}.\n`);
    console.error('Run `claude` and log in first. uniAgents uses the accounts you already have.');
    await server.close();
    return 1;
  }

  console.error(`uniAgents · ${count} account${count === 1 ? '' : 's'} pooled`);
  if (opts.showStats) console.error(`stats → http://127.0.0.1:${port}/stats`);
  console.error('');

  const child = spawn('claude', withDefaultModel(opts.claudeArgs, server.gateway.preferences.activeModel), {
    stdio: 'inherit', // identical fds: a real TTY stays a real TTY
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      // ANTHROPIC_AUTH_TOKEN is deliberately NOT set. Setting it makes
      // Claude Code treat this as a custom auth source and silently drop
      // every claude.ai-hosted MCP connector — measured: 18 connectors
      // became "No MCP servers configured". Without it the CLI sends its
      // own OAuth credential, which the proxy authenticates against the
      // accounts it discovered. See docs/PROTOCOL.md.
    },
  });

  // Forward signals rather than dying first: the child owns the terminal and
  // should decide how to handle Ctrl-C. Installing these also stops Node from
  // taking its own default action and killing us out from under the session.
  const handlers = FORWARDED_SIGNALS.map((sig) => {
    const h = () => child.kill(sig);
    process.on(sig, h);
    return [sig, h] as const;
  });

  try {
    return await new Promise<number>((resolve, reject) => {
      child.on('error', (err) => {
        reject(
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? new Error('Could not find the `claude` command. Install Claude Code first.')
            : err,
        );
      });
      // POSIX convention exec callers emulate: a signal death reports 128+signum.
      child.on('exit', (code, signal) => {
        resolve(signal ? 128 + (osConstants.signals[signal] ?? 0) : (code ?? 0));
      });
    });
  } finally {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
    await server.close();
    closeUpstreamPool();
  }
}
