// Delays between attempts to reach OBS / Streamlabs while it isn't running: quick at first (it is
// probably starting), then rare, so a PC that starts VirtualDeck with Windows but doesn't stream
// today isn't knocking every 5 s. Opening the deck or the editor, or pressing a key, tries again
// at once (wake() in obs.js / streamlabs.js).
const RETRY_STEPS_MS = [5000, 10000, 30000, 60000, 120000];

const retryDelay = (failures) => RETRY_STEPS_MS[Math.min(Math.max(0, failures), RETRY_STEPS_MS.length - 1)];

module.exports = { retryDelay, RETRY_STEPS_MS };
