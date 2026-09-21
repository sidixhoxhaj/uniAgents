# Installing uniAgents

uniAgents pools Claude accounts that are already logged in on this machine.
There is no signup, no API key, and no account to create — this guide is
entirely about getting the `unicode` command onto your machine and pointed at
logins you already have.

---

## Contents

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Verify it worked](#verify-it-worked)
- [Optional: add Codex](#optional-add-codex)
- [Optional: more than one Claude account](#optional-more-than-one-claude-account)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **macOS or Linux.** Windows is deliberately unsupported — it would need a
  DPAPI credential backend nobody on this project can verify on real
  hardware, and shipping an unverified guess is worse than a clear no.
- **Node 20 or newer.** Node strips TypeScript natively from 22.18/24
  onward; on Node 20 and early 22 `unicode` re-execs itself once with
  `--experimental-strip-types`, which costs a moment but needs nothing from
  you.
- **The `claude` CLI, already logged in — and optionally `codex` too.**
  uniAgents never runs a login flow of its own; it only discovers accounts
  the real `claude` and `codex` CLIs already created. At least one is
  required. If you have not logged in yet, run `claude` (and, if you want
  Codex pooled alongside it, `codex`) and sign in before continuing — see
  [Optional: add Codex](#optional-add-codex) below.
- **`git`**, to clone the repo. There is no package registry install yet —
  see [Install](#install) below.

## Install

```bash
git clone https://github.com/sidixhoxhaj/uniAgents.git
cd uniAgents
npm install          # dev dependencies only (TypeScript, @types/node) — nothing ships to the running tool
npm link             # puts `unicode` on your PATH
```

uniAgents has **zero runtime dependencies** — `npm install` only pulls in
the type-checker used while developing it. The tool itself runs on Node's
standard library alone, which matters specifically because it reads your
auth tokens: an empty supply chain means there is nothing upstream of Node
itself that could be compromised to intercept them.

`npm link` symlinks `bin/unicode` onto your global PATH. If you would rather not
touch global npm state, run it directly instead:

```bash
./bin/unicode
```

## Verify it worked

```bash
unicode status --check
```

This reads every account discovery finds and confirms its credential is
actually usable — it does not just list keychain entries, it opens each one.
Expect something like:

```
  ACCOUNT                 SOURCE    ORDER  STATUS
  you@example.com         keychain  1      ok (pro)
```

If nothing is listed, `claude` has not completed a login on this machine yet
— run `claude` and sign in, then re-run `unicode status --check`.

Then start a real pooled session:

```bash
unicode
```

This behaves exactly like typing `claude` — same TUI, same terminal, same
everything — except requests are routed through a local proxy first. While
it runs, a read-only dashboard is served at **http://127.0.0.1:4317/stats**
(pass `--port` to `unicode` if 4317 is taken on your machine). The
dashboard starts and stops with the session; nothing lingers after you exit.

## Optional: add Codex

If you are also signed into `codex` (the ChatGPT/Codex CLI), that login
joins the same pool automatically — sorted after Claude accounts, since a
Codex request has to be translated in both directions rather than relayed
byte for byte. No extra setup: `unicode status --check` will list it once
`codex` itself has a working login.

## Optional: more than one Claude account

`unicode` pools whatever accounts already exist on the machine. To add a
second or third Claude login (not just Codex), see
[`docs/MULTIPLE-CLAUDE-CODE-ACCOUNTS.md`](docs/MULTIPLE-CLAUDE-CODE-ACCOUNTS.md) —
it walks through `CLAUDE_CONFIG_DIR` and why an "empty" second config
directory does not mean the login failed.

## Uninstalling

```bash
npm unlink -g uniagents   # removes `unicode` from your PATH
rm -rf ~/.uniagents       # removes saved aliases, rotation order, and history
```

Removing `~/.uniagents` does **not** touch your `claude` or `codex` logins —
uniAgents never wrote to the Keychain or `.credentials.json` in the first
place, so there is nothing there to clean up. See
[`docs/STORAGE.md`](docs/STORAGE.md) for exactly what lives in
`~/.uniagents` and why deleting it costs you only preferences and history,
never credentials.

## Troubleshooting

**`unicode: command not found` after `npm link`.**
Confirm npm's global bin directory is on your `PATH` (`npm config get
prefix`, then check `<prefix>/bin` is in `$PATH`). Using `./bin/unicode`
directly always works regardless of PATH.

**`unicode status` lists no accounts.**
`claude` has not completed a login on this machine, or the login is isolated
under a `CLAUDE_CONFIG_DIR` uniAgents cannot see from your current shell.
Run `claude` plainly (no `CLAUDE_CONFIG_DIR` set) and confirm it does not
prompt you to sign in.

**`Port 4317 is already in use.`**
Something else on the machine is bound to it — likely another `unicode`
session. Pass `--port` to pick a different one: `unicode --port 4400`.

**Node version errors on startup.**
`node --version` should report 20 or newer. On Node 20/22, `unicode` re-execs
itself with `--experimental-strip-types`; if that flag is unrecognised, the
installed Node is older than this project supports — upgrade it.
