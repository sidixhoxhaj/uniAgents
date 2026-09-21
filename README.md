# uniAgents

**When one account hits its usage limit, your session doesn't.**

You already have Claude accounts logged in on this machine. uniAgents pools
them: when one runs out, the next takes over on the very next request — same
session, same context, same terminal. You keep typing.

```bash
unicode
```

That's it. No login, no setup, no accounts to add.

---

## What makes it different

**No login.** Accounts come from wherever the real `claude` CLI already put
them — and from `codex`, if you are signed in there. To add one, run `claude`
(or `codex`) and log in, exactly as you would anyway. For a second or third
account, see [running several accounts on one machine](docs/MULTIPLE-CLAUDE-CODE-ACCOUNTS.md).

**Credentials are never written.** They stay in the Keychain (macOS) or
`.credentials.json` (Linux) and are read without being copied — uniAgents has
no credential vault, so there is no new place for a token to leak from.
Preferences and usage history do persist, in plain text, in `~/.uniagents/`;
see [`docs/STORAGE.md`](docs/STORAGE.md) for exactly what and why.

**No background daemon.** The proxy — and the read-only dashboard it serves
alongside your session — starts when `unicode` does and exits when it does.
Nothing idles between sessions.

**Zero runtime dependencies.** Node's standard library only. For a tool that
reads your auth tokens, an empty supply chain is a feature.

---

## Install

```bash
git clone https://github.com/sidixhoxhaj/uniAgents.git && cd uniAgents
npm install          # dev dependencies only — nothing ships
npm link             # puts `unicode` on your PATH
```

Requires **Node 20+**, the **`claude`** CLI already logged in, and macOS or
Linux — Windows is not supported, since that would need a separate credential
backend nobody here can verify on real hardware. See
[`INSTALLATION.md`](INSTALLATION.md) for prerequisites, verifying the install
found your accounts, and troubleshooting.

## Use

```bash
unicode                            # start a pooled session
unicode --model opus               # args pass straight through to claude
unicode -- -p "explain this repo"  # everything after -- goes to claude verbatim
unicode usage                      # real subscription usage per account
unicode status                     # what accounts exist
unicode status --check             # ...and verify each credential is usable
unicode --port 4400                # if 4317 is taken
```

While a session is running, live stats are at **http://127.0.0.1:4317/stats** —
read-only: the account serving right now with both usage windows, the rest of
the pool at a glance, and a live feed of requests, rotations and limits as they
happen. Accounts are named by their real identity (email + plan), looked up
once at startup. Every action happens in the terminal; the page is only for
looking.

---

## How it works

```
claude ──▶ 127.0.0.1:4317 ──┬──▶ /stats   read-only page + live feed
                            └──▶ *        proxied to Anthropic
```

0. A ChatGPT/Codex login, if present, joins the same pool — sorted last, since
   a Claude account serves Claude requests natively while Codex must translate
   every byte in both directions.
1. On start, every account's current quota is read up front, so the stats page
   shows real numbers the moment you open it rather than empty bars until you
   happen to send something.
1. Accounts are discovered read-only from the Keychain (macOS) or
   `.credentials.json` (Linux). Nothing is written or prompted for. Entries
   holding only MCP connector tokens are filtered out — Claude Code stores
   those under the same keychain service names, and they can never serve a
   request.
2. Each request goes to the lowest-priority eligible account, and **stays**
   there until that account is spent.
3. Responses are classified from **status and headers only** — never the body —
   so bodies stream through byte for byte.
4. When an account is exhausted, the next one is tried **before a single body
   byte reaches the client**. The switch is invisible: one request in, one
   answer out.
5. When a usage window resets, the account rejoins rotation on its own.

A brief rate limit is a cooldown, never a rotation. A 429 with no `Retry-After`
is treated as a spend cap and backed off exponentially, because retrying it on a
fixed interval never lets the window clear.

---

## What it doesn't do

- **No account management.** The account list *is* what's on the machine.
- **No OAuth of its own.** It never sees a login flow.
- **No usage history or cost tracking.** Nothing is stored, so there's nothing
  to chart. Live numbers come from Anthropic on every response.
- **No cost tracking.** Live usage only, never history.
- **Codex usage** comes from the account's own usage endpoint, so it shows the
  same credit balance the ChatGPT UI does and costs nothing to read.

### About Claude Code's "Total cost"

Inside a session, Claude Code's own `/usage` prints a **Total cost** figure. It
computes that locally from token counts times API list prices and asks the
proxy for nothing — so on a subscription it is a hypothetical, not a bill, and
uniAgents cannot correct it.

Use **`unicode usage`** for the real numbers: how much of each account's included
quota is actually spent, read from the provider's own headers.

### What it costs you

**A fresh start usually costs nothing.** Both providers expose a usage
endpoint that spends no quota — `/api/oauth/usage` for Claude,
`wham/usage` for Codex — so startup reads real numbers for free. Only if
that endpoint fails or rate-limits does uniAgents fall back to a one-token
request to read the quota off its headers.

**Your MCP connectors keep working.** uniAgents sets `ANTHROPIC_BASE_URL`
but deliberately **not** `ANTHROPIC_AUTH_TOKEN` — setting the latter makes
Claude Code treat itself as having a custom auth source and silently drops
every claude.ai-hosted connector. Instead the CLI sends its own OAuth
credential, and the proxy authenticates callers against the accounts it
discovered. Connectors belong to your claude.ai login rather than to any
pooled account, so they are available whichever account is serving.

**The open port is guarded, not open.** The proxy binds to `127.0.0.1` only
and refuses any request that does not carry the credential of an account it
pools. That stops another process on your machine spending your quota
through it.

---

## Development

```bash
npm test          # 130 tests, no network, no keychain, no real claude binary
npm run typecheck
```

Node 20+ strips TypeScript natively, so there is no build step for development.

- `src/core/` — pure logic: rotation and response classification. **No I/O at
  all** — no network, no disk, no clock of its own. Everything is passed in,
  which is what keeps it deterministically testable.
- `src/accounts/` — read-only account discovery.
- `src/proxy/` — the server, upstream transport, and request building.
- `src/codex/` — the ChatGPT/Codex path: credential, translation, bridge.
- `src/accounts/identity.ts` — resolves a token to an email + plan, best-effort.
- `src/stats/` — the read-only page.
- `src/cli/` — the commands.

**[`docs/PROTOCOL.md`](docs/PROTOCOL.md) is required reading before changing
anything in `core/` or `proxy/`.** It records the wire-format facts that are
silent when you get them wrong — epoch seconds vs milliseconds, per-window 429
classification, why `accept-encoding` must be stripped, and why a retry can
never happen after a body byte is committed.

## Planned

- **Serve the provider logos from a CDN** rather than inlining them. Needs the
  page's `Content-Security-Policy` (`default-src 'none'`) to allow that origin
  in `img-src` first — an image blocked by CSP renders nothing and logs
  nothing, so the two changes have to land together. The local copies stay as
  the offline fallback: a local tool should not need the network to draw its
  own UI.

## Licence

MIT — free to use, modify, and share.

This is a personal tool, built and given away for free. Please don't repackage
or resell it. If you'd like to build on it commercially, open an issue first
and let's talk.
