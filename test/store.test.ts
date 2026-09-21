/**
 * Storage tests. Every one runs against a real temp directory via
 * UNIAGENTS_HOME — no mocks, because the properties under test (atomic
 * rename, surviving a truncated line, never throwing on a bad disk) only
 * mean anything against a real filesystem.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * UNIAGENTS_HOME is process-wide, so these tests cannot run concurrently:
 * one test's sandbox() would redirect another's in-flight write. node:test
 * runs tests in a file concurrently by default, so they are serialised here.
 */
const serial = { concurrency: 1 };

// Point the whole file away from the real ~/.uniagents before any module
// reads it. Without this, a write that escapes a sandbox — or one queued
// before the first sandbox() — would touch the user's actual data.
process.env['UNIAGENTS_HOME'] = await mkdtemp(join(tmpdir(), 'uniagents-file-'));

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'uniagents-test-'));
  process.env['UNIAGENTS_HOME'] = dir;
  return dir;
}

/**
 * Fresh module instances, so each test sees its own UNIAGENTS_HOME.
 *
 * All three share ONE cache-buster: activity.ts imports log.ts internally, so
 * a different suffix would give it a separate log instance whose pending
 * writes the test's flush() would never wait for.
 */
async function mods() {
  const bust = `?t=${Date.now()}${Math.random()}`;
  return {
    config: await import('../src/store/config.ts' + bust),
    log: await import('../src/store/log.ts' + bust),
  };
}

/**
 * An Activity wired to THIS test's log instance.
 *
 * Activity takes its writer as a constructor argument precisely so a test can
 * hand it the same cache-busted module it reads and flushes. Letting it bind
 * to the shared module made these tests race: writes queued on one instance
 * while the assertions flushed another.
 */
async function creditFixture() {
  await sandbox();
  const { log } = await mods();
  const { Activity } = await import('../src/proxy/activity.ts?a=' + Math.random());
  const make = () =>
    new Activity({ recordActivity: log.recordActivity, recordDaily: log.recordDaily, readDaily: log.readDaily });
  return { make, log };
}

// ---- config ----

test('a missing config yields defaults rather than throwing', serial, async () => {
  await sandbox();
  const { config } = await mods();
  const c = await config.loadConfig();
  assert.equal(c.version, 1);
  assert.deepEqual(c.profiles, {});
  assert.equal(c.settings.language, 'en');
});

test('config survives a save/load round trip', serial, async () => {
  await sandbox();
  const { config } = await mods();
  const saved = {
    ...config.defaultConfig(),
    profiles: { 'Claude Code-credentials': { alias: 'Personal', order: 1, enabled: false } },
    parity: [{ claude: 'claude-opus-5', gpt: 'gpt-5.6-terra' }],
    settings: { language: 'nl', theme: 'dark' as const, notifications: { rotated: false } },
  };
  assert.equal(await config.saveConfig(saved), true);

  const loaded = await config.loadConfig();
  assert.deepEqual(loaded.profiles['Claude Code-credentials'], { alias: 'Personal', order: 1, enabled: false });
  assert.deepEqual(loaded.parity, [{ claude: 'claude-opus-5', gpt: 'gpt-5.6-terra' }]);
  assert.equal(loaded.settings.language, 'nl');
  assert.equal(loaded.settings.theme, 'dark');
  assert.equal(loaded.settings.notifications['rotated'], false);
});

test('a fresh install forces no model at all', serial, async () => {
  // uniAgents is a launcher, not a model manager: with nothing picked it
  // passes no --model and the session starts on the user's own default.
  await sandbox();
  const { config } = await mods();
  assert.equal((await config.loadConfig()).activeModel, null);
});

test('a picked model survives a restart', serial, async () => {
  const dir = await sandbox();
  const { config } = await mods();

  await writeFile(join(dir, 'config.json'), JSON.stringify({ version: 1, activeModel: 'claude-sonnet-5' }), 'utf8');
  assert.equal((await config.loadConfig()).activeModel, 'claude-sonnet-5');

  // Absent, null and empty all mean "force nothing".
  for (const raw of ['{"version":1}', '{"version":1,"activeModel":null}', '{"version":1,"activeModel":""}']) {
    await writeFile(join(dir, 'config.json'), raw, 'utf8');
    assert.equal((await config.loadConfig()).activeModel, null, raw);
  }
});

test('a corrupt config yields defaults instead of crashing the tool', serial, async () => {
  // Damaged state must never stop uniAgents from starting.
  const dir = await sandbox();
  await writeFile(join(dir, 'config.json'), '{ this is not json', 'utf8');
  const { config } = await mods();
  assert.deepEqual((await config.loadConfig()).profiles, {});
});

test('a hand-edited config is coerced, not rejected', serial, async () => {
  // Plain JSON exists so people can edit it; bad values must degrade, not throw.
  const dir = await sandbox();
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    profiles: {
      ok: { alias: 'Fine', order: 2, enabled: true },
      weird: { alias: 42, order: 'nope' },     // wrong types
      broken: 'not an object',
    },
    parity: [{ claude: 'a', gpt: 'b' }, { claude: 'missing gpt' }, 'nonsense'],
    settings: { theme: 'chartreuse', notifications: { rotated: 'yes', exhausted: false } },
  }), 'utf8');

  const { config } = await mods();
  const c = await config.loadConfig();
  assert.equal(c.profiles['ok']?.alias, 'Fine');
  assert.equal(c.profiles['weird']?.alias, null, 'a non-string alias becomes null');
  assert.equal(c.profiles['weird']?.enabled, true, 'a missing enabled defaults to true');
  assert.equal(c.profiles['broken'], undefined, 'a non-object profile is dropped');
  assert.deepEqual(c.parity, [{ claude: 'a', gpt: 'b' }], 'malformed parity rows are dropped');
  assert.equal(c.settings.theme, 'auto', 'an unknown theme falls back');
  assert.equal(c.settings.notifications['rotated'], true, 'a non-boolean keeps the default');
  assert.equal(c.settings.notifications['exhausted'], false, 'a valid boolean is kept');
});

test('saving leaves no temp files behind', serial, async () => {
  // The atomic write uses a temp file; a leaked one would accumulate forever.
  const dir = await sandbox();
  const { config } = await mods();
  await config.saveConfig(config.defaultConfig());
  await config.saveConfig(config.defaultConfig());
  const files = await readdir(dir);
  assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), [], 'no .tmp leftovers');
  assert.deepEqual(files, ['config.json']);
});

test('the config file is written private to the user', serial, async () => {
  const dir = await sandbox();
  const { config } = await mods();
  await config.saveConfig(config.defaultConfig());
  const { stat } = await import('node:fs/promises');
  const mode = (await stat(join(dir, 'config.json'))).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('a save to an unwritable directory reports false, it does not throw', serial, async () => {
  // A read-only disk must cost persistence, never the session.
  const dir = await sandbox();
  const { config } = await mods();
  await config.saveConfig(config.defaultConfig());
  await chmod(dir, 0o500);
  try {
    assert.equal(await config.saveConfig(config.defaultConfig()), false);
  } finally {
    await chmod(dir, 0o700); // so the temp dir can be cleaned up
  }
});

// ---- append-only history ----

test('activity and usage round trip', serial, async () => {
  await sandbox();
  const { log } = await mods();
  await log.recordActivity({ at: '2026-09-20T18:00:00Z', kind: 'session', accountId: 'a', text: 'Session started' });
  await log.recordActivity({ at: '2026-09-20T18:01:00Z', kind: 'rotation', accountId: 'b', text: 'a → b' });
  await log.recordDaily({ date: '2026-09-20', accountId: 'a', requests: 12, inputTokens: 900, outputTokens: 300 });

  const events = await log.readActivity();
  assert.equal(events.length, 2);
  assert.equal(events[1]?.kind, 'rotation');
  assert.equal((await log.readDaily())[0]?.requests, 12);
});

test('a truncated final line does not lose the rest of the file', serial, async () => {
  // Exactly what a crash mid-append leaves behind.
  const dir = await sandbox();
  const { log } = await mods();
  await log.recordActivity({ at: '2026-09-20T18:00:00Z', kind: 'session', accountId: null, text: 'first' });
  await log.recordActivity({ at: '2026-09-20T18:01:00Z', kind: 'session', accountId: null, text: 'second' });
  await writeFile(join(dir, 'activity.jsonl'),
    (await readFile(join(dir, 'activity.jsonl'), 'utf8')) + '{"at":"2026-09-20T18:02:00Z","kind":"ses',
    'utf8');

  const events = await log.readActivity();
  assert.equal(events.length, 2, 'both complete lines survive');
  assert.equal(events[0]?.text, 'first');
  assert.equal(events[1]?.text, 'second');
});

test('reading a file that does not exist yields an empty list', serial, async () => {
  await sandbox();
  const { log } = await mods();
  assert.deepEqual(await log.readActivity(), []);
  assert.deepEqual(await log.readDaily(), []);
});

test('the last line for a day wins — totals are not summed', serial, async () => {
  // The daily file holds a running total appended through the day. Summing it
  // would multiply-count every request.
  await sandbox();
  const { log } = await mods();
  await log.recordDaily({ date: '2026-09-20', accountId: 'a', requests: 5, inputTokens: 100, outputTokens: 50 });
  await log.recordDaily({ date: '2026-09-20', accountId: 'a', requests: 9, inputTokens: 300, outputTokens: 80 });
  await log.recordDaily({ date: '2026-09-20', accountId: 'b', requests: 2, inputTokens: 40, outputTokens: 10 });
  await log.recordDaily({ date: '2026-09-21', accountId: 'a', requests: 1, inputTokens: 10, outputTokens: 5 });

  const rows = log.latestPerDay(await log.readDaily());
  assert.equal(rows.length, 3, 'one row per (date, account)');
  const a20 = rows.find((r: { date: string; accountId: string }) => r.date === '2026-09-20' && r.accountId === 'a');
  assert.equal(a20?.requests, 9, 'the later total replaces the earlier one');
  assert.equal(a20?.inputTokens, 300);
});

test('localDate formats a calendar day in the local zone', serial, async () => {
  const { log } = await mods();
  assert.equal(log.localDate(new Date(2026, 8, 5)), '2026-09-05', 'months and days are zero-padded');
  assert.match(log.localDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('UNIAGENTS_HOME redirects everything, so nothing touches the real home', serial, async () => {
  const dir = await sandbox();
  const { config, log } = await mods();
  await config.saveConfig(config.defaultConfig());
  await log.recordActivity({ at: '2026-09-20T18:00:00Z', kind: 'general', accountId: null, text: 'x' });
  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ['activity.jsonl', 'config.json']);
});

test('REGRESSION: flush waits for appends fired without await', serial, async () => {
  // Appends are deliberately not awaited so a request never waits on a disk.
  // Without a flush on shutdown that leaves a window where the last events are
  // lost — which is exactly the case this whole storage layer exists for.
  const dir = await sandbox();
  const { log } = await mods();
  for (let i = 0; i < 20; i++) {
    void log.recordActivity({ at: new Date().toISOString(), kind: 'session', accountId: 'a', text: `e${i}` });
  }
  await log.flush();
  const lines = (await readFile(join(dir, 'activity.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 20, 'every fired append landed before flush resolved');
});

test('a restarted session resumes today’s totals instead of restarting at zero', serial, async () => {
  const { log } = await mods();
  await sandbox();
  const today = log.localDate();
  await log.recordDaily({ date: today, accountId: 'acct-1', requests: 7, inputTokens: 100, outputTokens: 20 });
  await log.recordDaily({ date: '2020-01-01', accountId: 'acct-1', requests: 999, inputTokens: 1, outputTokens: 1 });
  await log.flush();

  const { Activity } = await import('../src/proxy/activity.ts?restore=' + Math.random());
  const a = new Activity();
  await a.restore();
  assert.equal(a.perAccount.get('acct-1'), 7, 'today is restored');
  assert.equal(a.perAccount.size, 1, 'an older day is not counted as today');
});

// ---- history aggregation ----

test('history builds a full month grid with gaps for days that have no record', serial, async () => {
  await sandbox();
  const { log } = await mods();
  await log.recordDaily({ date: '2026-09-03', accountId: 'a', requests: 4, inputTokens: 100, outputTokens: 50 });
  await log.recordDaily({ date: '2026-09-17', accountId: 'a', requests: 9, inputTokens: 700, outputTokens: 200 });
  await log.flush();

  const { buildHistory } = await import('../src/store/history.ts?h=' + Math.random());
  const h = await buildHistory('2026-09');
  assert.equal(h.daysInMonth, 30);
  assert.equal(h.calendar.length, 1);
  const row = h.calendar[0]!;
  assert.equal(row.days.length, 30, 'one cell per day of the month');
  assert.equal(row.days.filter(Boolean).length, 2, 'only recorded days carry data');
  assert.equal(row.days[2]?.requests, 4, 'the 3rd is index 2');
  assert.equal(row.total, 1050, 'tokens summed across the month');
  assert.equal(row.busiestDay, 900, 'the single biggest day');
  assert.equal(row.activeDays, 2);
});

test('history attributes tokens by model and by project', serial, async () => {
  await sandbox();
  const { log } = await mods();
  const at = new Date().toISOString();
  await log.recordActivity({ at, kind: 'session', accountId: 'a', text: 'x', inputTokens: 100, outputTokens: 20, model: 'claude-opus-5', project: 'uniAgents' });
  await log.recordActivity({ at, kind: 'session', accountId: 'a', text: 'x', inputTokens: 10, outputTokens: 5, model: 'claude-opus-5', project: 'other' });
  await log.recordActivity({ at, kind: 'session', accountId: 'a', text: 'x', inputTokens: 1, outputTokens: 1, model: 'gpt-5.6-terra', project: 'uniAgents' });
  await log.recordActivity({ at, kind: 'rotation', accountId: 'a', text: 'not a request' });
  await log.flush();

  const { buildHistory } = await import('../src/store/history.ts?h=' + Math.random());
  const h = await buildHistory(log.localDate().slice(0, 7));
  assert.deepEqual(h.models, [{ name: 'claude-opus-5', tokens: 135 }, { name: 'gpt-5.6-terra', tokens: 2 }],
    'biggest first, rotation events excluded');
  assert.deepEqual(h.projects, [{ name: 'uniAgents', tokens: 122 }, { name: 'other', tokens: 15 }]);
});

test('an empty history is a full grid of gaps, not an error', serial, async () => {
  await sandbox();
  await mods();
  const { buildHistory } = await import('../src/store/history.ts?h=' + Math.random());
  const h = await buildHistory('2026-02');
  assert.equal(h.daysInMonth, 28, 'February 2026');
  assert.deepEqual(h.calendar, []);
  assert.deepEqual(h.models, []);
  assert.deepEqual(h.events, []);
});

test('REGRESSION: restore brings back session totals, not just per-account counts', serial, async () => {
  // perAccount came back but totals stayed at zero, so the Combined Usage
  // strip — which divides by totals — rendered empty after every restart.
  await sandbox();
  const { log } = await mods();
  const today = log.localDate();
  await log.recordDaily({ date: today, accountId: 'a', requests: 3, inputTokens: 300, outputTokens: 90 });
  await log.recordDaily({ date: today, accountId: 'b', requests: 2, inputTokens: 100, outputTokens: 10 });
  await log.flush();

  const { Activity } = await import('../src/proxy/activity.ts?t=' + Math.random());
  const a = new Activity();
  await a.restore();
  assert.equal(a.totals.requests, 5, 'totals summed across accounts');
  assert.equal(a.totals.inputTokens, 400);
  assert.equal(a.totals.outputTokens, 100);
  assert.equal(a.perAccount.get('a'), 3, 'per-account still correct');
});

// ---- Codex credits ----

test('the first credit reading is a baseline, not a day of spend', serial, async () => {
  // Codex reports a running total against a monthly allowance. Treating the
  // first reading of a session as spend would attribute the whole month to
  // today.
  const { make, log } = await creditFixture();
  const a = make();

  a.noteCredits('codex', 800);
  await log.flush();
  assert.deepEqual(await log.readDaily(), [], 'nothing recorded from one reading alone');
});

test('credits record the spend since the first reading', serial, async () => {
  const { make, log } = await creditFixture();
  const a = make();

  a.noteCredits('codex', 800);   // baseline
  a.noteCredits('codex', 812.5); // +12.5
  a.noteCredits('codex', 820);   // +20 from baseline, not +7.5 from the last

  await log.flush();
  const rows = log.latestPerDay(await log.readDaily());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.credits, 20, 'measured from the baseline, not the previous reading');
});

test('REGRESSION: a monthly allowance reset does not silently report zero spend', serial, async () => {
  // The allowance renews and `used` drops. Clamping the difference to 0 would
  // report no usage for the rest of that day, hiding real consumption.
  const { make, log } = await creditFixture();
  const a = make();

  a.noteCredits('codex', 1200); // baseline, near the end of the allowance
  a.noteCredits('codex', 5);    // renewed: 5 credits spent since the reset

  await log.flush();
  const rows = log.latestPerDay(await log.readDaily());
  assert.equal(rows[0]?.credits, 5, 'the post-reset reading is itself the spend');
});

test('credits do not clobber a day’s token counts', serial, async () => {
  // Both are written to the same daily row; one must not zero the other.
  const { make, log } = await creditFixture();
  const a = make();

  a.record({ kind: 'request', accountId: 'codex', text: 'x', inputTokens: 100, outputTokens: 40 });
  a.noteCredits('codex', 800);
  a.noteCredits('codex', 806);

  await log.flush();
  const row = log.latestPerDay(await log.readDaily())[0];
  assert.equal(row?.credits, 6);
  assert.equal(row?.requests, 1, 'the request still counted');
  assert.equal(row?.inputTokens, 100, 'tokens survived the credit write');
});

test('REGRESSION: concurrent appends do not lose lines', serial, async () => {
  // Every append opens the file independently, so two that overlap can
  // interleave and one is lost. Requests fire these without awaiting, so
  // overlap is the normal case — this showed up as flaky credit totals
  // before the writes were chained.
  await sandbox();
  const { log } = await mods();
  const COUNT = 60;
  for (let i = 0; i < COUNT; i++) {
    void log.recordActivity({ at: new Date().toISOString(), kind: 'session', accountId: 'a', text: `e${i}` });
  }
  await log.flush();

  const events = await log.readActivity();
  assert.equal(events.length, COUNT, 'every concurrent append survived');
  const texts = new Set(events.map((e: { text: string }) => e.text));
  assert.equal(texts.size, COUNT, 'and none was overwritten by another');
});

test('REGRESSION: appends land in the order they were called', serial, async () => {
  // The write chain was joined AFTER an await, so rapid calls could enter it
  // out of sequence. Every line still landed, but a running total read back
  // wrong because a later value was overwritten by an earlier one — which is
  // exactly how the credit balance was corrupted.
  await sandbox();
  const { log } = await mods();

  const COUNT = 40;
  for (let i = 1; i <= COUNT; i++) {
    void log.recordDaily({ date: '2026-09-20', accountId: 'a', requests: i, inputTokens: 0, outputTokens: 0 });
  }
  await log.flush();

  const rows = await log.readDaily();
  assert.equal(rows.length, COUNT, 'nothing lost');
  assert.deepEqual(
    rows.map((r: { requests: number }) => r.requests),
    Array.from({ length: COUNT }, (_, i) => i + 1),
    'and written in call order, so the last line is the newest value',
  );
});
