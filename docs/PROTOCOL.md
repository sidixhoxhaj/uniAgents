# Protocol notes

Facts about how Anthropic and Claude Code actually behave. Every one of these
cost real measurement or debugging to find, and **none is guessable from the
code alone**. The TypeScript rewrite did not port the predecessor's 930 tests,
so this file is where that knowledge lives. Each entry names the code that
depends on it.

---

## Contents

- [General](#general)
  - [Never classify from a response body](#never-classify-from-a-response-body)
  - [Never retry after committing a byte](#never-retry-after-committing-a-byte)
- [Claude / Anthropic](#claude--anthropic)
  - [Rate-limit headers](#rate-limit-headers)
  - [429 must be classified per window](#429-must-be-classified-per-window)
  - [403 is not 401](#403-is-not-401)
  - [A 429 with no Retry-After is a spend cap](#a-429-with-no-retry-after-is-a-spend-cap)
  - [Overage is how a subscription silently becomes API spend](#overage-is-how-a-subscription-silently-becomes-api-spend)
  - [Strip `accept-encoding` on outbound requests](#strip-accept-encoding-on-outbound-requests)
  - [`metadata.user_id` is a JSON-encoded string](#metadatauser_id-is-a-json-encoded-string)
  - [Credential storage shapes](#credential-storage-shapes)
  - [Claude usage can be read for free — `/api/oauth/usage`](#claude-usage-can-be-read-for-free--apioauthusage)
  - [Claude model ids come from Claude Code's own catalog cache](#claude-model-ids-come-from-claude-codes-own-catalog-cache)
  - [`ANTHROPIC_AUTH_TOKEN` disables hosted connectors — so we never set it](#anthropic_auth_token-disables-hosted-connectors--so-we-never-set-it)
- [Codex](#codex)
  - [Codex: the ChatGPT backend](#codex-the-chatgpt-backend)
  - [Codex quota is driven by reasoning, not context](#codex-quota-is-driven-by-reasoning-not-context)
  - [Tool-calling round-trips correctly](#tool-calling-round-trips-correctly)
  - [A rejected model returns a plain JSON body, not SSE](#a-rejected-model-returns-a-plain-json-body-not-sse)
  - [Known gaps (not yet measured against the real backend)](#known-gaps-not-yet-measured-against-the-real-backend)

---

## General

### Never classify from a response body

`src/core/observation.ts`, `src/proxy/upstream.ts`

Classification reads **status and headers only**. That is precisely what allows
bodies to be forwarded as opaque streams, byte for byte, with no parsing or
buffering in the path.

### Never retry after committing a byte

`src/proxy/upstream.ts`, `src/proxy/gateway.ts`

`node:https` fires `'response'` after the header block and **before** the body
is read. `sendUpstream()` resolves at exactly that moment, so the caller can
classify and decide to rotate while the body is still untouched on the socket.

Once the body is piped to the client, the response is **committed** — no retry
may happen underneath it. A promise-based client that resolves with a buffered
body would destroy this property silently, which is why the transport is
hand-rolled rather than using `fetch()`.

---

## Claude / Anthropic

### Rate-limit headers

`src/core/observation.ts`

Anthropic returns unified rate-limit headers on every response:

```
anthropic-ratelimit-unified-status:          allowed | rejected
anthropic-ratelimit-unified-5h-status:       allowed | rejected
anthropic-ratelimit-unified-5h-reset:        1787191800     Unix EPOCH SECONDS
anthropic-ratelimit-unified-5h-utilization:  0.61           0-1 FLOAT
anthropic-ratelimit-unified-7d-status / -reset / -utilization:  same shapes
```

**Two shapes that are easy to get wrong, and silent when you do:**

- `-reset` is **epoch seconds**, not ISO 8601 and not milliseconds. Parsed as
  milliseconds, every reset time lands in 1970 and recovery fires instantly.
- `-utilization` is a **0–1 float**, not a remaining/limit pair. Read as a
  percentage directly, a 61%-spent account reports 0.61% and looks fresh
  forever.

There is no error either way — just wrong numbers and rotation that never fires.

### 429 must be classified per window

`src/core/observation.ts` → `classify()`

Check `-5h-status` and `-7d-status` **independently**. An account can have 5h
headroom while the weekly cap is what rejected the request. Collapsing them into
one check misclassifies quota exhaustion as a short rate limit, and the router
then cools down and retries the same dead account instead of rotating away.

A 429 with **neither** window rejected is a genuine short rate limit.

### 403 is not 401

`src/core/observation.ts` → `classify()`

- **401** `authentication_error` — the credential is rejected. Needs re-auth.
- **403** `permission_error` — the credential is valid but not allowed to do
  this specific thing, usually a model it is not scoped for.

Treating 403 as auth failure reports "needs re-authentication" over what is
really a model choice. 403 deliberately falls through to `unknown` and is
relayed to the client untouched.

### A 429 with no Retry-After is a spend cap

`src/core/router.ts` → `cooldownDeadline()`

Per Anthropic's documentation this is what a spend-cap/billing rejection looks
like: it keeps failing until access resumes, rather than clearing in seconds. A
flat retry interval hammers it indefinitely.

Back off exponentially from 30s, doubling per consecutive failure, capped at
1800s. A transient blip self-heals in a step or two; a genuinely stuck account
reaches the ceiling in about six failures. A **present** `Retry-After` is
trustworthy and honoured in full (capped only defensively).

### Overage is how a subscription silently becomes API spend

`src/core/observation.ts`, `src/core/router.ts`

When a subscription window fills, Anthropic does **not** reject the request. On
a plan with overage enabled it serves it anyway and bills the organisation's
API spend — which shows up in the Console as usage cost. Nothing in the
utilization percentage reveals this; `5h-status` still reads `allowed`.

```
anthropic-ratelimit-unified-overage-status:      allowed | ...
anthropic-ratelimit-unified-overage-utilization: 0.0     0-1 float
```

`overage-utilization > 0` is the ONLY signal separating "inside included
quota" from "now costing money", so the router treats it as `exhausted` and
rotates away, even though the request succeeded. A threshold on the window
percentage cannot catch this: overage begins exactly when the window is full,
and a threshold below 100% still leaves the account serving paid traffic
afterwards.

**Rotating between accounts in the same organisation does not help** — they
share one quota pool and one overage bill.

### Strip `accept-encoding` on outbound requests

`src/proxy/request.ts`

The `claude` CLI sends `accept-encoding: gzip, br` and Anthropic honours it.
Compressed bodies forward to the client fine — but nothing can read the usage
numbers out of them without a decoder in the path. The result is that every
window silently reports 0% and rotation never fires.

Dropping the header costs nothing on a loopback hop, and the server then
defaults to identity encoding.

### `metadata.user_id` is a JSON-encoded string

`src/proxy/request.ts` → `rewriteAccountUuid()`

Claude Code embeds `metadata.user_id` in the `/v1/messages` body as a **string
that is itself JSON**, containing `account_uuid` **alongside other fields (a
session id among them) that must be preserved**. It is not a bare uuid.

Rewrite only the nested `account_uuid`. Any unrecognised shape is passed through
untouched rather than guessed at.

### Credential storage shapes

`src/accounts/discover.ts`

Claude Code stores `{"claudeAiOauth": {accessToken, refreshToken, expiresAt,
scopes, subscriptionType}}`.

- `expiresAt` is epoch **milliseconds** — unlike the rate-limit headers above,
  which are epoch seconds. Mixing them up dates everything to 1970.
- **Not every `Claude Code-credentials-*` entry is an account.** Claude Code
  stores MCP connector tokens (Canva, Notion, Linear, GitHub, …) under the very
  same service-name pattern, shaped `{"mcpOAuth": {...}}` with no
  `claudeAiOauth`. Measured on a real machine: **6 of 8** matching entries were
  connector caches, not logins. Enumeration alone therefore over-reports badly;
  each candidate must be read and confirmed to carry `claudeAiOauth`, or the
  pool fills with entries that can never serve a request.
- On macOS the credential lives in the **Keychain**, not in a file, under
  service `Claude Code-credentials`. A login isolated by `CLAUDE_CONFIG_DIR`
  gets the suffix `sha256(configDir)[:8]`. That convention is what lets us
  discover isolated accounts without being told they exist.
- `security dump-keychain` **without `-d`** lists service names only and never
  prompts. Reading a value (`find-generic-password -w`) may prompt once per
  binary, so credentials are read once and held in memory for the process
  lifetime.

### Claude usage can be read for free — `/api/oauth/usage`

`src/accounts/probe.ts` — verified against two real accounts 2026-09-21.

Quota does **not** have to cost a request. This is the Anthropic counterpart
to Codex's `wham/usage`, and it is what `probeUsage()` tries first:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <access token>
anthropic-beta: oauth-2025-04-20
```

```json
{"five_hour": {"utilization": 43, "resets_at": "2026-09-21T12:30:00.132043+00:00",
                "limit_dollars": null, "locked_reason": null},
 "seven_day": {"utilization": 54, "resets_at": "2026-09-22T22:00:00.132062+00:00"},
 "extra_usage": {"is_enabled": true, "monthly_limit": 5000, "used_credits": 88,
                 "utilization": 1.76, "currency": "EUR", "spend_limit_reached": false}}
```

It is strictly richer than the response headers: real overage spend in
currency, a `locked_reason` per window, and a `limits[]` array naming which
window is `is_active`.

**Two shapes that differ from the headers, and are silent when confused:**

- `utilization` is **0–100 here**, not the headers' 0–1 float. Scaling it
  puts a 43%-spent account at 4300%.
- `resets_at` is an **ISO 8601 string**, not epoch seconds. Parsing one as
  the other dates every reset to 1970.

**It is private, undocumented, and rate-limited.** Measured: reading two
accounts back to back returned `429 rate_limit_error` on the second. So it
is a first choice, never the only one — anything but a clean 200 falls back
to the one-token Haiku request that reads the headers instead. A 401 is the
exception: that is a real answer about the credential and is reported as
`auth_invalid` rather than retried.

`extra_usage.is_enabled` only means overage is *available to spend*. The
`utilization` is what separates included from paid, which is the signal the
router actually acts on.

### Claude model ids come from Claude Code's own catalog cache

`src/accounts/models.ts` — read from a real machine 2026-09-21.

Claude Code caches the model catalog it renders its picker from:

```
~/.claude/cache/model-catalog/published-<hash>.json
  → document.surfaces.cc.model_selector_config[].models[]
```

Each entry carries the real `id` and a display `name` ("Opus 5"). Read them
rather than hardcoding: the dashboard's list had drifted to
`claude-haiku-4.5` and `claude-fable-5.1`, **neither of which is a real id**
(they are `claude-haiku-4-5-20251001` and `claude-fable-5-1`), so the parity
table was offering models that could never answer.

**`offered_on` is a deployment gate, not a plan gate.** Measured on this
machine, `claude-opus-4-1-20250805` lists only `bedrock` and `vertex` — a
first-party subscription login cannot serve it. Nine of the ten catalogued
models carry `first_party`; offering the tenth would let a user pick a model
that fails on every request. Filter on it.

The cache goes **stale within about an hour** (`staleAt` − `fetchedAt`) and
Claude Code refetches it from a hosted endpoint. uniAgents never refetches:
it is read-only, and a slightly stale list of real ids beats inventing one.
A missing or unparseable cache yields an empty list, never an error.

**The default model is published, not local.** The same document carries
`model_selector_state[0]` with `{"model": "claude-opus-5",
"selection_source": "global_default"}`, and the catalog is signed
(`rootId: claude-code-release-signing-key`). Measured on this machine:
`~/.claude/settings.json` has no `model` key and `~/.claude.json`'s
`orgModelDefaultCache` is `null` — there is no local setting to change.

`--model` is therefore the only supported way to start a session on
something else, which is what `src/cli/code.ts` does. Rewriting `model` on
each request is NOT a substitute: it makes `/model` appear broken, because
the user's mid-session choice is silently replaced on the very next call.

### `ANTHROPIC_AUTH_TOKEN` disables hosted connectors — so we never set it

`src/cli/code.ts`, `src/proxy/server.ts` → `authorised()`

Setting it makes Claude Code treat itself as having a custom auth source and
**silently drops every claude.ai-hosted MCP connector**. Measured on a real
machine 2026-09-21: 21 connectors became `No MCP servers configured` inside a
session, while `claude mcp list` outside the session listed all of them.

**`ANTHROPIC_BASE_URL` is innocent.** A three-way comparison isolates the
cause completely:

| Environment | `claude mcp list` |
|---|---|
| neither variable | 21 connectors, 10 `✔ Connected` |
| `ANTHROPIC_BASE_URL` only | **identical** — 21 connectors |
| both variables | ⚠ warning, `No MCP servers configured` |

So uniAgents sets the base URL and **not** the token. The CLI then sends its
**own** OAuth credential to the custom base URL — measured:
`Authorization: Bearer sk-ant-oat01-…`, matching the keychain credential
exactly — and the proxy authenticates callers by checking that token against
the accounts it discovered (`Gateway.authorisesCaller()`).

The port is loopback-only, so this gate exists to stop another process on the
same machine spending your quota, not to defend against the network. It is a
real check either way: a request with no bearer token, or one bearing a token
that belongs to no discovered account, is refused with 401.

None of this affects rotation. The proxy still chooses the serving account
per request and still replaces the inbound `Authorization` header with the
chosen account's — `STRIPPED_INBOUND` in `src/proxy/request.ts` has always
dropped whatever arrived, so what the caller sent is irrelevant downstream.

An earlier version of this file said "do not try to work around it". That was
wrong, and this entry supersedes it.

---

## Codex

### Codex: the ChatGPT backend

`src/codex/*` — all of the below verified against the real backend 2026-09-20.

**Endpoint** `POST https://chatgpt.com/backend-api/codex/responses`, requiring
`originator: codex_cli_rs`, a codex-shaped `User-Agent`, a `session-id`, and
`ChatGPT-Account-ID` for a subscription login (an API-key login must NOT send
it). `store: true` is refused outright with 400 — it is fixed to false.

**Model names are account-specific and they drift.** The predecessor hardcoded
`gpt-5.1-codex`; this account rejects it with
`400 "The 'gpt-5.1-codex' model is not supported when using Codex with a
ChatGPT account"`. The usable ids were read from the CLI's own
`~/.codex/models_cache.json` — on this account `gpt-5.6-terra`, `gpt-5.6-luna`,
`gpt-5.6-sol`, `gpt-5.5`. Discover them at runtime; never trust a constant.

**The quota headers are nothing like Anthropic's**, and every difference is
silent rather than an error:

```
x-codex-primary-used-percent:         0-100 INTEGER   (Anthropic: 0-1 float)
x-codex-primary-reset-after-seconds:  SECONDS FROM NOW (Anthropic: epoch secs)
x-codex-credits-has-credits:          "True" | "False" (Python-cased, not JSON)
x-codex-plan-type:                    e.g. enterprise_cbp_usage_based
```

- Scaling the percentage by 100 puts a 12%-used account at 1200%.
- Treating the reset as an epoch dates it to 1970.
- A **credit-based** plan out of credits is `quota_exhausted`, not
  `rate_limited`: backing off never helps, because waiting does not add
  credits. On such a plan all window fields read `0`, which must mean "no
  window", not "resets right now".

**Read usage from the account, not from response headers.**

```
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <access token>
ChatGPT-Account-ID: <account id>
OpenAI-Beta: codex-1
```

This is what the ChatGPT UI itself shows, and it costs no quota to read. It is
a PRIVATE endpoint used by Codex's own clients, not a documented API, so every
field is parsed defensively and a failure degrades to "no usage reported".

`spend_control.individual_limit` carries the real numbers, and **they arrive as
JSON strings, not numbers**:

```json
{"unit":"credit","limit":"1250","used":"8.943729996681213",
 "used_percent":1,"reset_at":1790812801}
```

The response-header route is a dead end on a credit-based plan: every window
field (`primary-used-percent`, `window-minutes`, `reset-after-seconds`) reads
`0`, so the bars would sit permanently empty and look like a bug. Headers also
come back ONLY on an accepted request — a rejected one returns none — and
`max_output_tokens` cannot shrink such a probe, since any value is rejected
with 400.

**SSE events.** The backend emits exactly nine types:
`response.created`, `response.in_progress`, `response.output_item.added`,
`response.content_part.added`, `response.output_text.delta`,
`response.output_text.done`, `response.content_part.done`,
`response.output_item.done`, `response.completed`.

Only four matter for translation: `created` opens the message, `output_text.delta`
streams text, `output_item.done` carries a complete `function_call` (arguments
arrive whole, not streamed), and `completed` carries the usage totals.

**Terminal events must be emitted exactly once.** Both `response.completed` and
a stream that simply ends route through one guarded `end()`; without the guard
a normal completion emitted `message_delta`/`message_stop` twice, which was
visible in a real transcript.

### Codex quota is driven by reasoning, not context

Carried forward from the predecessor's ADR 0007 (which corrected ADR 0006 by
reading the real Rust client):

- Codex quota is spent on **reasoning tokens produced × model tier**, not on
  context size. Re-sending conversation history is not what drains it.
- The subscription backend refuses `store: true` and does not chain over HTTP.
  The real client chains over a **WebSocket**. Do not reintroduce
  `previous_response_id` chaining as a quota optimisation — it was measured and
  it does not help.

### Tool-calling round-trips correctly

`src/codex/bridge.ts`, `src/codex/translate.ts`, `src/codex/response.ts` —
verified against the real backend 2026-09-21.

A real request with a `get_weather` tool and `tool_choice: {"type":"any"}`,
sent through the actual `sendCodex` → `translateStream` → `ResponseTranslator`
path (not just the `codex` CLI's own agent loop), produced correct Anthropic
SSE:

```
content_block_start  { type: "tool_use", id: "call_…", name: "get_weather" }
content_block_delta  { type: "input_json_delta", partial_json: "{\"city\":\"Paris\"}" }
message_delta        { stop_reason: "tool_use" }
```

This was previously "in theory only." It no longer is: the arguments arrive
whole in one `output_item.done` (as documented above) and `translate.ts`
reconstructs a valid `tool_use` block from them.

**MCP tools work on the Codex path too** — verified 2026-09-21 with a real
connector-shaped name, `mcp__claude_ai_Figma__get_design_context`. The
double-underscore convention is not rejected, and the name survives the
round trip byte for byte.

Nothing about MCP is special on the wire, which is why this works: Claude
Code resolves each connector's tools and declares them as ordinary `tools`
entries, `mapTools()` maps them like any other, and the model only ever
answers "call this one with these arguments". **Codex never contacts the
connector.** Claude Code executes the call locally against your claude.ai
login, so connector auth is independent of which pooled account served the
turn.

### A rejected model returns a plain JSON body, not SSE

`src/codex/observation.ts` → `classifyCodex()` — verified 2026-09-21.

Sending a model name the backend refuses (`gpt-5.1-codex`, per above) returns:

```
HTTP 400, no Retry-After
Content-Type: application/json (not text/event-stream)
{"detail":"The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account."}
```

`classifyCodex()` has no explicit 400 branch, so this correctly falls through
to `{ kind: 'unknown', statusCode: 400 }` and is relayed to the client
untouched — the same treatment Claude's 403 gets, and for the same reason: a
400 is a request-shape problem, not a quota or auth signal, so the router
must not act on it. In practice `modelFor()` prevents this from happening
with real traffic — it falls back to a known-available model before the
request is ever sent — so this path is defence in depth, not a live route.

### Known gaps (not yet measured against the real backend)

The Codex section above is shorter than Claude's not because Codex has fewer
sharp edges, but because it was added later. Tool-calling and one 400 shape
are now measured; this is what is still open:

- **429 / backoff shape is unmeasured on purpose.** Triggering a real
  quota-exhausted 429 means running a live account's credits to zero, which
  costs real money for a documentation fact. Checked on 2026-09-21: this
  account sits at 1% of a 1,250-credit monthly allowance
  (`fetchCodexUsage()` — costs no quota to read), so grinding it to
  exhaustion was deliberately not done. Whether Codex's 429 carries a
  trustworthy `Retry-After`, and whether Anthropic's 30s→30min curve is the
  right shape for a credit-based plan where waiting adds no credits, remains
  unverified against a live response.
- **Error classification beyond 400/401/429 is unexplored.** No equivalent
  yet to Claude's "403 is not 401" distinction — whether any Codex status
  code needs that same granularity is unknown.
