import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCredential, isExpired, serviceNameForConfigDir, AccountError } from '../src/accounts/discover.ts';

test('parses the nested claudeAiOauth shape Claude Code writes', () => {
  const c = parseCredential(JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-tok',
      refreshToken: 'sk-ref',
      expiresAt: 1787191800000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
  }), 'test');
  assert.equal(c.accessToken, 'sk-tok');
  assert.equal(c.refreshToken, 'sk-ref');
  assert.equal(c.subscriptionType, 'max');
  // expiresAt is epoch MILLISECONDS here (unlike the rate-limit headers, which
  // are epoch seconds — mixing them up silently dates everything to 1970).
  assert.equal(c.expiresAt?.getUTCFullYear(), 2026);
});

test('falls back to a top-level shape if the nested one is absent', () => {
  const c = parseCredential(JSON.stringify({ accessToken: 'sk-tok' }), 'test');
  assert.equal(c.accessToken, 'sk-tok');
  assert.equal(c.refreshToken, null);
  assert.equal(c.expiresAt, null);
});

test('a missing or empty token fails loudly instead of returning an empty string', () => {
  // An empty token would 401 upstream and look like a revoked account, sending
  // the user to re-authenticate something that was never broken.
  assert.throws(() => parseCredential(JSON.stringify({ claudeAiOauth: {} }), 'x'), AccountError);
  assert.throws(() => parseCredential(JSON.stringify({ claudeAiOauth: { accessToken: '' } }), 'x'), AccountError);
  assert.throws(() => parseCredential('not json', 'x'), AccountError);
  assert.throws(() => parseCredential('[]', 'x'), AccountError);
});

test('REGRESSION: an MCP connector cache is not a Claude account', () => {
  // Claude Code stores MCP connector tokens (Canva, Notion, Linear, …) under
  // the SAME `Claude Code-credentials-*` keychain service names as real
  // logins. Found on a real machine: 6 of 8 matching entries were connector
  // caches. Treating them as accounts puts entries in the rotation pool that
  // can never serve a request.
  const connectorCache = JSON.stringify({
    mcpOAuth: {
      'plugin:marketing:canva|e6773fb3': { serverName: 'canva', accessToken: 'mcp-token' },
    },
  });
  assert.throws(() => parseCredential(connectorCache, 'x'), /MCP connector tokens, not a Claude login/);
});

test('an entry carrying BOTH shapes is still a real account', () => {
  const both = JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-real' },
    mcpOAuth: { 'plugin:x|1': { accessToken: 'mcp' } },
  });
  assert.equal(parseCredential(both, 'x').accessToken, 'sk-real');
});

test('expiry is compared against the supplied clock', () => {
  const c = parseCredential(JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: 2000 } }), 'x');
  assert.equal(isExpired(c, new Date(1999)), false);
  assert.equal(isExpired(c, new Date(2001)), true);
});

test('a credential with no expiry is never treated as expired', () => {
  const c = parseCredential(JSON.stringify({ accessToken: 't' }), 'x');
  assert.equal(isExpired(c, new Date(8.64e15)), false);
});

test('the keychain service name matches Claude Code sha256(configDir)[:8] convention', () => {
  // This is what lets us find isolated logins without being told about them.
  const name = serviceNameForConfigDir('/Users/someone/.claude');
  assert.match(name, /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.equal(serviceNameForConfigDir('/a'), serviceNameForConfigDir('/a'));
  assert.notEqual(serviceNameForConfigDir('/a'), serviceNameForConfigDir('/b'));
});

/* ---- who may spend your quota ---- */

/**
 * The proxy must NOT inject ANTHROPIC_AUTH_TOKEN: doing so makes Claude Code
 * treat itself as having a custom auth source and silently drops every
 * claude.ai-hosted MCP connector. It authenticates callers against the OAuth
 * credential the CLI already sends instead, so that check carries the whole
 * security property and is worth pinning.
 */
async function gatewayHolding(...tokens: string[]) {
  const { Gateway } = await import('../src/proxy/gateway.ts');
  const gateway = new Gateway();
  const creds = (gateway as unknown as { credentials: Map<string, { accessToken: string }> }).credentials;
  tokens.forEach((accessToken, i) => creds.set(`acct-${i}`, { accessToken }));
  return gateway;
}

test('a caller bearing a pooled account’s credential is authorised', async () => {
  const gateway = await gatewayHolding('sk-ant-oat01-aaa', 'sk-ant-oat01-bbb');
  assert.equal(gateway.authorisesCaller('sk-ant-oat01-aaa'), true);
  assert.equal(gateway.authorisesCaller('sk-ant-oat01-bbb'), true, 'any pooled account authorises, not just the first');
});

test('a caller with an unknown or absent credential is refused', async () => {
  const gateway = await gatewayHolding('sk-ant-oat01-aaa');
  for (const bogus of ['', 'sk-ant-oat01-bbb', 'sk-ant-oat01-aa', 'sk-ant-oat01-aaaa']) {
    assert.equal(gateway.authorisesCaller(bogus), false, `must refuse ${JSON.stringify(bogus)}`);
  }
});

test('a gateway with no credentials authorises nobody', async () => {
  // Fail closed: before discovery has read anything, nothing may spend quota.
  const gateway = await gatewayHolding();
  assert.equal(gateway.authorisesCaller('sk-ant-oat01-aaa'), false);
  assert.equal(gateway.authorisesCaller(''), false);
});
