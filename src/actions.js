const { shell } = require('electron');
const { t } = require('./i18n');

// Anything that looks like "scheme:" (https:, spotify:, steam:...) but not a drive letter like "C:".
const URI_RE = /^[a-z][a-z0-9+.-]+:/i;

function required(value, fieldKey) {
  if (!value) throw new Error(t('error.missingField', { field: t(fieldKey) }));
  return value;
}

// stream: the active streaming software client (ObsManager or StreamlabsManager).
// Resolves to { warning } when only part of the key could run (vertical part without the plugin).
// Action type ids keep their historical "obs-" prefix so existing configs stay valid.
async function runAction(action, { stream, playSound }) {
  switch (action?.type) {
    case 'obs-scene': {
      // Each filled field switches its canvas: the regular one and/or the Aitum Vertical one.
      const { scene } = action;
      let { verticalScene } = action;
      if (!scene && !verticalScene) required('', 'field.scene');
      // Without the plugin, a key that also has a horizontal scene still switches that one.
      let warning = null;
      if (scene && verticalScene && !stream.state.verticalAvailable) {
        warning = stream.verticalUnavailableMessage();
        verticalScene = '';
      }
      const switches = [];
      if (scene) switches.push([stream.setScene, scene]);
      if (verticalScene) {
        // Before switching anything, so the horizontal scene never changes alone on a failure.
        await stream.checkVerticalScene(verticalScene);
        switches.push([stream.setVerticalScene, verticalScene]);
      }
      // Both at once, so the two outputs change together.
      await Promise.all(switches.map(([fn, name]) => fn.call(stream, name)));
      return warning ? { warning } : undefined;
    }
    case 'obs-source': {
      // Horizontal and/or vertical (Aitum Vertical) source: each one acts when its source is filled,
      // so a single key can play the same animation on both canvases.
      const targets = [];
      if (action.source) targets.push({ sceneName: action.scene, sourceName: action.source, vertical: false });
      let warning = null;
      if (action.verticalSource) {
        if (targets.length && !stream.state.verticalAvailable) {
          // Without the plugin, the horizontal animation still plays.
          warning = stream.verticalUnavailableMessage();
        } else {
          targets.push({ sceneName: action.verticalScene, sourceName: action.verticalSource, vertical: true });
        }
      }
      if (!targets.length) required('', 'field.source');
      await stream.setSourcesVisibility(targets, action.mode || 'toggle', (Number(action.duration) || 5) * 1000);
      return warning ? { warning } : undefined;
    }
    case 'obs-record':
      await stream.toggleRecord();
      return;
    case 'obs-stream':
      await stream.toggleStream();
      return;
    case 'sound':
      playSound(required(action.file, 'field.soundFile'), action.volume ?? 1);
      return;
    case 'open': {
      const target = required(action.target?.trim(), 'field.target');
      if (URI_RE.test(target)) {
        await shell.openExternal(target);
      } else {
        const error = await shell.openPath(target);
        if (error) throw new Error(t('error.openFailed', { target, error }));
      }
      return;
    }
    default:
      return;
  }
}

module.exports = { runAction };
