/**
 * Discovery behaviour that does not need a real keychain.
 *
 * The keychain path is macOS-only and inherently environment-dependent, so it
 * is proven by running `unicode status` on a real machine rather than mocked here.
 * What IS worth pinning down is the platform contract and the messages a user
 * sees when something is missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialLocationHint, assertSupportedPlatform, discoverAccounts } from '../src/accounts/discover.ts';

test('the missing-login hint names THIS platform, never another one', () => {
  // Telling a Linux user to check the macOS Keychain sends them looking for
  // something that does not exist on their machine.
  const hint = credentialLocationHint();
  if (process.platform === 'darwin') {
    assert.match(hint, /Keychain/);
  } else {
    assert.match(hint, /\.credentials\.json/);
    assert.doesNotMatch(hint, /Keychain/);
  }
});

test('macOS and Linux are supported platforms', () => {
  assert.doesNotThrow(() => assertSupportedPlatform());
});

test('discovery returns a stable, deduplicated order with the default login first', async () => {
  const a = await discoverAccounts();
  const b = await discoverAccounts();
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id), 'order must be reproducible across runs');

  const ids = a.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'no account may be discovered twice');

  const defaultIndex = a.findIndex((x) => x.label === 'default');
  if (defaultIndex !== -1) {
    assert.equal(defaultIndex, 0, 'the default login is used first');
  }
});

test('every discovered account carries the fields the gateway relies on', async () => {
  for (const account of await discoverAccounts()) {
    assert.ok(account.id.length > 0, 'id is the rotation key');
    assert.ok(account.label.length > 0, 'label is what the user sees');
    assert.ok(account.source === 'keychain' || account.source === 'file');
    if (account.source === 'file') assert.ok(account.path, 'file accounts must carry their path');
  }
});
