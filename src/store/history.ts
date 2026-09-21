/**
 * Shapes the stored history into what the Logs page renders.
 *
 * Pure aggregation over what is already on disk — no network, no provider
 * calls. That matters because the per-day calendar CANNOT be backfilled:
 * neither Anthropic nor OpenAI reports daily history, so whatever day
 * recording started is the earliest day this page can ever show. Everything
 * here is derived from our own records or it does not exist.
 */

import { readActivity, readDaily, latestPerDay, localDate } from './log.ts';
import type { ActivityEvent, DailyUsage } from './log.ts';

export interface DayCell {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Credits spent, for an account billed that way rather than by token. */
  credits?: number;
}

export interface CalendarRow {
  accountId: string;
  days: (DayCell | null)[]; // null = no record for that day
  total: number;
  busiestDay: number;
  activeDays: number;
  /** Hour of day (0-23) with the most requests, or null with nothing to go on. */
  busiestHour: number | null;
  /** What this row's numbers are measured in. */
  unit: 'tokens' | 'credits';
}

export interface Breakdown {
  name: string;
  tokens: number;
}

/** One month of calendar rows, with everything needed to render its grid. */
export interface MonthCalendar {
  month: string; // YYYY-MM
  daysInMonth: number;
  /** Weekday index (Mon=0) the 1st falls on, so the grid can pad. */
  startsOn: number;
  rows: CalendarRow[];
}

export interface History {
  month: string; // YYYY-MM — the current month
  daysInMonth: number;
  /** This month and the two before it, oldest first. */
  months: MonthCalendar[];
  calendar: CalendarRow[];
  models: Breakdown[];
  projects: Breakdown[];
  events: ActivityEvent[];
}

/**
 * Everything the Logs page needs, for the given month (default: this one).
 * `month` is YYYY-MM.
 */
export async function buildHistory(
  month = localDate().slice(0, 7),
  eventLimit = 200,
  /** Every account in the pool, so one with no usage still gets a row. */
  accountIds: string[] = [],
): Promise<History> {
  const [daily, activity] = await Promise.all([readDaily(), readActivity()]);
  const all = latestPerDay(daily);

  // Three months, oldest first: a single month hides a reset that happened
  // days ago, which is exactly when you go looking, and a quarter is enough
  // to see a pattern rather than a moment.
  const back2 = previousMonth(previousMonth(month));
  const months = [back2, previousMonth(month), month].map((m) =>
    monthCalendar(all.filter((r) => r.date.startsWith(m)), m, activity, accountIds),
  );
  const current = months[months.length - 1]!;

  return {
    month,
    daysInMonth: current.daysInMonth,
    months,
    calendar: current.rows,
    models: breakdown(activity, month, (e) => e.model),
    projects: breakdown(activity, month, (e) => e.project),
    events: activity.slice(-eventLimit).reverse(),
  };
}

/**
 * Total tokens grouped by some field of a request event, biggest first.
 * Events recorded before that field existed simply do not appear — better an
 * honest gap than a bucket of "unknown".
 */
function breakdown(
  activity: ActivityEvent[],
  month: string,
  key: (e: ActivityEvent) => string | undefined,
): Breakdown[] {
  const totals = new Map<string, number>();
  for (const event of activity) {
    if (event.kind !== 'session') continue;
    const name = key(event);
    if (!name) continue;
    const at = new Date(event.at);
    if (Number.isNaN(at.getTime()) || localDate(at).slice(0, 7) !== month) continue;
    totals.set(name, (totals.get(name) ?? 0) + (event.inputTokens ?? 0) + (event.outputTokens ?? 0));
  }
  return [...totals.entries()]
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens);
}

/** "2026-09" -> "2026-08". */
function previousMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number);
  const d = new Date(year ?? 1970, (mon ?? 1) - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthCalendar(
  rows: DailyUsage[],
  month: string,
  activity: ActivityEvent[],
  accountIds: string[],
): MonthCalendar {
  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(year ?? 1970, mon ?? 1, 0).getDate();
  // Monday-first index for the 1st, so the client does not recompute it.
  const startsOn = (new Date(year ?? 1970, (mon ?? 1) - 1, 1).getDay() + 6) % 7;
  return { month, daysInMonth, startsOn, rows: buildCalendar(rows, month, daysInMonth, activity, accountIds) };
}

function buildCalendar(
  rows: DailyUsage[],
  month: string,
  daysInMonth: number,
  activity: ActivityEvent[],
  accountIds: string[],
): CalendarRow[] {
  const byAccount = new Map<string, Map<string, DailyUsage>>();
  // Seed every pooled account first, so one that has served nothing this
  // month still gets a row of empty days rather than vanishing from the page.
  for (const id of accountIds) byAccount.set(id, new Map());
  for (const row of rows) {
    let days = byAccount.get(row.accountId);
    if (!days) byAccount.set(row.accountId, (days = new Map()));
    days.set(row.date, row);
  }

  return [...byAccount.entries()].map(([accountId, days]) => {
    const cells: (DayCell | null)[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      const row = days.get(date);
      cells.push(
        row
          ? {
              date,
              requests: row.requests,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              ...(row.credits !== undefined ? { credits: row.credits } : {}),
            }
          : null,
      );
    }

    const present = cells.filter((c): c is DayCell => c !== null);
    // A credit-billed account is measured in credits; everything else in
    // tokens. Mixing the two in one total would be meaningless.
    const creditBilled = present.some((c) => c.credits !== undefined);
    const tokensOf = (c: DayCell) => (creditBilled ? (c.credits ?? 0) : c.inputTokens + c.outputTokens);

    return {
      accountId,
      days: cells,
      total: present.reduce((s, c) => s + tokensOf(c), 0),
      busiestDay: present.reduce((m, c) => Math.max(m, tokensOf(c)), 0),
      activeDays: present.filter((c) => c.requests > 0).length,
      busiestHour: busiestHour(activity, accountId, month),
      unit: creditBilled ? ('credits' as const) : ('tokens' as const),
    };
  });
}

/**
 * The hour this account served most requests in. Derived from our own event
 * timestamps — no provider reports per-hour usage, so this exists only because
 * we record it.
 */
function busiestHour(activity: ActivityEvent[], accountId: string, month: string): number | null {
  const counts = new Array<number>(24).fill(0);
  let seen = 0;

  for (const event of activity) {
    if (event.accountId !== accountId || event.kind !== 'session') continue;
    const at = new Date(event.at);
    if (Number.isNaN(at.getTime())) continue;
    // Local hours, to match the calendar's local dates.
    if (localDate(at).slice(0, 7) !== month) continue;
    counts[at.getHours()]! += 1;
    seen++;
  }

  if (seen === 0) return null;
  return counts.indexOf(Math.max(...counts));
}
