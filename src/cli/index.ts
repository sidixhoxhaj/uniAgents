#!/usr/bin/env node
/**
 * uniAgents CLI. The terminal is the product.
 *
 *   unicode [claude args...]   start a Claude Code session that survives usage limits
 *   unicode status             what accounts exist and how they look right now
 *   unicode --help
 *
 * There is no login, no add-account, and nothing to configure: accounts come
 * from wherever the real `claude` CLI already put them.
 *
 * `status`, `usage`, `help` and `--version` are reserved words: anything
 * else (including no argument at all) starts a session, exactly like `uni
 * code` did before the two were merged. A user who genuinely needs to pass
 * one of those words to `claude` itself uses `unicode -- status`.
 */

import { parseArgs } from 'node:util';
import { cmdCode } from './code.ts';
import { cmdStatus } from './status.ts';
import { cmdUsage } from './usage.ts';

const RESERVED = new Set(['status', 'usage', 'help', '--help', '-h', '--version', '-v']);

const HELP = `uniAgents — pool the Claude accounts already on your machine.

Usage:
  unicode [claude args...]  Start a session that rotates accounts as limits hit
  unicode usage             Real subscription usage for every account
  unicode status [--check]  Show discovered accounts (--check verifies each one)
  unicode help

Options for starting a session:
  --port <n>     Port for the local proxy (default 4317)
  --no-stats     Do not print the stats page URL

Anything else is passed to \`claude\` untouched:
  unicode --model opus -- -p "explain this repo"

To pass a reserved word (status, usage, help) to claude itself, put it after \`--\`:
  unicode -- status

Note: Claude Code's own /usage prints a "Total cost" it computes locally from
token counts and API list prices. On a subscription that figure is
hypothetical — nothing is billed at those rates. Use \`unicode usage\` for the
real numbers.

No login. No stored state. Accounts come from \`claude\` itself — to add one,
run \`claude\` and log in as usual.`;

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  const command = first !== undefined && RESERVED.has(first) ? first : undefined;
  const sessionArgs = command === undefined ? argv : rest;

  switch (command) {
    case 'usage':
      return cmdUsage();

    case 'status': {
      const { values } = parseArgs({ args: rest, options: { check: { type: 'boolean' } }, strict: false });
      return cmdStatus({ check: values['check'] === true });
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;

    case '--version':
    case '-v':
      console.log('0.1.0');
      return 0;

    default: {
      // Only our own flags are parsed; everything else goes to `claude`.
      const { values, tokens } = parseArgs({
        args: sessionArgs,
        options: { port: { type: 'string' }, 'no-stats': { type: 'boolean' } },
        strict: false,
        tokens: true,
      });
      // Everything after a `--` belongs to claude verbatim, including flags
      // that happen to share our names. Before it, drop only our own flags.
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
      const passthrough = sessionArgs.filter((_, i) => !ours.has(i));
      return cmdCode({
        port: values['port'] ? Number(values['port']) : undefined,
        showStats: values['no-stats'] !== true,
        claudeArgs: passthrough,
      });
    }
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
