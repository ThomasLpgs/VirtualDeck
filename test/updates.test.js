const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const { checkForUpdate, downloadInstaller, isNewer } = require('../src/updates');

const DOWNLOAD = 'https://github.com/ThomasLpgs/VirtualDeck/releases/download/v9.0.0/VirtualDeck-Setup-9.0.0.exe';
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const asset = (fields = {}) => ({
  name: 'VirtualDeck-Setup-9.0.0.exe',
  size: 6,
  digest: `sha256:${sha256('abcdef')}`,
  browser_download_url: DOWNLOAD,
  ...fields,
});
// A fetch response whose body arrives in several chunks, like a real download.
const body = (...chunks) => ({
  ok: true,
  body: new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(Buffer.from(chunk)));
      controller.close();
    },
  }),
});

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
    installer: null,
  });
});

test('offers a one-click install only for our own installer with a checksum', async (t) => {
  let assets = [asset()];
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ tag_name: 'v9.0.0', assets }) }));
  assert.deepEqual((await checkForUpdate('1.1.0')).installer, {
    name: 'VirtualDeck-Setup-9.0.0.exe',
    url: DOWNLOAD,
    size: 6,
    sha256: sha256('abcdef'),
  });
  for (const bad of [
    { digest: undefined },
    { digest: 'md5:abc' },
    { browser_download_url: 'https://evil.example/VirtualDeck-Setup-9.0.0.exe' },
    { browser_download_url: DOWNLOAD.replace('ThomasLpgs', 'someone') },
    { name: 'VirtualDeck-Setup-8.0.0.exe' },
    { size: 0 },
    { size: 10 * 1024 * 1024 * 1024 },
  ]) {
    assets = [asset(bad)];
    assert.equal((await checkForUpdate('1.1.0')).installer, null, JSON.stringify(bad));
  }
});

test('downloads the installer and checks it against its checksum', async (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vdeck-update-')), 'update');
  const fetch = t.mock.method(globalThis, 'fetch', async () => body('abc', 'def'));
  const installer = { name: 'VirtualDeck-Setup-9.0.0.exe', url: DOWNLOAD, size: 6, sha256: sha256('abcdef') };
  const progress = [];
  const file = await downloadInstaller(installer, dir, (p) => progress.push(p));
  assert.equal(file, path.join(dir, installer.name));
  assert.equal(fs.readFileSync(file, 'utf8'), 'abcdef');
  assert.deepEqual(progress, [0.5, 1]);
  assert.equal(fetch.mock.calls[0].arguments[0], DOWNLOAD);

  // Altered, cut short or too long: rejected, and nothing is left on the disk.
  for (const chunks of [['abcxyz'], ['abc'], ['abcdef', 'g']]) {
    fetch.mock.mockImplementation(async () => body(...chunks));
    await assert.rejects(downloadInstaller(installer, dir), chunks.join());
    assert.equal(fs.existsSync(dir), false);
  }
  fetch.mock.mockImplementation(async () => ({ ok: false, status: 404 }));
  await assert.rejects(downloadInstaller(installer, dir), /404/);
  assert.equal(fs.existsSync(dir), false);
});

test('a disk error while downloading fails cleanly, without crashing the app', async (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vdeck-update-')), 'update');
  t.mock.method(globalThis, 'fetch', async () => body('abc', 'def'));
  // A full disk: the file refuses the data.
  t.mock.method(fs, 'createWriteStream', () => new Writable({ write: (_chunk, _enc, done) => done(new Error('ENOSPC')) }));
  const installer = { name: 'VirtualDeck-Setup-9.0.0.exe', url: DOWNLOAD, size: 6, sha256: sha256('abcdef') };
  await assert.rejects(downloadInstaller(installer, dir), /ENOSPC|abort/i);
  assert.equal(fs.existsSync(dir), false);
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
