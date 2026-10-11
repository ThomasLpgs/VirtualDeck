const { shell } = require('electron');
const { t } = require('./i18n');

// Anything that looks like "scheme:" (https:, spotify:, steam:...) but not a drive letter like "C:".
const URI_RE = /^[a-z][a-z0-9+.-]+:/i;

function required(value, fieldKey) {
  if (!value) throw new Error(t('error.missingField', { field: t(fieldKey) }));
  return value;
}

// stream: the active streaming software client (ObsManager or StreamlabsManager).
// Action type ids keep their historical "obs-" prefix so existing configs stay valid.
async function runAction(action, { stream, playSound }) {
  switch (action?.type) {
    case 'obs-scene':
      await stream.setScene(required(action.scene, 'field.scene'));
      return;
    case 'obs-source':
      await stream.setSourceVisibility(
        action.scene,
        required(action.source, 'field.source'),
        action.mode || 'toggle',
        (Number(action.duration) || 5) * 1000,
      );
      return;
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
