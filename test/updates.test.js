const test = require('node:test');
const assert = require('node:assert/strict');
const { checkForUpdate, isNewer } = require('../src/updates');

test('compares versions number by number', () => {
  assert.equal(isNewer('v1.2.0', '1.1.0'), true);
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('v1.1.0', '1.1.0'), false);
  assert.equal(isNewer('v1.0.9', '1.1.0'), false);
  assert.equal(isNewer('nightly', '1.1.0'), false);
});

test('reports a newer GitHub release, linking only to our own repo', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ tag_name: 'v9.0.0', html_url: 'https://evil.example/download' }),
  }));
  assert.deepEqual(await checkForUpdate('1.1.0'), {
    version: '9.0.0',
    url: 'https://github.com/ThomasLpgs/VirtualDeck/releases/latest',
  });
});

test('stays silent when up to date, offline or without releases', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ tag_name: 'v1.1.0' }) }));
  assert.equal(await checkForUpdate('1.1.0'), null);
  fetch.mock.mockImplementation(async () => ({ ok: false }));
  assert.equal(await checkForUpdate('1.1.0'), null);
  fetch.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  assert.equal(await checkForUpdate('1.1.0'), null);
});
