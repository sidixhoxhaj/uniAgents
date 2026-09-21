# Phase 0 — Spike results

Run on macOS 15 (Darwin 25.5.0), Node v24.15.0, 2026-09-20.

Both unknowns that could have invalidated the plan are resolved. **Plan holds.**

---

## Spike A — can `spawn` replace `execvp`?

`cu code` must hand the terminal to Claude Code so its TUI behaves exactly as if you had
typed `claude` yourself. Python used `os.execvp`, which *replaces* the process. Node has no
equivalent, so the question was whether `spawn` + `stdio: 'inherit'` is good enough.

### A1 — file descriptor identity: PASS

The child must receive the *same* fds, not copies, or a TTY is not a TTY.

```
parent fd0 dev/ino: 18446744073709552000 0 11051
child  fd0 dev/ino: 18446744073709552000 0 11051
```

Identical device and inode. When the parent's fd 0 is a TTY, the child gets that exact
TTY — `isatty()`, terminal size, raw mode, and job control all work. This is the property
`execvp` provides and `stdio: 'inherit'` preserves it.

> A naive `test -t 0` check inside a captured-output harness reports `NOT` a TTY — that is
> the harness, not `spawn`. fd identity is the correct test.

### A2 — exit codes and signals: PASS

```
exit 0    → status: 0     signal: null     → exit as: 0
exit 42   → status: 42    signal: null     → exit as: 42
SIGINT    → status: null  signal: SIGINT   → exit as: 130
SIGTERM   → status: null  signal: SIGTERM  → exit as: 143
```

Exit codes pass through exactly. Signal deaths map to the POSIX `128 + signum` convention
that `execvp` callers emulate.

### Remaining difference

A parent process lingers (a few MB) where `execvp` would have been replaced. Invisible in
use. The parent must:

- forward `SIGINT` / `SIGTERM` / `SIGHUP` / `SIGQUIT` to the child,
- **not** install its own handlers that swallow Ctrl-C,
- re-emit the child's exit status as `128 + signum` on signal death,
- stay out of the way otherwise (no output of its own once the child starts).

**Verdict: use `spawn` + `inherit`.** No shell shim needed.

---

## Spike B — read-only account discovery

The premise of v2 is that accounts already exist on the machine and need no login.

### B1 — enumeration: PASS

`security dump-keychain` lists service names **without** reading secret values and
**without** a prompt. On this machine:

```
discovered accounts: 8
  - Claude Code-credentials          ← default (~/.claude)
  - Claude Code-credentials-0eea6d2f
  - Claude Code-credentials-2b636ecd
  - Claude Code-credentials-6c5c2a5f
  - Claude Code-credentials-6caa35e5
  - Claude Code-credentials-864ef0b0
  - Claude Code-credentials-9f05507f
  - Claude Code-credentials-b44f8f73
```

Eight accounts, discovered with no login, no writes, no prompt. The suffix is
`sha256(CLAUDE_CONFIG_DIR)[:8]`, the convention the existing tooling already uses, so
isolated logins are found for free.

### Still to verify (Phase 2, needs real use)

- **Reading a secret value** (`security find-generic-password -w`) may trigger a one-time
  OS authorisation prompt per binary. Expected to be once-ever, not per request —
  must be confirmed on real hardware, and the value must be cached in memory for the
  process lifetime either way.
- **Expired tokens.** With no storage we cannot refresh-and-persist. An expired account
  should be reported as needing attention, and re-running `claude` to refresh it must be
  picked up on the next read.

---

## Context: why this design

State on this machine before the rewrite:

- **0 profiles configured** in the Python app, yet its daemon was running (pid 67588)
  serving an empty pool — `current_profile_id: null`.
- **8 real accounts** sitting in the keychain the whole time.
- `codex` **not installed**.

The accounts were always there. The old tool asked you to register them into a parallel
system a directory away from where they already lived.
