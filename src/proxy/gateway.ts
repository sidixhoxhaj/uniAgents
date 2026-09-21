/**
 * Orchestrates one request: pick an account, send it, classify the answer,
 * rotate and retry on failure.
 *
 * All rotation state lives IN MEMORY, for the lifetime of the process. Nothing
 * is written to disk — that is the point of the tool. The cost is that a fresh
 * start knows nothing and will try a spent account once before learning it is
 * spent. One wasted request per account per start, and it self-corrects.
 *
 * Single-threaded by construction: Node's event loop means no locks, and the
 * whole class of races the threaded Python version had cannot occur here.
 */

import { EventEmitter } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { classify, filterResponseHeaders } from '../core/observation.ts';
import type { Observation } from '../core/observation.ts';
import { choose, observe, recoverExpired } from '../core/router.ts';
import type { AccountRuntime, Snapshot } from '../core/router.ts';
import { discoverAccounts, readCredential, isExpired } from '../accounts/discover.ts';
import type { DiscoveredAccount, Credential } from '../accounts/discover.ts';
import { loadClaudeModels } from '../accounts/models.ts';
import { buildUpstreamRequest } from './request.ts';
import { sendUpstream, UpstreamError } from './upstream.ts';
import { readCodexCredential, CodexError } from '../codex/credential.ts';
import type { CodexCredential } from '../codex/credential.ts';
import { sendCodex, translateStream, CodexTransportError } from '../codex/bridge.ts';
import { classifyCodex, filterCodexHeaders } from '../codex/observation.ts';
import { loadAvailableModels } from '../codex/models.ts';
import { fetchCodexUsage } from '../codex/usage.ts';
import type { CodexUsage } from '../codex/usage.ts';
import { fetchIdentity, planLabel } from '../accounts/identity.ts';
import { probeUsage } from '../accounts/probe.ts';
import type { AccountIdentity } from '../accounts/identity.ts';
import { Activity } from './activity.ts';
import { loadConfig, saveConfig } from '../store/config.ts';
import type { Config, ProfileConfig } from '../store/config.ts';
import { countingTee } from './usage.ts';

const MAX_ATTEMPTS = 4; // bounded: never loop the whole pool forever on a bad run
const DEFAULT_SWITCH_THRESHOLD = 98;

export interface GatewayResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** A relayed upstream response, or a translated Codex stream. */
  body: Readable | null;
  accountId: string | null;
  error?: string;
}

/** Marks the single pooled Codex account, if one is signed in. */
export const CODEX_ID = 'codex:chatgpt';

/** One selectable model, merged across every account in the pool. */
export interface ModelOption {
  id: string;
  /** Display name where the catalog gives one; the id otherwise. */
  name: string;
  section: string;
  kind: 'claude' | 'codex';
}

interface Attempt {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  observation: ReturnType<typeof classify>;
  /** Deferred: calling this COMMITS the response. */
  body: () => Readable;
  discard: () => void;
}

export interface AccountView {
  id: string;
  label: string;
  state: AccountRuntime['state'];
  priority: number;
  usagePercent: number | null;
  usagePercent7d: number | null;
  resetsAt: string | null;
  resetsAt7d: string | null;
  /** Percent into paid overage; why an account can be out of rotation while
   *  its window still shows headroom. */
  overagePercent: number;
  active: boolean;
  kind: 'claude' | 'codex';
  /** Human identity, when the profile lookup succeeded. */
  email: string | null;
  plan: string | null;
  /** Requests served by this account this session. */
  requests: number;
  /**
   * For a plan metered by credits rather than a rolling window, the windows
   * are meaningless (they all read 0) and this says so instead.
   */
  quotaNote: string | null;
  /** Credit balance for a metered plan, so the page can draw a real bar. */
  credits: { used: number; limit: number; remaining: number; unit: string } | null;
}

export class Gateway extends EventEmitter {
  private snapshot: Snapshot = { accounts: [], currentId: null };
  private discovered = new Map<string, DiscoveredAccount>();
  /** Credentials are read once and held for the process lifetime: a keychain
   *  read can prompt, and doing it per request would be unusable. */
  private credentials = new Map<string, Credential>();
  private codexCredential: CodexCredential | null = null;
  private identities = new Map<string, AccountIdentity>();
  /** User preferences: aliases, rotation order, which accounts are in the pool. */
  private config: Config = { version: 1, profiles: {}, parity: [], settings: { language: 'en', theme: 'auto', notifications: {} }, activeModel: null };
  private codexUsage: CodexUsage | null = null;
  readonly activity = new Activity();
  /**
   * Which project this session belongs to — the directory `unicode` was run
   * in. Fixed for the process, so it is read once rather than per request.
   */
  private readonly project = basename(process.cwd()) || null;
  readonly startedAt = new Date();

  async init(): Promise<void> {
    // Preferences and today's running totals come back first, so a restart
    // resumes where the last session stopped rather than starting blank.
    this.config = await loadConfig();
    await this.activity.restore();

    const accounts = await discoverAccounts();
    this.discovered = new Map(accounts.map((a) => [a.id, a]));

    // A Codex login, if `codex` is signed in, joins the same pool. It sorts
    // LAST: a Claude subscription serves Claude requests natively, while the
    // Codex path has to translate every byte in both directions.
    const ids = accounts.map((a) => a.id);
    try {
      this.codexCredential = await readCodexCredential();
      await loadAvailableModels();
      ids.push(CODEX_ID);
    } catch {
      this.codexCredential = null; // not signed in: simply not in the pool
    }

    // Rotation order is the user's, when they have set one. Discovery order is
    // only the fallback for an account seen for the first time, and it sorts
    // after everything already positioned.
    const ordered = [...ids].sort((a, b) => this.orderOf(a, ids) - this.orderOf(b, ids));

    this.snapshot = {
      currentId: null,
      accounts: ordered.map((id, i) => ({
        id,
        priority: i + 1,
        switchThreshold: DEFAULT_SWITCH_THRESHOLD,
        state: 'eligible',
        usagePercent: null,
        usagePercent7d: null,
        cooldownUntil: null,
        resetsAt: null,
        resetsAt7d: null,
        overagePercent: 0,
        unretryableStreak: 0,
      })),
    };

    // Credentials first, and AWAITED: these are local reads (keychain or
    // file), and `authorisesCaller()` needs them populated before the very
    // first request arrives or it answers 401.
    await Promise.all(accounts.map((a) => this.primeCredential(a)));

    // A disabled account stays discovered but out of rotation. Applied
    // BEFORE priming: an observation arriving for a disabled account must
    // find it already marked, or `apply()` would treat it as eligible.
    for (const account of this.snapshot.accounts) {
      if (this.config.profiles[account.id]?.enabled === false) account.state = 'disabled';
    }

    // Identity AND current quota, up front. Quota only ever arrives on a
    // response header, so without this the stats page would show empty bars
    // until you happened to send something — which is exactly when you are
    // least interested in looking at it.
    //
    // All accounts in parallel, all failures swallowed: this is decoration
    // and a diagnostic, never a precondition for serving traffic.
    //
    // NOT awaited — that is the point. These are two network round-trips per
    // account, and the usage probe falls back to a request with a 15s
    // timeout, so awaiting them held the port shut for seconds before
    // `claude` could send anything. Since they only populate labels and the
    // dashboard's bars, they now fill in behind the session: the pool serves
    // traffic immediately and the numbers appear a moment later. Each result
    // pushes a `usage` event, so the page updates as they land.
    void Promise.all([
      ...accounts.map((a) => this.prime(a)),
      this.primeCodex(),
    ]).then(() => this.emit('usage', this.view()));
  }

  /**
   * Re-sort the pool by the user's saved order and renumber priorities.
   * Rotation reads `priority`, so this is what makes a drag take effect.
   */
  private applyOrder(): void {
    const ids = this.snapshot.accounts.map((a) => a.id);
    const accounts = [...this.snapshot.accounts]
      .sort((a, b) => this.orderOf(a.id, ids) - this.orderOf(b.id, ids));
    accounts.forEach((a, i) => { a.priority = i + 1; });
    this.snapshot = { ...this.snapshot, accounts };
  }

  /** A stored position, or discovery order for an account not seen before. */
  private orderOf(id: string, ids: string[]): number {
    const stored = this.config.profiles[id]?.order;
    return stored && stored > 0 ? stored : 1000 + ids.indexOf(id);
  }

  /** The user's settings, for the dashboard. */
  get preferences(): Config {
    return this.config;
  }

  /**
   * Every model the pool can actually serve, deduplicated.
   *
   * Claude accounts all read the same catalog, so two pooled Claude logins
   * contribute one set rather than two — the dedupe is by model id, which is
   * what makes duplicate accounts invisible here. Codex contributes its own
   * ids, which never collide with Claude's.
   */
  async models(): Promise<ModelOption[]> {
    const out = new Map<string, ModelOption>();

    if (this.hasClaudeAccount) {
      for (const m of await loadClaudeModels()) {
        out.set(m.id, { id: m.id, name: m.name, section: m.section, kind: 'claude' });
      }
    }
    if (this.codexCredential !== null) {
      for (const id of await loadAvailableModels()) {
        out.set(id, { id, name: id, section: 'codex', kind: 'codex' });
      }
    }
    return [...out.values()];
  }

  /** Whether any pooled account is a Claude login rather than Codex. */
  private get hasClaudeAccount(): boolean {
    return this.snapshot.accounts.some((a) => a.id !== CODEX_ID);
  }

  /**
   * Force a model onto every request, or clear the override with null. Takes
   * effect on the next request; nothing about the running session restarts.
   */
  async setActiveModel(model: string | null): Promise<boolean> {
    // Only a model the pool can actually serve. A typo reaching this far
    // would fail every request until someone noticed, so it is refused here
    // rather than at the provider.
    if (model !== null && !(await this.models()).some((m) => m.id === model)) return false;

    this.config.activeModel = model;
    this.activity.record({
      kind: 'config', accountId: null,
      text: model === null ? 'Model override cleared' : `Model set to ${model}`,
      meta: model === null ? 'requests use what the client asks for' : 'applies to every request',
    });
    const ok = await saveConfig(this.config);
    this.emit('usage', this.view());
    return ok;
  }

  /** Update one account's alias / order / enabled state and persist it. */
  async setProfile(id: string, changes: Partial<ProfileConfig>): Promise<boolean> {
    const current = this.config.profiles[id] ?? { alias: null, order: 0, enabled: true };
    this.config.profiles[id] = { ...current, ...changes };

    if (changes.enabled !== undefined) {
      const account = this.snapshot.accounts.find((a) => a.id === id);
      // Re-enabling returns it to service immediately; the next response
      // corrects its state if it is actually spent.
      if (account) account.state = changes.enabled ? 'eligible' : 'disabled';

      // Disabling the account that is CURRENTLY SERVING must also clear
      // `currentId`. `choose()` already refuses to return a non-eligible
      // account, so rotation itself was correct — but leaving the pointer
      // behind meant the dashboard kept drawing the disabled account as
      // active, and the hand-over was logged as though the disabled account
      // had been serving up to that moment. Clearing it here makes the
      // switch immediate and visible on the next request.
      if (changes.enabled === false && this.snapshot.currentId === id) {
        this.snapshot = { ...this.snapshot, currentId: null };
      }
    }

    // A new order has to be applied to the LIVE pool, not merely saved.
    // Writing it to disk alone meant the change only took effect on the next
    // restart, so dragging a card appeared to do nothing.
    if (changes.order !== undefined) this.applyOrder();
    // Log what the user actually changed, so the Config filter is not empty
    // and a setting can be traced back later.
    const what = changes.alias !== undefined ? `renamed to "${changes.alias ?? '(email)'}"`
      : changes.enabled !== undefined ? (changes.enabled ? 'added to the pool' : 'removed from the pool')
      : changes.order !== undefined ? `moved to position ${changes.order}`
      : 'updated';
    this.activity.record({ kind: 'config', accountId: id, text: this.labelFor(id), meta: what });

    const ok = await saveConfig(this.config);
    this.emit('usage', this.view());
    return ok;
  }

  /** Replace the model parity table and persist it. */
  async setParity(parity: Config['parity']): Promise<boolean> {
    this.config.parity = parity;
    this.activity.record({
      kind: 'config', accountId: null,
      text: 'Model parity updated', meta: `${parity.length} mapping${parity.length === 1 ? '' : 's'}`,
    });
    return saveConfig(this.config);
  }

  /** Update settings (language, theme, notifications) and persist them. */
  async setSettings(settings: Partial<Config['settings']>): Promise<boolean> {
    this.config.settings = { ...this.config.settings, ...settings };
    this.activity.record({
      kind: 'config', accountId: null,
      text: 'Settings updated', meta: Object.keys(settings).join(', '),
    });
    return saveConfig(this.config);
  }

  /**
   * Codex usage comes from the account's own usage endpoint rather than from
   * response headers: it costs no quota to read, and on a credit-based plan
   * the headers report nothing usable (every window field reads 0).
   */
  private async primeCodex(): Promise<void> {
    if (this.codexCredential === null) return;
    const usage = await fetchCodexUsage(this.codexCredential);
    if (!usage) return;

    this.codexUsage = usage;
    // Codex bills credits against an allowance, so the day's spend is tracked
    // from the balance rather than from token counts.
    if (usage.used !== null) this.activity.noteCredits(CODEX_ID, usage.used);
    if (usage.percent !== null) {
      this.snapshot = observe(
        this.snapshot,
        CODEX_ID,
        {
          kind: 'usage',
          percent: usage.percent,
          resetsAt: usage.resetsAt,
          percent7d: null,
          resetsAt7d: null,
          overageActive: false, // Codex spend caps are reported separately
          overagePercent: 0,
        },
        new Date(),
      );
    }
    if (usage.limitReached) {
      this.snapshot = observe(this.snapshot, CODEX_ID, { kind: 'quota_exhausted', resetsAt: usage.resetsAt }, new Date());
    }
  }

  /**
   * Read one account's credential into memory. LOCAL ONLY — a keychain or
   * file read, no network.
   *
   * Kept separate from the network probe because `authorisesCaller()`
   * compares against this map: a caller whose credential has not been read
   * yet gets a spurious 401. So this half must complete before the port
   * starts serving, while the probe half must not block it.
   */
  private async primeCredential(account: DiscoveredAccount): Promise<void> {
    try {
      this.credentials.set(account.id, await readCredential(account));
    } catch {
      // handle() reports an unreadable credential properly when used
    }
  }

  /** Resolve one account's identity and current quota. Best-effort, network. */
  private async prime(account: DiscoveredAccount): Promise<void> {
    const credential = this.credentials.get(account.id) ?? null;
    if (credential === null) return;

    const [identity, observation] = await Promise.all([
      fetchIdentity(credential.accessToken),
      // The configured model, so an account's measured health matches what
      // the session will actually send. Null (nothing forced) keeps the
      // cheap Haiku default.
      probeUsage(credential.accessToken, this.config.activeModel),
    ]);
    if (identity) this.identities.set(account.id, identity);

    // A PROBE must not cost an account its place in rotation.
    //
    // The probe is a diagnostic: one synthetic request, on a model that may
    // not be the one the session runs, sent before any real traffic. Folding
    // a rate-limit answer from it into rotation state put the account into
    // cooldown — backing off exponentially to 30 minutes — without a single
    // real request having been tried. Measured: accounts that answered real
    // traffic perfectly well were parked on startup, and the session spent
    // itself on the slow Codex fallback instead.
    //
    // Usage readings are still folded in: those are the numbers the whole
    // stats page exists to show, and they take no account out of service.
    // `auth_invalid` is kept too — a rejected credential is a fact about the
    // account, not about load. Only the load-shaped answers are dropped, and
    // the first real request re-learns them if they are true.
    if (observation && foldableFromProbe(observation)) {
      this.snapshot = observe(this.snapshot, account.id, observation, new Date());
    }
  }

  /**
   * Look for accounts that appeared since startup — a `claude` login done in
   * another terminal, say — and add them to the pool.
   *
   * Deliberately NOT init(): an account already in the pool keeps its live
   * rotation state, so a rescan during a session cannot resurrect an
   * exhausted account or move the one currently serving. Only genuinely new
   * ids are added, and only ids that have disappeared are dropped.
   */
  async rescan(): Promise<{ added: string[]; removed: string[]; total: number }> {
    const found = await discoverAccounts();
    this.discovered = new Map(found.map((a) => [a.id, a]));

    const ids = found.map((a) => a.id);
    try {
      this.codexCredential = await readCodexCredential();
      await loadAvailableModels();
      ids.push(CODEX_ID);
    } catch {
      this.codexCredential = null;
    }

    const known = new Set(this.snapshot.accounts.map((a) => a.id));
    const present = new Set(ids);
    const added = ids.filter((id) => !known.has(id));
    const removed = [...known].filter((id) => !present.has(id));

    const kept = this.snapshot.accounts.filter((a) => present.has(a.id));
    for (const id of added) {
      kept.push({
        id,
        priority: kept.length + 1,
        switchThreshold: DEFAULT_SWITCH_THRESHOLD,
        state: this.config.profiles[id]?.enabled === false ? 'disabled' : 'eligible',
        usagePercent: null,
        usagePercent7d: null,
        cooldownUntil: null,
        resetsAt: null,
        resetsAt7d: null,
        overagePercent: 0,
        unretryableStreak: 0,
      });
    }

    const ordered = [...kept].sort((a, b) => this.orderOf(a.id, ids) - this.orderOf(b.id, ids));
    ordered.forEach((a, i) => { a.priority = i + 1; });
    this.snapshot = {
      // If the account that was serving has vanished, rotation starts fresh.
      currentId: present.has(this.snapshot.currentId ?? '') ? this.snapshot.currentId : null,
      accounts: ordered,
    };

    // Identity and quota only for the newcomers; re-probing the whole pool
    // would spend quota for numbers we already have.
    await Promise.all([
      ...added.filter((id) => id !== CODEX_ID).map((id) => {
        const account = this.discovered.get(id);
        // A newcomer has no cached credential yet, so read it before the
        // probe that now depends on it.
        return account
          ? this.primeCredential(account).then(() => this.prime(account))
          : Promise.resolve();
      }),
      added.includes(CODEX_ID) ? this.primeCodex() : Promise.resolve(),
    ]);

    // A scan is a deliberate action, so it is always logged — including when
    // it changed nothing. "I pressed it and saw no entry" is indistinguishable
    // from "it did not run".
    const changes: string[] = [];
    if (added.length > 0) changes.push(`${added.length} new`);
    if (removed.length > 0) changes.push(`${removed.length} no longer available`);
    this.activity.record({
      kind: 'config',
      accountId: null,
      text: 'Scanned for accounts',
      meta: changes.length > 0
        ? `${changes.join(', ')} · ${ordered.length} in the pool`
        : `no change · ${ordered.length} in the pool`,
    });
    this.emit('usage', this.view());
    return { added, removed, total: ordered.length };
  }

  /** Re-read every account's quota, for the stats page's refresh. */
  async refreshUsage(): Promise<void> {
    // Re-read any credential missing from the cache — one that failed at
    // startup, or an account added since — so a manual refresh can recover
    // an account rather than silently skipping it.
    await Promise.all([...this.discovered.values()].map(async (a) => {
      if (!this.credentials.has(a.id)) await this.primeCredential(a);
      await this.prime(a);
    }));
    this.emit('usage', this.view());
  }

  get hasCodex(): boolean {
    return this.codexCredential !== null;
  }

  /**
   * Does this bearer token belong to one of the accounts we discovered?
   *
   * This is how the proxy authenticates its callers. uniAgents deliberately
   * does NOT set `ANTHROPIC_AUTH_TOKEN` — doing so makes Claude Code treat
   * itself as having a custom auth source and silently drops every
   * claude.ai-hosted MCP connector. Instead we let the CLI send its own
   * OAuth credential and check that, which it does on every request to a
   * custom base URL.
   *
   * Compared against credentials already held in memory, so this costs no
   * keychain read on the request path. An account whose credential has not
   * been read yet cannot authorise a caller — in practice the startup probe
   * has read them all before the first request arrives.
   */
  authorisesCaller(token: string): boolean {
    const candidate = Buffer.from(token);
    let matched = false;
    for (const credential of this.credentials.values()) {
      const known = Buffer.from(credential.accessToken);
      // Compare every candidate rather than returning early: a short-circuit
      // leaks which account matched through timing.
      if (known.length === candidate.length && timingSafeEqual(known, candidate)) matched = true;
    }
    return matched;
  }

  get accountCount(): number {
    return this.snapshot.accounts.length;
  }

  async handle(method: string, path: string, headers: Record<string, string>, body: Buffer): Promise<GatewayResult> {
    // Anything that is not an inference call — model listings, profile and
    // usage lookups, org metadata — is a plain read that ANY valid
    // credential can serve. It spends no quota, so an account being in
    // cooldown or over its window says nothing about whether it can answer.
    //
    // These must not go through rotation. Claude Code calls several of them
    // while starting up, and routing them normally meant: rotation picks the
    // only eligible account (Codex), `attemptCodex()` declines every
    // non-messages path, the attempt loop runs out, and the CLI gets a 503.
    // It then retried and stalled — measured at ~9s to answer "hello" while
    // the actual inference call took 1.6s.
    if (!isMessagesPath(path)) return this.passthrough(method, path, headers, body);

    const attempted = new Set<string>();

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const now = new Date();
      this.snapshot = recoverExpired(this.snapshot, now);
      const decision = choose(this.snapshot);

      if (decision.accountId === null || attempted.has(decision.accountId)) {
        return { status: 503, headers: {}, body: null, accountId: null, error: 'no_account_available' };
      }
      attempted.add(decision.accountId);

      const attempt =
        decision.accountId === CODEX_ID
          ? await this.attemptCodex(path, body)
          : await this.attemptClaude(decision.accountId, method, path, headers, body);

      if (attempt === null) continue; // could not even be sent; try the next

      // ---- the decision point: body is still untouched ----
      this.snapshot = observe(this.snapshot, decision.accountId, attempt.observation, new Date());

      if (attempt.observation.kind === 'quota_exhausted') {
        attempt.discard(); // nothing forwarded yet, so rotating is invisible
        const resets = attempt.observation.resetsAt;
        this.activity.record({
          kind: 'limit',
          accountId: decision.accountId,
          text: `${this.labelFor(decision.accountId)} is out of quota${resets ? ` · resets ${resets.toISOString()}` : ''}`,
        });
        this.emit('rotate', { from: decision.accountId, reason: 'quota_exhausted' });
        continue;
      }
      if (attempt.observation.kind === 'auth_invalid') {
        attempt.discard();
        this.activity.record({
          kind: 'error',
          accountId: decision.accountId,
          text: `${this.labelFor(decision.accountId)} needs re-authentication — run \`claude\` for it`,
        });
        this.emit('auth_invalid', { accountId: decision.accountId });
        continue;
      }
      // A rate limit or a transient unavailable: `observe()` has already put
      // this account into cooldown, so try the NEXT one rather than handing
      // the client an error while a healthy account sits idle.
      //
      // This is not a rotation in the sense CLAUDE.md forbids — the cooled
      // account keeps its place and returns on its own. What it prevents is
      // a single 429 surfacing as a failed request when the pool could have
      // answered it. Measured: a spend-capped account 429s with no
      // Retry-After on every request, which made the whole session fail even
      // with two working accounts behind it.
      //
      // Nothing has been forwarded yet, so this stays inside the
      // never-retry-after-committing rule.
      if (attempt.observation.kind === 'rate_limited' || attempt.observation.kind === 'unavailable') {
        attempt.discard();
        this.activity.record({
          kind: 'limit',
          accountId: decision.accountId,
          text: `${this.labelFor(decision.accountId)} is rate limited — trying the next account`,
        });
        this.emit('rotate', { from: decision.accountId, reason: attempt.observation.kind });
        continue;
      }

      // ---- committing: from here the client sees bytes, so no retry ----
      if (this.snapshot.currentId !== decision.accountId) {
        const from = this.snapshot.currentId;
        // Only a genuine hand-over is a rotation; the first request of a
        // session is simply the pool starting up.
        if (from !== null) {
          this.activity.record({
            kind: 'rotate',
            accountId: decision.accountId,
            text: `${this.labelFor(from)} → ${this.labelFor(decision.accountId)}`,
          });
        }
        this.emit('rotate', { from, to: decision.accountId, reason: 'switch' });
        this.snapshot = { ...this.snapshot, currentId: decision.accountId };
      }
      this.emit('usage', this.view());

      const accountId = decision.accountId;
      const model = requestedModel(body);
      const counted = attempt.body().pipe(
        countingTee((usage, durationMs) => {
          this.activity.record({
            kind: 'request',
            accountId,
            text: this.labelFor(accountId),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            durationMs,
            ...(model ? { model } : {}),
            ...(this.project ? { project: this.project } : {}),
          });
          this.emit('activity', { accounts: this.view(), totals: this.activity.totals });
        }),
      );
      return { status: attempt.status, headers: attempt.headers, body: counted, accountId };
    }

    return { status: 503, headers: {}, body: null, accountId: null, error: 'attempts_exhausted' };
  }

  /**
   * Serve a non-inference request with whatever Claude credential we hold.
   *
   * Quota state is deliberately IGNORED here: these endpoints cost nothing,
   * so a cooled-down or exhausted account answers them perfectly well.
   * Nothing is observed from the result either — a 429 on a model listing
   * must not push an account out of rotation for real work.
   *
   * Codex is skipped entirely: it cannot serve these shapes.
   */
  private async passthrough(
    method: string, path: string, headers: Record<string, string>, body: Buffer,
  ): Promise<GatewayResult> {
    // Prefer the account currently serving, then anything else we can read,
    // so this keeps using one warm connection rather than fanning out.
    const ids = [
      ...(this.snapshot.currentId !== null && this.snapshot.currentId !== CODEX_ID ? [this.snapshot.currentId] : []),
      ...this.snapshot.accounts.map((a) => a.id).filter((id) => id !== CODEX_ID && id !== this.snapshot.currentId),
    ];

    for (const id of ids) {
      const credential = await this.credentialFor(id);
      if (credential === null) continue;
      try {
        const res = await sendUpstream(
          buildUpstreamRequest({ accessToken: credential.accessToken, method, path, headers, body }),
        );
        return { status: res.status, headers: res.headers, body: res.body, accountId: id };
      } catch (err) {
        if (err instanceof UpstreamError) continue; // transport failure: try the next
        throw err;
      }
    }

    return { status: 503, headers: {}, body: null, accountId: null, error: 'no_account_available' };
  }

  /**
   * One send attempt, deferred body. `body()` is called ONLY after the retry
   * decision is made, so an abandoned attempt never reads a byte — the same
   * invariant on both paths.
   */
  private async attemptClaude(
    id: string, method: string, path: string, headers: Record<string, string>, body: Buffer,
  ): Promise<Attempt | null> {
    const credential = await this.credentialFor(id);
    if (credential === null) return null;

    try {
      // No model rewrite here, deliberately. The session is started on the
      // configured model with `--model` instead; overriding it per request
      // would silently undo every `/model` the user types mid-session.
      const res = await sendUpstream(
        buildUpstreamRequest({ accessToken: credential.accessToken, method, path, headers, body }),
      );
      return {
        status: res.status,
        headers: res.headers,
        observation: classify(res.status, filterResponseHeaders(res.headers)),
        body: () => res.body,
        discard: () => res.discard(),
      };
    } catch (err) {
      if (err instanceof UpstreamError) return null; // transport failure: try another
      throw err;
    }
  }

  private async attemptCodex(path: string, body: Buffer): Promise<Attempt | null> {
    const credential = this.codexCredential;
    if (credential === null) return null;

    // Codex speaks only the Messages shape. handle() now routes everything
    // else to passthrough() before rotation, so this is a belt-and-braces
    // guard rather than the path that fires in practice.
    if (!isMessagesPath(path)) return null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return null;
    }

    try {
      const res = await sendCodex(credential, parsed);
      const model = typeof parsed['model'] === 'string' ? parsed['model'] : 'claude';
      return {
        status: res.status,
        // Translated, not relayed: the client must be told this is Anthropic
        // SSE, and none of the upstream's own headers are meaningful here.
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        observation: classifyCodex(res.status, filterCodexHeaders(res.headers)),
        body: () => Readable.from(translateStream(res.raw, model)),
        discard: () => res.discard(),
      };
    } catch (err) {
      if (err instanceof CodexTransportError || err instanceof CodexError) return null;
      throw err;
    }
  }

  private async credentialFor(id: string): Promise<Credential | null> {
    const cached = this.credentials.get(id);
    if (cached && !isExpired(cached)) return cached;

    const account = this.discovered.get(id);
    if (!account) return null;

    try {
      const credential = await readCredential(account);
      if (isExpired(credential)) {
        // We store nothing, so we cannot refresh-and-persist. The fix is to
        // re-run `claude` for that account, which rewrites the credential
        // where we read it from — picked up on the next read.
        this.snapshot = observe(this.snapshot, id, { kind: 'auth_invalid' }, new Date());
        return null;
      }
      this.credentials.set(id, credential);
      return credential;
    } catch {
      this.snapshot = observe(this.snapshot, id, { kind: 'auth_invalid' }, new Date());
      return null;
    }
  }

  /** The read-only projection the stats page renders. */
  view(): AccountView[] {
    return this.snapshot.accounts.map((a) => ({
      id: a.id,
      label: this.labelFor(a.id),
      state: a.state,
      priority: a.priority,
      usagePercent: a.usagePercent,
      usagePercent7d: a.usagePercent7d,
      resetsAt: a.resetsAt?.toISOString() ?? null,
      resetsAt7d: a.resetsAt7d?.toISOString() ?? null,
      overagePercent: a.overagePercent,
      active: a.id === this.snapshot.currentId,
      kind: a.id === CODEX_ID ? ('codex' as const) : ('claude' as const),
      email: a.id === CODEX_ID ? null : (this.identities.get(a.id)?.email ?? null),
      plan: a.id === CODEX_ID
        ? codexPlanLabel(this.codexCredential?.planType ?? null)
        : planLabel(this.identities.get(a.id)?.organizationType ?? null),
      requests: this.activity.perAccount.get(a.id) ?? 0,
      quotaNote: a.id === CODEX_ID ? codexNote(this.codexUsage) : null,
      credits: a.id === CODEX_ID ? codexCredits(this.codexUsage) : null,
    }));
  }

  /** Prefer a real identity; fall back to the short id it was discovered under. */
  private labelFor(id: string): string {
    const alias = this.config.profiles[id]?.alias;
    if (alias) return alias;
    if (id === CODEX_ID) return 'ChatGPT Codex';
    const identity = this.identities.get(id);
    return identity?.email ?? identity?.displayName ?? this.discovered.get(id)?.label ?? id;
  }
}

function codexCredits(usage: CodexUsage | null): AccountView['credits'] {
  if (!usage || usage.used === null || usage.limit === null || usage.limit <= 0) return null;
  return {
    used: usage.used,
    limit: usage.limit,
    remaining: Math.max(0, usage.limit - usage.used),
    unit: usage.unit ?? 'credit',
  };
}

/** "8.9 of 1,250 credits · 99% left" — what the ChatGPT UI shows. */
function codexNote(usage: CodexUsage | null): string | null {
  if (!usage) return null;
  if (usage.unlimited) return 'unlimited credits';
  if (usage.used === null || usage.limit === null) return null;
  const unit = usage.limit === 1 ? (usage.unit ?? 'credit') : `${usage.unit ?? 'credit'}s`;
  return `${fmt(usage.used)} of ${fmt(usage.limit)} ${unit} used`;
}

function fmt(n: number): string {
  return n >= 100 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * The model a request asked for. Read defensively: a body that is not JSON, or
 * carries no model, simply goes unattributed rather than failing the request.
 */
function requestedModel(body: Buffer): string | null {
  if (body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const model = (parsed as Record<string, unknown>)['model'];
    return typeof model === 'string' && model !== '' ? model : null;
  } catch {
    return null;
  }
}

/** enterprise_cbp_usage_based → "Enterprise · usage-based" */
function codexPlanLabel(planType: string | null): string {
  if (!planType) return 'ChatGPT';
  const base = planType.replace(/_cbp_usage_based$/, '').replace(/_/g, ' ');
  const pretty = base.charAt(0).toUpperCase() + base.slice(1);
  return planType.endsWith('usage_based') ? `${pretty} · usage-based` : pretty;
}


/** An inference call — the only shape that spends quota and needs rotation. */
function isMessagesPath(path: string): boolean {
  return path.replace(/\/+$/, '').endsWith('/v1/messages');
}


/**
 * May a PROBE's observation change rotation state?
 *
 * Usage and auth answers are facts about the account: what it has spent, and
 * whether its credential is accepted. Rate-limit and unavailable answers are
 * facts about load at one instant, measured by a synthetic request on a model
 * the session may not even use — acting on those parked healthy accounts in
 * a 30-minute backoff before any real traffic was tried.
 */
export function foldableFromProbe(observation: Observation): boolean {
  return observation.kind !== 'rate_limited' && observation.kind !== 'unavailable';
}
