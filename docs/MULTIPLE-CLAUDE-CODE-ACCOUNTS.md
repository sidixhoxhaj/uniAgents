# Running several Claude accounts on one machine

uniAgents pools the accounts already on your machine. This is how you get more
than one onto it.

Nothing here is specific to uniAgents — it is how Claude Code itself supports
multiple logins. uniAgents only discovers what these steps create.

---

## Contents

- [The short version](#the-short-version)
- [Why a directory](#why-a-directory)
- [Where the credential actually goes](#where-the-credential-actually-goes)
- [Step by step](#step-by-step)
- [Using a specific account for one session](#using-a-specific-account-for-one-session)
- [Troubleshooting](#troubleshooting)
- [What uniAgents does with them](#what-uniagents-does-with-them)

---

## The short version

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claude      # log in as the second account
```

Then, in uniAgents, press **Scan now** (Settings) or restart `unicode`. The
new account joins the pool.

Repeat with a different directory for each additional account.

---

## Why a directory

Claude Code keeps **one login per config directory**. Logging in again without
changing `CLAUDE_CONFIG_DIR` replaces the existing login rather than adding to
it — which is the usual reason people end up with one account when they
expected two.

So each account needs its own directory:

```bash
CLAUDE_CONFIG_DIR=~/.claude            claude   # the default, if you use it
CLAUDE_CONFIG_DIR=~/.claude-work       claude
CLAUDE_CONFIG_DIR=~/.claude-personal   claude
```

The name is yours to choose. uniAgents looks for `~/.claude` and any sibling
starting with `.claude`, so keeping that prefix means it is found without
further configuration.

---

## Where the credential actually goes

**On macOS the directory does not hold the credential.** It holds settings,
history and session state; the token goes into the login Keychain under a
service name derived from the directory path:

```
service = "Claude Code-credentials-" + sha256(<config dir>)[:8]
```

Verified on this machine: `sha256(~/.claude)[:8]` is `2b636ecd`, which is
exactly the keychain entry that login uses.

This is worth knowing because **an empty `~/.claude-work` is not a sign that
something failed**. That directory looks empty of secrets even when the login
worked perfectly.

On Linux there is no Keychain, so the credential lives in
`<config dir>/.credentials.json`. uniAgents reads both.

---

## Step by step

**1. Pick a directory for the new account.**

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claude
```

Claude Code starts with no login for that directory and prompts you to sign
in. Use the second account.

**2. Confirm it worked.**

```bash
unicode status --check
```

Each account should be listed with its plan, for example:

```
  ACCOUNT                 SOURCE    ORDER  STATUS
  sidi.xhoxhaj@visma.com  keychain  1      ok (team)
  s.xhoxhaj6@gmail.com    keychain  2      ok (pro)
```

If the new account is missing, see Troubleshooting below.

**3. Pick it up in uniAgents.**

Settings → **Scan now**, or restart `unicode`. Scanning does not disturb a
running session: accounts already in the pool keep their state, so an
exhausted account is not silently returned to rotation.

**4. Set the order.**

On Overview, drag the profile cards. The top account serves first; when it
hits its limit the next takes over. The order is saved immediately.

---

## Using a specific account for one session

To work as a particular account without going through uniAgents:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claude
```

That session uses only that login. uniAgents is not involved.

To make it convenient, add a shell alias:

```bash
alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'
```

**Do not alias plain `claude` to a fixed `CLAUDE_CONFIG_DIR`.** It silently
overrides the variable you set on the command line, so every "new" login
lands in the same directory and replaces the previous one. This is easy to do
by accident and hard to spot afterwards.

---

## Troubleshooting

**`unicode status` does not list the new account.**
Confirm the login actually completed: run `CLAUDE_CONFIG_DIR=<dir> claude` and
check it does not prompt you to sign in again. If it does, the previous
attempt did not finish.

**Both entries show the same email.**
You logged in twice into the same directory, so the second replaced the first.
Use a different `CLAUDE_CONFIG_DIR` and log in again. `unicode usage` warns about
this: accounts reporting identical usage are almost always the same account,
and rotating between them gains nothing.

**The directory is empty.**
Expected on macOS — see above. Check `unicode status` rather than the folder.

**An account disappeared.**
A keychain entry can become unreadable (keychain locked, credential expired).
`unicode status --check` reports which one and why. Re-run `claude` for that
directory to refresh it; uniAgents picks up the new credential on the next
read, since it never copies credentials.

**More keychain entries than accounts.**
Normal. Claude Code stores MCP connector tokens (Canva, Notion, Linear, …)
under the same `Claude Code-credentials-*` naming. uniAgents ignores them by
checking each entry actually carries a login. On one real machine, 6 of 8
matching entries were connector caches.

---

## What uniAgents does with them

- Discovers them **read-only**. It never writes a credential anywhere, and
  never runs a login flow of its own.
- Reads each account's identity and current quota at startup, so the dashboard
  has real numbers before you send anything.
- Rotates between them: the top eligible account serves until it is spent,
  then the next takes over mid-session without interrupting you.

To remove an account from the pool, toggle it off on its profile card. To
remove it from the machine, delete its config directory — and on macOS, its
keychain entry:

```bash
security delete-generic-password -s "Claude Code-credentials-<suffix>"
```

uniAgents deliberately has no delete button: it discovers accounts rather than
owning them, so a button there would either do nothing or delete something it
did not create.
