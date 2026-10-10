/* global api, createKey, createGlyph, renderDeckHeader -- api comes from preload.js, the rest from shared/keys.js */
const $ = (id) => document.getElementById(id);

const SAVE_DEBOUNCE_MS = 400;
const MAX_ICON_RESULTS = 120;
const DEFAULT_COLOR = '#8b8d98';

const PALETTE = [
  ['Gris', '#8b8d98'],
  ['Rouge', '#f2555a'],
  ['Orange', '#f5843b'],
  ['Ambre', '#f2b33d'],
  ['Vert', '#3fcf8e'],
  ['Turquoise', '#2bc4c4'],
  ['Bleu', '#4c8dff'],
  ['Indigo', '#7c8cff'],
  ['Violet', '#b06cff'],
  ['Rose', '#f062a8'],
];

// Shown before the user searches: the icons a streamer reaches for first.
const SUGGESTED_ICONS = [
  'clapperboard', 'video', 'video-off', 'camera', 'camera-off', 'mic', 'mic-off', 'volume-2',
  'volume-x', 'music', 'headphones', 'radio', 'circle-dot', 'circle-stop', 'play', 'pause',
  'skip-forward', 'monitor', 'monitor-play', 'tv', 'cast', 'layers', 'image', 'film',
  'sparkles', 'party-popper', 'zap', 'flame', 'heart', 'star', 'bell', 'megaphone',
  'message-square', 'messages-square', 'users', 'thumbs-up', 'smile', 'laugh', 'hand', 'gift',
  'trophy', 'crown', 'rocket', 'swords', 'skull', 'ghost', 'gamepad-2', 'timer',
  'coffee', 'sun', 'moon', 'eye', 'eye-off', 'globe', 'external-link', 'house',
];

const ACTIONS = [
  { type: 'none', label: 'Aucune', icon: 'ban', defaults: {} },
  { type: 'obs-scene', label: 'Scène OBS', icon: 'clapperboard', defaults: { scene: '' } },
  { type: 'obs-source', label: 'Source / animation', icon: 'layers', defaults: { scene: '', source: '', mode: 'flash', duration: 5 } },
  { type: 'obs-record', label: 'Enregistrer', icon: 'circle-dot', defaults: {} },
  { type: 'obs-stream', label: 'Stream', icon: 'radio', defaults: {} },
  { type: 'sound', label: 'Son', icon: 'volume-2', defaults: { file: '', volume: 1 } },
  { type: 'open', label: 'Ouvrir', icon: 'external-link', defaults: { target: '' } },
];

const SOURCE_MODES = [
  ['flash', 'Animation'],
  ['toggle', 'Basculer'],
  ['show', 'Afficher'],
  ['hide', 'Masquer'],
];

let config = null;
let selected = 0;
let obsState = { status: 'disconnected' };
let icons = { names: [], tags: {} };
let saveTimer = null;
let dragFrom = null;
// Scene / source names fetched from OBS, offered as suggestions in the action fields.
const obsLists = { scenes: [], sources: [] };
// A button the main process asked us to select (from the deck) before config finished loading.
let pendingSelect = null;

api.onEditorSelect((index) => {
  if (!config) {
    pendingSelect = index;
    return;
  }
  showView('buttons');
  select(Math.min(index, config.buttons.length - 1));
});

const current = () => config.buttons[selected];
const fileName = (p) => (p ? p.split(/[\\/]/).pop() : '');
const isObsAction = (type) => type.startsWith('obs-');

function emptyButton() {
  return {
    id: crypto.randomUUID(),
    label: '',
    symbol: '',
    icon: '',
    image: '',
    imageUrl: '',
    color: DEFAULT_COLOR,
    action: { type: 'none' },
  };
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// ---------- Saving (automatic, like the Elgato software) ----------

function setStatus(text, warn = false) {
  $('save-status').textContent = text;
  $('save-status').classList.toggle('warn', warn);
}

function scheduleSave() {
  setStatus('Enregistrement…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

async function save() {
  const result = await api.saveConfig(config);
  if (!result.ok) {
    setStatus(`Erreur : ${result.error}`, true);
    return;
  }
  const hint = $('hotkey-hint');
  if (result.hotkeyOk) {
    setStatus('Enregistré');
    hint.classList.remove('warn');
  } else {
    setStatus('Raccourci indisponible', true);
    hint.textContent = `« ${formatHotkey(config.hotkey).join(' + ')} » est déjà utilisé par une autre application. Choisis-en un autre.`;
    hint.classList.add('warn');
  }
}

// ---------- Tabs ----------

function showView(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
}

// ---------- Preview ----------

function renderPreview() {
  const { cols, rows } = config.grid;
  const preview = $('preview');
  preview.style.gridTemplateColumns = `repeat(${cols}, var(--key-size))`;
  preview.replaceChildren(
    ...config.buttons.slice(0, cols * rows).map((button, i) => {
      const key = createKey(button, i);
      key.classList.toggle('selected', i === selected);
      key.draggable = true;
      key.addEventListener('click', () => select(i));
      key.addEventListener('dragstart', () => (dragFrom = i));
      key.addEventListener('dragover', (e) => {
        e.preventDefault();
        key.classList.add('drop-target');
      });
      key.addEventListener('dragleave', () => key.classList.remove('drop-target'));
      key.addEventListener('drop', (e) => {
        e.preventDefault();
        swap(dragFrom, i);
      });
      return key;
    }),
  );
  markLiveScene();
  $('cols-value').value = cols;
  $('rows-value').value = rows;
  $('preview-hotkey').textContent = formatHotkey(config.hotkey).join(' + ');
}

function markLiveScene() {
  [...$('preview').children].forEach((key, i) => {
    const action = config.buttons[i].action;
    key.classList.toggle(
      'active',
      obsState.status === 'connected' && action.type === 'obs-scene' && action.scene === obsState.currentScene,
    );
  });
}

function select(index) {
  selected = index;
  renderPreview();
  renderInspector();
}

function swap(from, to) {
  dragFrom = null;
  if (from === null || from === to) return renderPreview();
  const b = config.buttons;
  [b[from], b[to]] = [b[to], b[from]];
  select(to);
  scheduleSave();
}

function stepGrid(axis, delta) {
  const max = axis === 'cols' ? 8 : 6;
  config.grid[axis] = Math.min(max, Math.max(1, config.grid[axis] + delta));
  const count = config.grid.cols * config.grid.rows;
  while (config.buttons.length < count) config.buttons.push(emptyButton());
  if (selected >= count) selected = count - 1;
  renderPreview();
  renderInspector();
  scheduleSave();
}

// ---------- Inspector ----------

function updateButton(patch) {
  Object.assign(current(), patch);
  renderPreview();
  renderHead();
  scheduleSave();
}

function updateAction(patch) {
  Object.assign(current().action, patch);
  renderPreview();
  scheduleSave();
}

function renderHead() {
  $('button-number').textContent = selected + 1;
  $('button-title').textContent = current().label || 'Sans titre';
}

function renderInspector() {
  const button = current();
  renderHead();
  $('label').value = button.label;
  $('emoji').value = button.icon;
  $('image-pick').textContent = button.image ? fileName(button.image) : 'Choisir…';
  $('image-pick').title = button.image || '';
  $('image-clear').hidden = !button.image;
  renderIconGrid();
  renderSwatches();
  renderActionTiles();
  renderActionFields();
}

function renderIconGrid() {
  const query = $('icon-search').value.trim().toLowerCase();
  let names;
  if (!query) {
    names = SUGGESTED_ICONS.filter((n) => icons.names.includes(n));
  } else {
    names = icons.names
      .filter((n) => n.includes(query) || icons.tags[n]?.some((t) => t.includes(query)))
      .slice(0, MAX_ICON_RESULTS);
  }

  const cells = names.map((name) => {
    const cell = el('button', { type: 'button', className: 'icon-cell', title: name }, createGlyph(name));
    cell.dataset.name = name;
    cell.setAttribute('role', 'option');
    cell.classList.toggle('selected', current().symbol === name);
    cell.addEventListener('click', () => {
      const same = current().symbol === name;
      updateButton({ symbol: same ? '' : name, icon: same ? current().icon : '' });
      $('emoji').value = current().icon;
      refreshIconSelection();
    });
    return cell;
  });
  if (!cells.length) cells.push(el('p', { className: 'icon-empty', textContent: 'Aucune icône trouvée' }));
  $('icon-grid').replaceChildren(...cells);
}

function refreshIconSelection() {
  for (const cell of $('icon-grid').querySelectorAll('.icon-cell')) {
    cell.classList.toggle('selected', cell.dataset.name === current().symbol);
  }
}

function renderSwatches() {
  const color = current().color.toLowerCase();
  const swatches = PALETTE.map(([name, value]) => {
    const swatch = el('button', { type: 'button', className: 'swatch', title: name });
    swatch.style.setProperty('--swatch', value);
    swatch.classList.toggle('selected', value === color);
    swatch.addEventListener('click', () => {
      updateButton({ color: value });
      renderSwatches();
    });
    return swatch;
  });

  const isCustom = !PALETTE.some(([, value]) => value === color);
  const picker = el('input', { type: 'color', value: color, title: 'Couleur personnalisée' });
  const custom = el('label', { className: 'swatch custom', title: 'Couleur personnalisée' }, picker);
  if (isCustom) {
    custom.classList.add('selected');
    custom.style.setProperty('--swatch', color);
  }
  picker.addEventListener('input', () => updateButton({ color: picker.value }));
  picker.addEventListener('change', renderSwatches);
  $('swatches').replaceChildren(...swatches, custom);
}

function renderActionTiles() {
  const type = current().action.type;
  $('action-tiles').replaceChildren(
    ...ACTIONS.map((action) => {
      const tile = el(
        'button',
        { type: 'button', className: 'action-tile' },
        createGlyph(action.icon),
        el('span', { textContent: action.label }),
      );
      tile.setAttribute('role', 'radio');
      tile.setAttribute('aria-checked', String(action.type === type));
      tile.classList.toggle('selected', action.type === type);
      tile.addEventListener('click', () => {
        if (current().action.type === action.type) return;
        current().action = { type: action.type, ...structuredClone(action.defaults) };
        renderActionTiles();
        renderActionFields();
        renderPreview();
        scheduleSave();
      });
      return tile;
    }),
  );
}

// ---------- Action fields ----------

function field(labelText, control, hintText) {
  const wrap = el('div', { className: 'field' }, el('label', { textContent: labelText }), control);
  if (hintText) wrap.append(el('p', { className: 'muted', textContent: hintText }));
  return wrap;
}

function textInput(value, onInput, { placeholder = '', options } = {}) {
  const input = el('input', { value: value || '', placeholder, spellcheck: false });
  input.addEventListener('input', () => onInput(input.value));
  return options ? combo(input, options, onInput) : input;
}

// Themed replacement for <datalist>, whose native popup is white and cannot be styled.
// Free typing stays allowed: suggestions only filter as you type.
function combo(input, getOptions, onPick) {
  const menu = el('div', { className: 'combo-menu', hidden: true });
  menu.setAttribute('role', 'listbox');
  const wrap = el('div', { className: 'combo' }, input, createGlyph('chevrons-up-down', 'glyph combo-chevron'), menu);
  input.setAttribute('role', 'combobox');
  input.setAttribute('autocomplete', 'off');
  let active = -1;
  const items = () => [...menu.children];

  function close() {
    menu.hidden = true;
    active = -1;
  }
  function pick(value) {
    input.value = value;
    onPick(value);
    close();
  }
  function open() {
    const all = getOptions();
    const query = input.value.trim().toLowerCase();
    // When the field already holds a valid choice, list everything so the user can switch.
    const shown = all.includes(input.value) ? all : all.filter((o) => o.toLowerCase().includes(query));
    if (!shown.length) return close();
    menu.replaceChildren(
      ...shown.map((option) => {
        const item = el('div', { className: 'combo-option', textContent: option });
        item.setAttribute('role', 'option');
        item.classList.toggle('current', option === input.value);
        // mousedown + preventDefault keeps focus in the input, so blur doesn't close the menu first.
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pick(option);
        });
        return item;
      }),
    );
    active = -1;
    menu.hidden = false;
  }
  function move(delta) {
    const list = items();
    if (!list.length) return;
    active = (active + delta + list.length) % list.length;
    list.forEach((item, i) => item.classList.toggle('active', i === active));
    list[active].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (menu.hidden) open();
      else move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(items()[active].textContent);
    } else if (e.key === 'Escape' && !menu.hidden) {
      e.stopPropagation();
      close();
    }
  });
  return wrap;
}

function button(text, onClick, className = 'btn') {
  const b = el('button', { type: 'button', className, textContent: text });
  b.addEventListener('click', onClick);
  return b;
}

function inline(...children) {
  return el('div', { className: 'inline' }, ...children);
}

function segmented(options, value, onChange) {
  const wrap = el('div', { className: 'segmented' });
  for (const [optValue, text] of options) {
    const b = button(text, () => {
      wrap.querySelectorAll('button').forEach((x) => x.classList.toggle('selected', x === b));
      onChange(optValue);
    }, '');
    b.classList.toggle('selected', optValue === value);
    wrap.append(b);
  }
  return wrap;
}

function obsCallout() {
  return el(
    'div',
    { className: 'callout' },
    createGlyph('plug-zap'),
    el('span', { textContent: "OBS n'est pas connecté : les listes de scènes et de sources sont vides." }),
    button('Voir le guide', () => showView('obs')),
  );
}

function renderActionFields() {
  const action = current().action;
  const container = $('action-fields');
  container.replaceChildren();

  if (isObsAction(action.type) && obsState.status !== 'connected') container.append(obsCallout());

  switch (action.type) {
    case 'obs-scene':
      container.append(
        field(
          'Scène',
          textInput(action.scene, (scene) => updateAction({ scene }), {
            options: () => obsLists.scenes,
            placeholder: 'Nom de la scène',
          }),
          'Le bouton affiche un badge LIVE quand cette scène est à l’antenne.',
        ),
      );
      break;

    case 'obs-source': {
      const sceneInput = textInput(
        action.scene,
        (scene) => {
          updateAction({ scene });
          refreshSources(scene);
        },
        { options: () => obsLists.scenes, placeholder: 'Vide = scène en cours' },
      );
      const sourceInput = textInput(action.source, (source) => updateAction({ source }), {
        options: () => obsLists.sources,
        placeholder: 'Nom de la source',
      });

      const duration = el('input', { type: 'number', min: 0.5, max: 600, step: 0.5, value: action.duration ?? 5 });
      duration.addEventListener('input', () => updateAction({ duration: Number(duration.value) || 5 }));
      const durationField = field('Durée (secondes)', duration, 'Mets la durée de ta vidéo : la source se masque ensuite toute seule.');
      durationField.hidden = action.mode !== 'flash';

      container.append(
        field('Scène', sceneInput),
        field('Source', sourceInput),
        field(
          'Comportement',
          segmented(SOURCE_MODES, action.mode || 'toggle', (mode) => {
            updateAction({ mode });
            durationField.hidden = mode !== 'flash';
          }),
        ),
        durationField,
      );
      refreshSources(action.scene);
      break;
    }

    case 'obs-record':
      container.append(el('p', { className: 'muted', textContent: "Lance l'enregistrement OBS, ou l'arrête s'il est en cours." }));
      break;

    case 'obs-stream':
      container.append(el('p', { className: 'muted', textContent: "Lance le stream OBS, ou l'arrête s'il est en cours." }));
      break;

    case 'sound': {
      const name = el('span', { className: 'file-name', textContent: fileName(action.file) || 'Aucun fichier' });
      const volume = el('input', { type: 'range', min: 0, max: 100, value: Math.round((action.volume ?? 1) * 100) });
      const volumeValue = el('span', { className: 'range-value', textContent: `${volume.value} %` });
      volume.addEventListener('input', () => {
        volumeValue.textContent = `${volume.value} %`;
        updateAction({ volume: Number(volume.value) / 100 });
      });
      container.append(
        field(
          'Fichier son',
          inline(
            name,
            button('Choisir…', async () => {
              const picked = await api.pickFile('sound');
              if (!picked) return;
              name.textContent = fileName(picked.path);
              updateAction({ file: picked.path });
            }),
          ),
          'Appuyer à nouveau pendant la lecture arrête le son.',
        ),
        field('Volume', inline(volume, volumeValue)),
      );
      break;
    }

    case 'open': {
      const target = textInput(action.target, (value) => updateAction({ target: value }), {
        placeholder: 'https://… ou C:\\…\\programme.exe',
      });
      container.append(
        field(
          'Programme, fichier ou lien',
          inline(
            target,
            button('Parcourir…', async () => {
              const picked = await api.pickFile('program');
              if (!picked) return;
              target.value = picked.path;
              updateAction({ target: picked.path });
            }),
          ),
          'Les liens spotify:, steam:// ou discord:// marchent aussi.',
        ),
      );
      break;
    }

    default:
      break;
  }
}

async function refreshScenes() {
  obsLists.scenes = await api.obsScenes();
}

async function refreshSources(scene) {
  obsLists.sources = await api.obsSources(scene);
}

// ---------- Hotkey ----------

const KEY_NAMES = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Pause: 'Pause',
  ScrollLock: 'Scrolllock',
};
const PRETTY = { Control: 'Ctrl', Shift: 'Maj', Space: 'Espace', Super: 'Win', Up: '↑', Down: '↓', Left: '←', Right: '→' };

function keyFromEvent(e) {
  let m;
  // Use the produced letter, not the physical key, so AZERTY layouts register what the user sees.
  if (/^Key[A-Z]$/.test(e.code)) return /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : e.code.slice(3);
  if ((m = e.code.match(/^Digit(\d)$/))) return m[1];
  if ((m = e.code.match(/^Numpad(\d)$/))) return `num${m[1]}`;
  if (/^F\d{1,2}$/.test(e.code)) return e.code;
  return KEY_NAMES[e.code] || null;
}

function acceleratorFromEvent(e) {
  const key = keyFromEvent(e);
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  // A lone letter would fire while typing anywhere; only function keys may stand alone.
  if (!mods.length && !/^F\d+$/.test(key)) return null;
  return [...mods, key].join('+');
}

function formatHotkey(acc) {
  return acc ? acc.split('+').map((p) => PRETTY[p] || p) : ['Aucun'];
}

function renderHotkey() {
  const parts = formatHotkey(config.hotkey);
  const nodes = [];
  parts.forEach((part, i) => {
    if (i) nodes.push(el('span', { className: 'plus', textContent: '+' }));
    nodes.push(el('kbd', { textContent: part }));
  });
  $('hotkey').replaceChildren(...nodes);
}

function setupHotkeyField() {
  const field = $('hotkey');
  let capturing = false;
  const stop = () => {
    if (!capturing) return;
    capturing = false;
    field.classList.remove('capturing');
    renderHotkey();
    api.pauseHotkey(false);
  };
  field.addEventListener('click', () => {
    if (capturing) return;
    capturing = true;
    api.pauseHotkey(true);
    field.classList.add('capturing');
    field.textContent = 'Appuie sur ta combinaison… (Échap pour annuler)';
  });
  field.addEventListener('blur', stop);
  field.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault();
    if (e.key === 'Escape') return stop();
    const acc = acceleratorFromEvent(e);
    if (!acc) return;
    config.hotkey = acc;
    stop();
    renderPreview();
    scheduleSave();
  });
}

// ---------- OBS ----------

function friendlyObsError(state) {
  if (state.authFailed) {
    return config.obs.password
      ? 'Mot de passe refusé par OBS. Recopie-le depuis « Afficher les informations de connexion » (étape 3).'
      : 'OBS demande un mot de passe : copie-le depuis « Afficher les informations de connexion » (étape 3).';
  }
  return "OBS ne répond pas. Vérifie qu'il est ouvert et que le serveur WebSocket est activé (étape 2). Nouvel essai automatique toutes les 5 secondes.";
}

function renderObsState() {
  const { status } = obsState;
  const short = { connected: 'OBS connecté', connecting: 'Connexion…', disconnected: 'OBS hors ligne' }[status];

  const pill = $('obs-pill');
  pill.className = `pill ${status}`;
  $('obs-pill-text').textContent = short;

  $('obs-big-status').className = `big-status ${status}`;
  $('obs-big-text').textContent = { connected: 'Connecté à OBS', connecting: 'Connexion en cours…', disconnected: 'Non connecté' }[status];

  const detail = $('obs-detail');
  detail.classList.remove('error');
  if (status === 'connected') {
    detail.textContent = `Scène à l'antenne : ${obsState.currentScene || '—'}`;
  } else if (status === 'disconnected' && obsState.error) {
    detail.textContent = friendlyObsError(obsState);
    detail.classList.add('error');
  } else {
    detail.textContent = 'Suis les étapes ci-dessous, puis clique sur « Se connecter ».';
  }

  renderDeckHeader($('preview-status'), obsState);
  if (config) markLiveScene();
}

// ---------- Wiring ----------

function bindStaticFields() {
  $('brand-glyph').replaceWith(createGlyph('layout-grid'));
  $('search-glyph').replaceWith(createGlyph('search'));
  $('clear-button').append(createGlyph('trash-2'));

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
  $('obs-pill').addEventListener('click', () => showView('obs'));

  document.querySelectorAll('.stepper').forEach((stepper) => {
    stepper.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => stepGrid(stepper.dataset.axis, Number(b.dataset.step))),
    );
  });

  $('label').addEventListener('input', (e) => updateButton({ label: e.target.value }));
  $('emoji').addEventListener('input', (e) => {
    const icon = e.target.value.trim();
    updateButton({ icon, symbol: icon ? '' : current().symbol });
    refreshIconSelection();
  });
  $('icon-search').addEventListener('input', renderIconGrid);

  $('image-pick').addEventListener('click', async () => {
    const picked = await api.pickFile('image');
    if (!picked) return;
    updateButton({ image: picked.path, imageUrl: picked.url });
    renderInspector();
  });
  $('image-clear').addEventListener('click', () => {
    updateButton({ image: '', imageUrl: '' });
    renderInspector();
  });

  $('clear-button').addEventListener('click', () => {
    config.buttons[selected] = emptyButton();
    renderPreview();
    renderInspector();
    scheduleSave();
  });

  $('close-after').addEventListener('change', (e) => {
    config.closeAfterAction = e.target.checked;
    scheduleSave();
  });
  $('login').addEventListener('change', (e) => {
    config.launchAtLogin = e.target.checked;
    scheduleSave();
  });

  $('obs-url').addEventListener('change', (e) => {
    config.obs.url = e.target.value.trim();
    scheduleSave();
  });
  $('obs-password').addEventListener('change', (e) => {
    config.obs.password = e.target.value;
    scheduleSave();
  });
  $('obs-connect').addEventListener('click', () => {
    config.obs.url = $('obs-url').value.trim();
    config.obs.password = $('obs-password').value;
    api.obsConnect(config.obs);
    scheduleSave();
  });

  setupHotkeyField();
}

function renderSettings() {
  renderHotkey();
  $('close-after').checked = config.closeAfterAction;
  $('login').checked = config.launchAtLogin;
  $('obs-url').value = config.obs.url;
  $('obs-password').value = config.obs.password;
}

(async () => {
  [config, obsState, icons] = await Promise.all([api.getConfig(), api.obsState(), api.listIcons()]);
  bindStaticFields();
  renderSettings();
  renderPreview();
  renderInspector();
  renderObsState();
  if (obsState.status === 'connected') refreshScenes();
  if (pendingSelect !== null) {
    select(Math.min(pendingSelect, config.buttons.length - 1));
  } else if (!config.obs.password && obsState.status !== 'connected' && config.buttons.every((b) => b.action.type === 'none')) {
    showView('obs');
  }

  api.onObsState((state) => {
    const changed = state.status !== obsState.status;
    obsState = state;
    renderObsState();
    if (changed && state.status === 'connected') refreshScenes();
    // Update the "OBS not connected" callout without stealing focus from a field being edited.
    if (changed && isObsAction(current().action.type) && !$('action-fields').contains(document.activeElement)) {
      renderActionFields();
    }
  });
})();
