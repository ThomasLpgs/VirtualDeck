/* global t -- from shared/i18n.js */
/* eslint-disable no-unused-vars -- used by editor.js */

// Ready-made decks of the editor's library ("Modèles"). Each one becomes a page of keys.
// Texts are i18n keys, translated when the template is shown or added. Built in, nothing is
// downloaded. A key may ask to be filled from the streaming software when it is added
// (fill: 'scene' takes the n-th scene, fill: 'mic' the microphone input).

const TEMPLATE_COLORS = {
  grey: '#8b8d98',
  red: '#f2555a',
  orange: '#f5843b',
  amber: '#f2b33d',
  green: '#3fcf8e',
  teal: '#2bc4c4',
  blue: '#4c8dff',
  indigo: '#7c8cff',
  violet: '#b06cff',
  pink: '#f062a8',
};

const TEMPLATE_CATEGORIES = ['stream', 'chat', 'music', 'work'];

const keysAction = (keys) => ({ type: 'keys', keys });
const mediaAction = (key, repeat) => ({ type: 'media', key, ...(repeat ? { repeat } : {}) });

const TEMPLATES = [
  {
    id: 'stream',
    category: 'stream',
    icon: 'radio',
    needsStream: true,
    grid: { cols: 4, rows: 2 },
    keys: [
      { label: 'tpl.stream.scene', n: 1, symbol: 'clapperboard', color: 'indigo', action: { type: 'obs-scene', scene: '' }, fill: 'scene' },
      { label: 'tpl.stream.scene', n: 2, symbol: 'clapperboard', color: 'blue', action: { type: 'obs-scene', scene: '' }, fill: 'scene' },
      { label: 'tpl.stream.scene', n: 3, symbol: 'clapperboard', color: 'teal', action: { type: 'obs-scene', scene: '' }, fill: 'scene' },
      { label: 'tpl.stream.scene', n: 4, symbol: 'clapperboard', color: 'violet', action: { type: 'obs-scene', scene: '' }, fill: 'scene' },
      { label: 'tpl.stream.live', symbol: 'radio', color: 'red', action: { type: 'obs-stream' } },
      { label: 'tpl.stream.record', symbol: 'circle-dot', color: 'orange', action: { type: 'obs-record' } },
      { label: 'tpl.stream.clip', symbol: 'film', color: 'amber', action: { type: 'obs-replay' } },
      { label: 'tpl.stream.mic', symbol: 'mic-off', color: 'pink', action: { type: 'obs-mute', input: '', mode: 'toggle' }, fill: 'mic' },
    ],
  },
  {
    id: 'chat',
    category: 'chat',
    icon: 'messages-square',
    grid: { cols: 3, rows: 2 },
    keys: [
      { label: 'tpl.chat.follow', symbol: 'heart', color: 'pink', action: { type: 'text', text: 'tpl.chat.followText', enter: true } },
      { label: 'tpl.chat.welcome', symbol: 'hand', color: 'amber', action: { type: 'text', text: 'tpl.chat.welcomeText', enter: true } },
      { label: 'tpl.chat.brb', symbol: 'coffee', color: 'orange', action: { type: 'text', text: 'tpl.chat.brbText', enter: true } },
      { label: 'tpl.chat.gg', symbol: 'party-popper', color: 'green', action: { type: 'text', text: 'tpl.chat.ggText', enter: true } },
      { label: 'tpl.chat.thanks', symbol: 'sparkles', color: 'violet', action: { type: 'text', text: 'tpl.chat.thanksText', enter: true } },
      // The link is the streamer's own: to complete.
      { label: 'tpl.chat.discord', symbol: 'messages-square', color: 'indigo', action: { type: 'text', text: 'tpl.chat.discordText', enter: true }, todo: true },
    ],
  },
  {
    id: 'discord',
    category: 'chat',
    icon: 'headphones',
    grid: { cols: 3, rows: 1 },
    keys: [
      { label: 'tpl.discord.mute', symbol: 'mic-off', color: 'red', action: keysAction('Control+Shift+M') },
      { label: 'tpl.discord.deafen', symbol: 'headphones', color: 'orange', action: keysAction('Control+Shift+D') },
      { label: 'tpl.discord.open', symbol: 'messages-square', color: 'indigo', action: { type: 'open', target: 'discord://' } },
    ],
  },
  {
    id: 'music',
    category: 'music',
    icon: 'music',
    grid: { cols: 4, rows: 2 },
    keys: [
      { label: 'tpl.music.prev', symbol: 'skip-back', color: 'teal', action: mediaAction('prev') },
      { label: 'tpl.music.playPause', symbol: 'play', color: 'green', action: mediaAction('playPause') },
      { label: 'tpl.music.next', symbol: 'skip-forward', color: 'teal', action: mediaAction('next') },
      { label: 'tpl.music.stop', symbol: 'square', color: 'grey', action: mediaAction('stop') },
      { label: 'tpl.music.volumeDown', symbol: 'volume-1', color: 'blue', action: mediaAction('volumeDown', 5) },
      { label: 'tpl.music.mute', symbol: 'volume-x', color: 'red', action: mediaAction('volumeMute') },
      { label: 'tpl.music.volumeUp', symbol: 'volume-2', color: 'blue', action: mediaAction('volumeUp', 5) },
      { label: 'tpl.music.spotify', symbol: 'music', color: 'green', action: { type: 'open', target: 'spotify:' } },
    ],
  },
  {
    id: 'windows',
    category: 'work',
    icon: 'monitor',
    grid: { cols: 4, rows: 2 },
    keys: [
      { label: 'tpl.windows.copy', symbol: 'copy', color: 'blue', action: keysAction('Control+C') },
      { label: 'tpl.windows.paste', symbol: 'clipboard-paste', color: 'blue', action: keysAction('Control+V') },
      { label: 'tpl.windows.undo', symbol: 'undo-2', color: 'grey', action: keysAction('Control+Z') },
      { label: 'tpl.windows.screenshot', symbol: 'scissors', color: 'pink', action: keysAction('Super+Shift+S') },
      { label: 'tpl.windows.desktop', symbol: 'monitor', color: 'teal', action: keysAction('Super+D') },
      { label: 'tpl.windows.explorer', symbol: 'folder-open', color: 'amber', action: keysAction('Super+E') },
      { label: 'tpl.windows.taskManager', symbol: 'activity', color: 'red', action: keysAction('Control+Shift+Escape') },
      { label: 'tpl.windows.settings', symbol: 'settings', color: 'grey', action: { type: 'open', target: 'ms-settings:' } },
    ],
  },
  {
    id: 'browser',
    category: 'work',
    icon: 'globe',
    grid: { cols: 4, rows: 2 },
    keys: [
      { label: 'tpl.browser.newTab', symbol: 'plus', color: 'green', action: keysAction('Control+T') },
      { label: 'tpl.browser.closeTab', symbol: 'x', color: 'red', action: keysAction('Control+W') },
      { label: 'tpl.browser.reopenTab', symbol: 'rotate-ccw', color: 'amber', action: keysAction('Control+Shift+T') },
      { label: 'tpl.browser.reload', symbol: 'refresh-cw', color: 'blue', action: keysAction('F5') },
      { label: 'tpl.browser.back', symbol: 'arrow-left', color: 'grey', action: keysAction('Alt+Left') },
      { label: 'tpl.browser.forward', symbol: 'arrow-right', color: 'grey', action: keysAction('Alt+Right') },
      { label: 'tpl.browser.fullscreen', symbol: 'maximize', color: 'violet', action: keysAction('F11') },
      { label: 'tpl.browser.find', symbol: 'search', color: 'teal', action: keysAction('Control+F') },
    ],
  },
  {
    id: 'teams',
    category: 'work',
    icon: 'video',
    grid: { cols: 3, rows: 2 },
    keys: [
      { label: 'tpl.meeting.mute', symbol: 'mic-off', color: 'red', action: keysAction('Control+Shift+M') },
      { label: 'tpl.meeting.camera', symbol: 'video-off', color: 'orange', action: keysAction('Control+Shift+O') },
      { label: 'tpl.meeting.hand', symbol: 'hand', color: 'amber', action: keysAction('Control+Shift+K') },
      { label: 'tpl.meeting.share', symbol: 'screen-share', color: 'blue', action: keysAction('Control+Shift+E') },
      { label: 'tpl.meeting.leave', symbol: 'phone-off', color: 'red', action: keysAction('Control+Shift+H') },
    ],
  },
  {
    id: 'zoom',
    category: 'work',
    icon: 'video',
    grid: { cols: 3, rows: 2 },
    keys: [
      { label: 'tpl.meeting.mute', symbol: 'mic-off', color: 'red', action: keysAction('Alt+A') },
      { label: 'tpl.meeting.camera', symbol: 'video-off', color: 'orange', action: keysAction('Alt+V') },
      { label: 'tpl.meeting.hand', symbol: 'hand', color: 'amber', action: keysAction('Alt+Y') },
      { label: 'tpl.meeting.share', symbol: 'screen-share', color: 'blue', action: keysAction('Alt+S') },
      { label: 'tpl.meeting.record', symbol: 'circle-dot', color: 'pink', action: keysAction('Alt+R') },
      { label: 'tpl.meeting.leave', symbol: 'phone-off', color: 'red', action: keysAction('Alt+Q') },
    ],
  },
];

// A microphone among the streaming software's audio inputs, by its name.
const MIC_NAME = /mic|micro|voice|voix|stimme|voz|headset|casque/i;

// The keys of a template, ready to go into config.buttons (ids are added by the editor).
// lists: what the streaming software has ({ scenes, inputs }), to fill the keys that need it.
// Returns { name, grid, buttons, todo }: todo = keys the user still has to complete.
function buildTemplate(template, lists = {}) {
  const scenes = lists.scenes || [];
  const inputs = lists.inputs || [];
  const mic = inputs.find((name) => MIC_NAME.test(name)) || inputs[0] || '';
  let todo = 0;
  const buttons = template.keys.map((key) => {
    const action = structuredClone(key.action);
    if (action.type === 'text') action.text = t(action.text);
    let label = t(key.label, { n: key.n });
    if (key.fill === 'scene') {
      const scene = scenes[key.n - 1];
      if (scene) {
        action.scene = scene;
        label = scene.slice(0, 40);
      } else {
        todo += 1;
      }
    } else if (key.fill === 'mic') {
      if (mic) action.input = mic;
      else todo += 1;
    }
    if (key.todo) todo += 1;
    return { label, symbol: key.symbol, icon: '', image: '', color: TEMPLATE_COLORS[key.color], hotkey: '', action };
  });
  return { name: t(`tpl.${template.id}.name`).slice(0, 30), grid: { ...template.grid }, buttons, todo };
}
