const { shell } = require('electron');
const { t } = require('./i18n');

const MAX_STEP_DELAY_S = 600;

// Anything that looks like "scheme:" (https:, spotify:, steam:...) but not a drive letter like "C:".
const URI_RE = /^[a-z][a-z0-9+.-]+:/i;

function required(value, fieldKey) {
  if (!value) throw new Error(t('error.missingField', { field: t(fieldKey) }));
  return value;
}

// Canvases a stream / record / clip key acts on. action.target: 'horizontal' (OBS, the default),
// 'vertical' (Aitum Vertical) or 'both'. Without the plugin, 'both' falls back to horizontal
// with a warning; 'vertical' alone then fails in the stream client.
function outputTargets(action, stream) {
  const target = action.target || 'horizontal';
  const horizontal = target !== 'vertical';
  const vertical = target !== 'horizontal';
  if (horizontal && vertical && !stream.state.verticalAvailable) {
    return { horizontal, vertical: false, warning: stream.verticalUnavailableMessage() };
  }
  return { horizontal, vertical, warning: null };
}

// stream: the active streaming software client (ObsManager or StreamlabsManager).
// Resolves to { warning } when only part of the key could run (vertical part without the plugin),
// and/or { notice } to confirm something the user can't see (a saved clip), and/or { page } for the
// deck to show ('next', 'prev' or a page number, handled by main.js).
// Action type ids keep their historical "obs-" prefix so existing configs stay valid.
async function runAction(action, context) {
  const { stream, playSound } = context;
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
    case 'obs-mute':
      await stream.setInputMute(required(action.input, 'field.input'), action.mode || 'toggle');
      return;
    case 'obs-replay': {
      // Clip from the replay buffer and/or Aitum Vertical's Backtrack.
      const { warning, ...targets } = outputTargets(action, stream);
      await stream.saveReplay(targets);
      return { notice: t('notice.replaySaved'), warning };
    }
    case 'obs-record':
    case 'obs-stream': {
      const { warning, ...targets } = outputTargets(action, stream);
      if (action.type === 'obs-record') await stream.toggleRecord(targets);
      else await stream.toggleStream(targets);
      return warning ? { warning } : undefined;
    }
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
    case 'hue':
      // Philips Hue lights (hue.js, through main.js which holds the bridge settings).
      await context.hue(action);
      return;
    case 'govee':
      // Govee lights, on the home network (govee.js, through main.js).
      await context.govee(action);
      return;
    case 'page':
      return { page: action.page || 'next' };
    case 'multi':
      return runSteps(action.steps, context);
    default:
      return;
  }
}

// Steps of a multi-action, in order, each after its optional wait. A failing step doesn't stop
// the others (a "Pause" key should still switch the scene if the music fails); failures are
// reported together at the end.
async function runSteps(steps, context) {
  if (!Array.isArray(steps) || !steps.length) throw new Error(t('error.multiEmpty'));
  const errors = [];
  let warning = null;
  let notice = null;
  let page = null;
  for (const [index, step] of steps.entries()) {
    const delay = Math.min(MAX_STEP_DELAY_S, Math.max(0, Number(step?.delay) || 0));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    // No multi-action inside a multi-action: it could loop forever.
    if (step?.action?.type === 'multi') continue;
    try {
      const result = await runAction(step?.action, context);
      warning ??= result?.warning ?? null;
      notice ??= result?.notice ?? null;
      page = result?.page ?? page;
    } catch (err) {
      errors.push(t('error.multiStep', { n: index + 1, error: err.message }));
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { warning, notice, page };
}

// Whether an action talks to OBS / Streamlabs (directly or in one of its steps). Only those wait
// for a connection attempt before running: a sound, a program or a page must stay instant.
function needsStream(action) {
  if (action?.type === 'multi') return (action.steps || []).some((step) => needsStream(step?.action));
  return typeof action?.type === 'string' && action.type.startsWith('obs-');
}

module.exports = { runAction, needsStream };
