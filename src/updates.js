// Checks GitHub for a newer published release, and downloads its installer when the user asks to
// update. The installer is only ever taken from our own repo's releases, and its content must
// match the SHA-256 that GitHub lists for it before it can be run.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LATEST_RELEASE_API = 'https://api.github.com/repos/ThomasLpgs/VirtualDeck/releases/latest';
const RELEASES_PAGE = 'https://github.com/ThomasLpgs/VirtualDeck/releases/latest';
const DOWNLOAD_PREFIX = 'https://github.com/ThomasLpgs/VirtualDeck/releases/download/';
const TIMEOUT_MS = 10000;
// A download that receives nothing for this long is dropped (a slow one goes on).
const STALL_MS = 30000;
// Well above the ~110 MB installer, so a wrong size in the release can't fill the disk.
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;

// "v1.2.3" -> [1, 2, 3]; anything after the numbers (e.g. "-beta") is ignored.
function parseVersion(text) {
  const match = String(text).match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// The release's installer, when it can be installed in one click: our own file name and download
// address, and a SHA-256 to check it against. Otherwise null (the user gets the release page).
function installerOf(release, tag, version) {
  const name = `VirtualDeck-Setup-${version}.exe`;
  const asset = (Array.isArray(release.assets) ? release.assets : []).find((a) => a?.name === name);
  const sha256 = String(asset?.digest || '').match(/^sha256:([0-9a-f]{64})$/i)?.[1];
  const url = String(asset?.browser_download_url || '');
  if (!sha256 || url !== `${DOWNLOAD_PREFIX}${encodeURIComponent(tag)}/${name}`) return null;
  const size = Number(asset.size);
  if (!(size > 0 && size <= MAX_INSTALLER_BYTES)) return null;
  return { name, url, size, sha256: sha256.toLowerCase() };
}

// Returns { version, url, installer } when a newer release exists (installer may be null), null
// otherwise (including when offline).
async function checkForUpdate(currentVersion) {
  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VirtualDeck' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const release = await response.json();
    if (!isNewer(release.tag_name, currentVersion)) return null;
    // Only ever open our own repo's pages, whatever the response says.
    const url = String(release.html_url || '').startsWith('https://github.com/ThomasLpgs/VirtualDeck/')
      ? release.html_url
      : RELEASES_PAGE;
    const version = parseVersion(release.tag_name).join('.');
    return { version, url, installer: installerOf(release, String(release.tag_name), version) };
  } catch {
    return null;
  }
}

// Downloads the installer into dir (emptied first) and checks it. onProgress(fraction 0-1).
// Resolves to the installer's path; rejects, leaving nothing behind, on any problem.
async function downloadInstaller(installer, dir, onProgress = () => {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, `${installer.name}.part`);
  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(), STALL_MS);
  const out = fs.createWriteStream(part);
  try {
    const response = await fetch(installer.url, {
      headers: { 'User-Agent': 'VirtualDeck' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const hash = crypto.createHash('sha256');
    let received = 0;
    for await (const chunk of response.body) {
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(), STALL_MS);
      received += chunk.length;
      if (received > installer.size) throw new Error('size');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      onProgress(received / installer.size);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (received !== installer.size || hash.digest('hex') !== installer.sha256) throw new Error('checksum');
    const file = path.join(dir, installer.name);
    fs.renameSync(part, file);
    return file;
  } catch (err) {
    if (!out.closed) {
      await new Promise((resolve) => {
        out.once('close', resolve);
        out.destroy();
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    clearTimeout(stall);
  }
}

module.exports = { checkForUpdate, downloadInstaller, isNewer };
