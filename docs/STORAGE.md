# Storage

What uniAgents keeps on disk, and why.

The tool started by storing **nothing**. That was the right default, but it has a
cost the dashboard made obvious: kill the session and your aliases, your
rotation order, your settings and every number on the Logs page are gone. Some
of that can be re-fetched. Most of it cannot.

---

## Contents

- [What can and cannot be recovered](#what-can-and-cannot-be-recovered)
- [The rule that does not change](#the-rule-that-does-not-change)
- [Layout](#layout)
- [Retention: keep everything](#retention-keep-everything)
- [Write timing: immediately](#write-timing-immediately)
- [What this does not change](#what-this-does-not-change)

---

## What can and cannot be recovered

| Data | Survives today | Can it be re-fetched? |
|---|---|---|
| Current usage %, credits, reset times | ✗ | **Yes** — probed at startup in ~700 ms |
| Profile aliases, order, enabled/disabled | ✗ | **No** — only the user knows these |
| Model parity, notifications, language | ✗ | **No** |
| Activity log | ✗ | **No** |
| Per-day usage, model and project totals | ✗ | **No** — no provider exposes history |

The per-day calendar is the sharp case: **neither Anthropic nor OpenAI reports
daily history**, so it cannot be backfilled at any point in the future. It
exists only if recorded as it happens, which means the first day of recording is
the earliest day that page can ever show.

---

## The rule that does not change

**Credentials are never written.** They stay where the official CLIs put them —
the macOS Keychain, or `<config dir>/.credentials.json` — and uniAgents reads
them without ever copying them anywhere.

That property is worth stating precisely, because it is the one that matters:
uniAgents has no credential vault, so there is no new place for a token to leak
from. "Stores nothing at all" was a simplicity claim, not a security one, and it
was costing real features.

---

## Layout

```
~/.uniagents/
  config.json      profiles (alias, order, enabled), parity, settings
  usage.jsonl      one line per account per day
  activity.jsonl   one line per event
  cache.json       last-known usage, so the page is populated before the first probe
```

A visible directory in `$HOME`, matching what `claude` and `codex` already do
(`~/.claude`, `~/.codex`). It can be inspected with `cat`, backed up by copying,
and reset with `rm -rf` — no database, no binary format, no migration tool.

`$UNIAGENTS_HOME` overrides the location.

### `config.json`

Everything the user chose. Small, rewritten atomically on each change (write to
a temp file, then rename — so a crash mid-write cannot corrupt it).

```json
{
  "version": 1,
  "profiles": {
    "Claude Code-credentials": { "alias": "Personal", "order": 1, "enabled": true }
  },
  "parity": [{ "claude": "claude-opus-5", "gpt": "gpt-5.6-terra" }],
  "settings": { "language": "en", "theme": "auto", "notifications": { "rotated": true } },
  "activeModel": "claude-sonnet-5"
}
```

`activeModel` is the model a new session **starts** on, passed to the CLI as
`--model`. It defaults to `null`, meaning **pass nothing**: the session
starts on whatever the user's own Claude Code default is.

That default is deliberate. uniAgents is a launcher, not a model manager —
the user already has a model preference, set with `/model` and saved to
their account, and quietly overriding it on every launch is what made
`/model` feel broken. Picking a model on the dashboard is an opt-in.

It is never an override mid-session either: `/model` switches freely and
nothing re-imposes this value. Absent, `null` and `""` all mean the same
thing — force nothing.

Keyed by the account's **discovery id** (its keychain service name or credentials
path), which is stable across restarts. An id that no longer resolves is kept,
not deleted: a login may be temporarily unreadable, and silently dropping a
user's alias because a keychain read failed once would be worse than a stale
entry.

### `usage.jsonl` and `activity.jsonl`

Append-only, one JSON object per line. Append is the right shape here: a crash
can cost at most the final partial line, never the file, and the reader simply
skips a line that will not parse.

```jsonl
{"date":"2026-09-20","accountId":"…","inputTokens":1284000,"outputTokens":392000,"requests":214}
{"at":"2026-09-20T18:42:11Z","kind":"request","accountId":"…","inputTokens":6412,"outputTokens":1187,"durationMs":8730}
```

### `cache.json`

Purely an optimisation: the last usage snapshot, so the dashboard shows real
numbers the instant it opens rather than waiting on the startup probe. Safe to
delete; it is rebuilt within a second.

---

## Retention: keep everything

Nothing is discarded. Measured against a real activity line (187 bytes):

| Activity | Per year |
|---|---|
| 200 events/day | 13 MB |
| 1,000 events/day | 65 MB |
| 5,000 events/day | 326 MB |

Daily usage is negligible — about **150 KB/year** for three accounts.

So the honest summary is that ordinary use costs tens of megabytes a year, and
heavy use could reach a few hundred. That is acceptable for plain text the user
can delete at any time, but it is unbounded by design, and worth revisiting if
anyone reports a large file. A retention setting is the obvious escape hatch if
it becomes a problem.

---

## Write timing: immediately

Settings are written the moment they change; usage and activity append as they
happen. A `Ctrl+C`, a crash, or a reboot loses nothing.

This is affordable because the writes are tiny and append-only — a single event
is one 187-byte append, not a rewrite. Batching would trade that guarantee for a
saving that does not matter at this volume, and the whole point of this document
is the session that ends unexpectedly.

Two details that make it safe rather than merely fast:

- **`config.json` is written atomically** (temp file + rename), so an interrupted
  write cannot leave a truncated config that fails to parse on next start.
- **A failed write never fails a request.** Persistence is bookkeeping; if the
  disk is full or the directory is read-only, uniAgents logs it once and keeps
  proxying. Losing the log is annoying, losing the session is not acceptable.

---

## What this does not change

- No login, and no credential storage.
- Nothing leaves the machine.
- The account list is still **discovered**, not managed. `config.json` records
  your preferences *about* accounts (name, order, enabled); it never defines
  which accounts exist. Removing an account still means removing its config
  directory — which is why the dashboard has no "delete profile" button.
