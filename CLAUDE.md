# CLAUDE.md

Context for working on uniAgents. Read this before changing anything; the
companion docs carry the details it points at.

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — wire-format facts that are **silent
  when you get them wrong**. Required reading before touching `core/`,
  `proxy/` or `codex/`.
- [`docs/STORAGE.md`](docs/STORAGE.md) — what is written to disk and why.
- [`docs/MULTIPLE-CLAUDE-CODE-ACCOUNTS.md`](docs/MULTIPLE-CLAUDE-CODE-ACCOUNTS.md) — how a user gets
  more than one account onto a machine, and why the config directory looks
  empty when it worked.
- [`docs/PHASE0-SPIKE.md`](docs/PHASE0-SPIKE.md) — the two experiments the
  whole design rests on, with their measured results.
- [`INSTALLATION.md`](INSTALLATION.md) — how a new user gets `unicode` onto their
  machine and verifies it found their accounts.

---

## What this is

A launcher. You already have Claude and Codex accounts logged in on this
machine; uniAgents pools them so one hitting its limit does not end your
session.

```
unicode           start a session that rotates accounts as limits hit
unicode usage     real subscription usage per account, in the terminal
unicode status    what accounts exist (--check verifies each credential)
```

While a session runs, a read-only dashboard is served on the same port.

### The four rules that shape everything

1. **No login.** Accounts come from wherever the real `claude` / `codex` CLIs
   put them. uniAgents never runs an OAuth flow.
2. **Credentials are never written.** They stay in the Keychain (macOS) or
   `.credentials.json` (Linux) and are read without being copied. This is the
   security property worth protecting; "stores nothing at all" was only ever a
   simplicity claim, and it was dropped when it started costing features.
3. **Zero runtime dependencies.** Node's standard library only. For a process
   that reads your auth tokens, an empty supply chain is a feature.
4. **The terminal is the product.** The dashboard is read-only for accounts
   and history; the only things it writes are preferences.

macOS and Linux. Windows is deliberately unsupported — it would need a DPAPI
backend nobody here can verify on real hardware.

---

## Layout

```
src/core/       pure logic: rotation and response classification. NO I/O.
src/accounts/   read-only account discovery, identity, usage probe
src/codex/      the ChatGPT/Codex path: credential, translation, bridge, usage
src/proxy/      server, gateway, upstream transport, request building
src/store/      config, append-only history, aggregation for the Logs page
src/dashboard/  static assets (HTML + CSS + JS), served from disk
src/cli/        the three commands
```

**`src/core/` performs no I/O** — no network, no disk, no clock of its own.
Everything is passed in. That rule is what makes rotation deterministically
testable, and it is worth defending.

Node strips TypeScript natively, so there is **no build step**. `tsc` is a
type checker here, never a compiler. `npm test` runs the real source.

---

## Non-obvious decisions

### Rotation

- **Sticky.** Stay on the current account until it is actually spent.
- **A bare rate limit is a cooldown, never a rotation.** Rotating on a blip
  abandons a healthy account.
- **A 429 with no `Retry-After` is a spend cap**, not a blip — exponential
  backoff from 30s, capped at 30 minutes. A flat retry hammers it forever.
- **Overage means exhausted.** When a subscription window fills, Anthropic
  does not reject the request; it bills paid overage. `overage-utilization > 0`
  is the only signal separating "included" from "costing money", so the router
  treats it as exhausted. A switch threshold cannot substitute: overage begins
  exactly at 100%.
- **A disabled account is a user decision.** No observation of any kind may
  return it to rotation — a background usage probe used to silently undo it.

### The invariant the proxy exists to protect

**Never retry after committing a byte.** `node:https` fires `'response'` after
the header block and before the body is read, so `sendUpstream()` resolves
exactly there: the caller classifies and decides to rotate while the body is
still untouched on the socket. Once it is piped, the response is committed.

A promise-based client that resolves with a buffered body would destroy this
silently. That is why the transport is hand-rolled rather than `fetch()`.

### Never set `ANTHROPIC_AUTH_TOKEN`

It disables every claude.ai-hosted MCP connector — measured: 21 connectors
became "No MCP servers configured" inside a session. `ANTHROPIC_BASE_URL`
alone does not; the token is the sole cause.

So the proxy authenticates callers by checking the OAuth credential the CLI
already sends (`Gateway.authorisesCaller()`), rather than by injecting one.
A request bearing no token, or a token belonging to no discovered account,
gets a 401. The port is loopback-only, so this guards against other local
processes, not the network.

Re-adding the env var would silently cost the user every connector they
have. See `docs/PROTOCOL.md` for the measured three-way comparison.

### The starting model is set with `--model`, never by rewriting requests

**Nothing is forced by default.** `config.activeModel` is `null` out of the
box, so no `--model` is passed and the session starts on the user's own
Claude Code default — the one they chose with `/model`, saved against their
account. uniAgents is a launcher, not a model manager.

When a model *is* picked on the dashboard it is passed to the spawned CLI as
`--model` (`src/cli/code.ts` → `withDefaultModel()`). An explicit `--model`
in the user's own arguments always wins over both.

The `(default)` marker inside `/model` is the user's **account preference**
and is not ours to change — it is synced server-side, not stored in any
local file (`settings.json` has no `model` key; `~/.claude.json`'s
`orgModelDefaultCache` is null). `--model` changes what a session *runs*,
never what that marker says.

**Do not reintroduce a per-request model rewrite.** It was tried: the proxy
overwrote the body's `model` on every request, which meant `/model` inside a
running session appeared to do nothing — the user switched, and the next
request silently replaced their choice. It also left the status line showing
one model while another answered. Setting the model at launch keeps the
session honest and leaves `/model` working normally.

Model lists are **never hardcoded** — on either side. See the catalog entry
in `docs/PROTOCOL.md` for why: the constants that used to live in the
dashboard had drifted to ids that do not exist.

### Dashboard

- The account **state pill has two values**: eligible below 95% usage,
  exhausted at or above. The router tracks finer states internally, but those
  are mechanisms, not answers.
- Every pooled account gets a calendar row, including ones with no usage — a
  missing row reads as a missing account.
- Calendar shading is scaled to an account's busiest day **across all three
  months**, so the grids are comparable rather than each scaled to itself.
- Provider logos are **inlined**. The page CSP allows no external origin, and
  an image blocked by CSP renders nothing *and logs nothing*.

---

## Storage

`~/.uniagents/` — four plain-text files, `$UNIAGENTS_HOME` overrides.

```
config.json      aliases, rotation order, enabled, parity, settings
usage.jsonl      one line per account per day
activity.jsonl   one line per event
cache.json       last usage snapshot (reserved)
```

- `config.json` is written **atomically** (temp file + rename).
- History is **append-only**: a crash costs at most the final partial line, and
  the reader skips anything that will not parse.
- **A failed write never fails a request.** It warns once and the session
  continues.
- The daily file holds a running total appended repeatedly, so the **last line
  for a day wins** on read. Summing would multiply-count every request.
- Nothing is discarded. Measured: ~13 MB/year at 200 events/day, ~65 MB at
  1,000/day. Unbounded by design — revisit if anyone reports a large file.

**The per-day calendar can never be backfilled.** No provider reports daily
history, so whatever day recording started is the earliest the Logs page can
ever show.

---

## Bugs that cost real time — do not reintroduce

Each of these shipped, was found the hard way, and has a regression test.

**Appends must land in call order.** `append()` awaited `ensureDataDir()`
*before* joining the per-file write chain, so rapid calls entered it out of
sequence. Every line still landed — a "nothing lost" check passed — but a
running total could be overwritten by an older value, so Codex credits read
back stale. The chain is now joined synchronously.

**Writes must be tracked synchronously.** `flush()` could resolve while a
write was still inside an earlier await and therefore not yet in `pending` —
losing the last writes of a clean shutdown.

**A usage snapshot with no reset header must not clobber a known reset.**
Recovery needs a reset time to compare against; overwriting it with null
stranded draining accounts out of rotation until restart.

**403 is not 401.** 401 means the credential is rejected; 403 means it is
valid but not permitted for *this model*. Conflating them reports "needs
re-authentication" over a model choice.

**429 must be classified per window.** Check `-5h-status` and `-7d-status`
independently — collapsing them misreads a weekly-cap rejection as a short
rate limit and retries a dead account.

**Strip `accept-encoding` outbound.** Otherwise responses arrive compressed
and nothing can read usage out of them: every window silently reports 0%.

**Not every `Claude Code-credentials-*` keychain entry is an account.** Claude
Code stores MCP connector tokens under the same service-name pattern. Measured
on a real machine: 6 of 8 matching entries were connector caches. Each
candidate must be read and confirmed to carry `claudeAiOauth`.

**Codex model names drift per account.** The predecessor hardcoded
`gpt-5.1-codex`, which this backend now rejects outright. Read them from the
CLI's own `models_cache.json`.

**Node's strip-only TypeScript cannot run parameter properties.** They
typecheck and then crash at runtime. `erasableSyntaxOnly` catches it now.

---

## Testing

```bash
npm test        # 130 tests, no network, no keychain, no real claude binary
npm run typecheck
```

- **`test/store.test.ts` runs serially.** `UNIAGENTS_HOME` is process-wide, so
  concurrent sandboxes redirect each other's writes.
- `Activity` takes its log writer as a constructor argument specifically so a
  test can bind it to its own module instance.
- `test/page.test.ts` guards the things that fail **silently** in a static
  page: every id the script fills exists in the HTML, every identified button
  is referenced by the script, every `/api/` path it fetches is a real route,
  every function it calls is defined, every hex colour is valid, and no mock
  data survived the port from the prototype.

When a test looks flaky, **investigate the assertion before touching the
harness**. Two real storage bugs hid behind exactly that assumption here, and
`12.5 !== 20` was telling me a write had been overwritten for three attempts
before I listened.

---

## Verification habits that earned their keep

- **Check against the live provider, not the docs.** The Codex endpoint, its
  model names, its credit shape, and Anthropic's overage headers were all
  found by probing a real account.
- **Prove a guard catches its own motivating bug.** The undefined-function
  test was blind to `clock()` because it stripped template literals — where
  the call lived. Deleting the function and confirming the test fails is the
  only way to know.
- **Verify by identity, not by position.** `view()[0]` is not a stable
  account: the `~/.claude` default login can change between sessions.

---

## Known gaps

- **Rotation has never fired against a real exhausted account** end to end.
  It is covered by tests against a fake 429 server, and both live paths work
  separately, but the seam is unproven.
- **Linux is written but unrun.** The file-discovery path is correct by
  construction; no Linux machine has executed it.
- **Codex's 429/backoff shape is unmeasured against a live account** —
  deliberately: forcing a real quota-exhausted response means spending real
  credits. Tool-calling and one 400 shape are now verified against the real
  backend; see `docs/PROTOCOL.md`'s Codex section.
- **Provider logos should move to a CDN** — see the `TODO(cdn)` in
  `src/dashboard/serve.ts` for the two changes that must land together.
