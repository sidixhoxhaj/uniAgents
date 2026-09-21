/**
 * `unicode status` — what accounts exist, right now, without starting anything.
 *
 * Deliberately does NOT read secret values by default: enumeration alone
 * answers "what do I have", and reading a credential can prompt for keychain
 * authorisation. `--check` opts into reading them to report expiry.
 *
 * Live quota numbers only exist during a session, because they come from
 * Anthropic's response headers and nothing is stored.
 */

import { discoverAccounts, readCredential, isExpired, credentialLocationHint } from '../accounts/discover.ts';

export async function cmdStatus(opts: { check?: boolean } = {}): Promise<number> {
  const accounts = await discoverAccounts();

  if (accounts.length === 0) {
    console.log(`No Claude accounts found — looked in ${credentialLocationHint()}.\n`);
    console.log('Run `claude` and log in. uniAgents uses the accounts you already have,');
    console.log('so there is nothing to add here.');
    return 1;
  }

  const width = Math.max(...accounts.map((a) => a.label.length), 7);
  console.log(`${accounts.length} account${accounts.length === 1 ? '' : 's'} available\n`);
  console.log(`  ${'ACCOUNT'.padEnd(width)}  SOURCE    ORDER${opts.check ? '  STATUS' : ''}`);

  let problems = 0;
  for (const [i, a] of accounts.entries()) {
    let suffix = '';
    if (opts.check) {
      try {
        const credential = await readCredential(a);
        if (isExpired(credential)) {
          suffix = '  expired — re-run `claude` for this account';
          problems++;
        } else {
          const plan = credential.subscriptionType ? ` (${credential.subscriptionType})` : '';
          suffix = `  ok${plan}`;
        }
      } catch (err) {
        suffix = `  unreadable — ${(err as Error).message.split(':').pop()?.trim() ?? 'unknown error'}`;
        problems++;
      }
    }
    console.log(`  ${a.label.padEnd(width)}  ${a.source.padEnd(8)}  ${String(i + 1).padEnd(5)}${suffix}`);
  }

  console.log('\nOrder is the rotation order — the default login is used first.');
  if (!opts.check) console.log('Add --check to verify each credential is readable and unexpired.');
  console.log('Live usage appears on the stats page during a session: `unicode`.');

  return problems > 0 ? 1 : 0;
}
