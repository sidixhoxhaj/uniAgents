/**
 * `unicode usage` — real subscription usage for every account, in the terminal.
 *
 * Claude Code's own /usage prints a "Total cost" computed locally from token
 * counts times API list prices. On a subscription that number is a
 * hypothetical: it is not read from your account, and nothing is billed at
 * those rates. (It asks the proxy for nothing at all — verified — so it cannot
 * be corrected from here.)
 *
 * This shows what actually matters instead: how much of each account's
 * included quota is spent, straight from the provider's own headers.
 *
 * One tiny request per account to read those headers. Nothing is stored.
 */

import { discoverAccounts, readCredential, credentialLocationHint } from '../accounts/discover.ts';
import type { DiscoveredAccount } from '../accounts/discover.ts';
import { fetchIdentity, planLabel } from '../accounts/identity.ts';
import { probeUsage } from '../accounts/probe.ts';
import { readCodexCredential } from '../codex/credential.ts';
import { fetchCodexUsage } from '../codex/usage.ts';

const BAR_WIDTH = 24;

interface Row {
  name: string;
  plan: string;
  primary: number | null;
  secondary: number | null;
  resetsAt: Date | null;
  overage: boolean;
  note: string | null;
  /** Extra line under the bar, e.g. a credit balance. */
  detail?: string | null;
}

export async function cmdUsage(): Promise<number> {
  const accounts = await discoverAccounts();
  if (accounts.length === 0) {
    console.log(`No accounts found — looked in ${credentialLocationHint()}.\n`);
    console.log('Run `claude` and log in.');
    return 1;
  }

  process.stderr.write('Reading usage…');
  const rows = await Promise.all(accounts.map(probeClaude));
  const codex = await probeCodex();
  if (codex) rows.push(codex);
  process.stderr.write('\r               \r');

  const width = Math.max(...rows.map((r) => r.name.length), 7);
  console.log('');
  for (const row of rows) {
    const head = `  ${row.name.padEnd(width)}  ${dim(row.plan)}`;
    if (row.note) {
      console.log(`${head}  ${row.note}\n`);
      continue;
    }
    console.log(head);
    const windowName = row.detail ? 'allowance' : '5-hour';
    console.log(`    ${bar(row.primary)} ${label(row.primary)}  ${dim(windowName)}${resetText(row.resetsAt)}`);
    if (row.secondary !== null) {
      console.log(`    ${bar(row.secondary)} ${label(row.secondary)}  ${dim('7-day')}`);
    }
    if (row.detail) console.log(`    ${dim(row.detail)}`);
    if (row.overage) {
      console.log(`    ${red('overage active — this account is billing real money')}`);
    }
    console.log('');
  }

  // Pooling two seats of the SAME organisation shares one quota, so rotating
  // between them buys nothing. Identical usage is the tell.
  const measured = rows.filter((r) => r.note === null);
  if (measured.length > 1 && new Set(measured.map((r) => `${r.plan}:${r.primary}`)).size === 1) {
    console.log(dim('  These accounts report identical usage — they are likely the same'));
    console.log(dim('  organisation, sharing one quota. Rotating between them gains nothing.\n'));
  }
  return 0;
}

async function probeClaude(account: DiscoveredAccount): Promise<Row> {
  const base: Row = {
    name: account.label, plan: 'Claude', primary: null, secondary: null,
    resetsAt: null, overage: false, note: null,
  };

  let credential;
  try {
    credential = await readCredential(account);
  } catch {
    return { ...base, note: dim('unreadable — run `claude` for this account') };
  }

  const identity = await fetchIdentity(credential.accessToken);
  const name = identity?.email ?? account.label;
  const plan = planLabel(identity?.organizationType ?? null) ?? 'Claude';

  const observation = await probeUsage(credential.accessToken);
  if (observation === null) return { ...base, name, plan, note: dim('could not reach the provider') };

  switch (observation.kind) {
    case 'usage':
      return {
        name, plan,
        primary: observation.percent,
        secondary: observation.percent7d,
        resetsAt: observation.resetsAt,
        overage: observation.overageActive,
        note: null,
      };
    case 'quota_exhausted':
      return { ...base, name, plan, note: red('quota exhausted') };
    case 'auth_invalid':
      return { ...base, name, plan, note: red('needs re-authentication — run `claude`') };
    default:
      return { ...base, name, plan, note: dim('no usage reported') };
  }
}

async function probeCodex(): Promise<Row | null> {
  let credential;
  try {
    credential = await readCodexCredential();
  } catch {
    return null; // not signed in; simply not shown
  }

  const base: Row = {
    name: 'ChatGPT Codex',
    plan: credential.planType ?? 'ChatGPT',
    primary: null, secondary: null, resetsAt: null, overage: false, note: null,
  };

  const usage = await fetchCodexUsage(credential);
  if (!usage) return { ...base, note: dim('could not read usage') };

  const plan = usage.planType ?? base.plan;
  if (usage.unlimited) return { ...base, plan, note: dim('unlimited credits') };
  if (usage.limitReached) return { ...base, plan, note: red('spend limit reached') };

  return {
    ...base,
    plan,
    primary: usage.percent,
    resetsAt: usage.resetsAt,
    // The credit figures the ChatGPT UI shows, rather than a bare percentage.
    note: null,
    detail: usage.used !== null && usage.limit !== null
      ? `${fmtNum(usage.used)} of ${fmtNum(usage.limit)} ${usage.unit ?? 'credit'}s used · ` +
        `${fmtNum(usage.limit - usage.used)} left`
      : null,
  };
}

function fmtNum(n: number): string {
  return n >= 100 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function bar(percent: number | null): string {
  if (percent === null) return dim('-'.repeat(BAR_WIDTH));
  // Any real usage shows at least one cell: rounding 1% to zero cells makes a
  // used account look untouched.
  const exact = (Math.min(100, percent) / 100) * BAR_WIDTH;
  const filled = percent > 0 ? Math.max(1, Math.round(exact)) : 0;
  const colour = percent >= 90 ? red : percent >= 70 ? yellow : green;
  return colour('█'.repeat(filled)) + dim('░'.repeat(BAR_WIDTH - filled));
}

function label(percent: number | null): string {
  return (percent === null ? '—' : `${percent.toFixed(0)}%`).padStart(4);
}

function resetText(resetsAt: Date | null): string {
  if (!resetsAt) return '';
  const ms = resetsAt.getTime() - Date.now();
  if (ms <= 0) return dim(' · resetting');
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return dim(` · resets in ${minutes}m`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return dim(` · resets in ${hours}h ${minutes % 60}m`);
  // Past a day, a countdown alone stops being useful — name the day too.
  const days = Math.floor(hours / 24);
  return dim(` · resets in ${days}d ${hours % 24}h (${dateLabel(resetsAt)})`);
}

/** "Oct 1" — or "Oct 1, 2027" when it is not this year. */
function dateLabel(d: Date): string {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// Colour only when attached to a terminal, so piped output stays clean.
const tty = process.stdout.isTTY;
const wrap = (code: string) => (s: string) => (tty ? `[${code}m${s}[0m` : s);
const dim = wrap('2');
const red = wrap('31');
const yellow = wrap('33');
const green = wrap('32');
