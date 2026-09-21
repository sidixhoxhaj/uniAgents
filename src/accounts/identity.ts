/**
 * Resolves an access token to the human identity behind it, so the stats page
 * can say "you@gmail.com · Claude Pro" instead of "2b636ecd".
 *
 * Best-effort in every sense: one lookup per account at startup, cached in
 * memory for the process lifetime, and a failure costs a nice label and
 * nothing else. A token minted by `claude setup-token` is scoped for headless
 * inference only and gets a 403 here — that account still works perfectly, it
 * just shows its short id instead.
 *
 * Nothing is written to disk, consistent with the rest of the tool.
 */

export interface AccountIdentity {
  email: string | null;
  displayName: string | null;
  organizationName: string | null;
  /** e.g. claude_pro, claude_team, claude_max — the plan behind the account. */
  organizationType: string | null;
}

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const TIMEOUT_MS = 8000;

export async function fetchIdentity(accessToken: string): Promise<AccountIdentity | null> {
  try {
    const res = await fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null; // 403 = headless-scoped token; not an error worth surfacing
    const data = (await res.json()) as Record<string, unknown>;

    const account = asRecord(data['account']);
    const organization = asRecord(data['organization']);

    return {
      // The field has been spelled both ways across versions; accept either.
      email: str(account?.['email_address']) ?? str(account?.['email']),
      displayName: str(account?.['display_name']) ?? str(account?.['full_name']),
      organizationName: str(organization?.['name']),
      organizationType: str(organization?.['organization_type']),
    };
  } catch {
    return null; // offline, timed out, or malformed — the account still works
  }
}

/** "Claude Pro", "Claude Team" … from an organization_type like claude_pro. */
export function planLabel(organizationType: string | null): string | null {
  if (!organizationType) return null;
  const known: Record<string, string> = {
    claude_pro: 'Claude Pro',
    claude_max: 'Claude Max',
    claude_team: 'Claude Team',
    claude_enterprise: 'Claude Enterprise',
  };
  return known[organizationType] ?? titleCase(organizationType.replace(/_/g, ' '));
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
