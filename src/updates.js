// Checks GitHub for a newer published release. Nothing is downloaded or installed:
// the app only points the user to the release page.
const LATEST_RELEASE_API = 'https://api.github.com/repos/ThomasLpgs/VirtualDeck/releases/latest';
const RELEASES_PAGE = 'https://github.com/ThomasLpgs/VirtualDeck/releases/latest';
const TIMEOUT_MS = 10000;

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

// Returns { version, url } when a newer release exists, null otherwise (including when offline).
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
    return { version: parseVersion(release.tag_name).join('.'), url };
  } catch {
    return null;
  }
}

module.exports = { checkForUpdate, isNewer };
