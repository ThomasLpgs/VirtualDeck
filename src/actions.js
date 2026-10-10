const { shell } = require('electron');

// Anything that looks like "scheme:" (https:, spotify:, steam:...) but not a drive letter like "C:".
const URI_RE = /^[a-z][a-z0-9+.-]+:/i;

function required(value, what) {
  if (!value) throw new Error(`Bouton mal configuré : ${what} manquant(e).`);
  return value;
}

async function runAction(action, { obs, playSound }) {
  switch (action?.type) {
    case 'obs-scene':
      await obs.call('SetCurrentProgramScene', { sceneName: required(action.scene, 'scène') });
      return;
    case 'obs-source':
      await obs.setSourceVisibility(
        action.scene,
        required(action.source, 'source'),
        action.mode || 'toggle',
        (Number(action.duration) || 5) * 1000,
      );
      return;
    case 'obs-record':
      await obs.call('ToggleRecord');
      return;
    case 'obs-stream':
      await obs.call('ToggleStream');
      return;
    case 'sound':
      playSound(required(action.file, 'fichier son'), action.volume ?? 1);
      return;
    case 'open': {
      const target = required(action.target?.trim(), 'cible');
      if (URI_RE.test(target)) {
        await shell.openExternal(target);
      } else {
        const error = await shell.openPath(target);
        if (error) throw new Error(`Impossible d'ouvrir « ${target} » : ${error}`);
      }
      return;
    }
    default:
      return;
  }
}

module.exports = { runAction };
