const { EventEmitter } = require('events');
const { OBSWebSocket } = require('obs-websocket-js');
const { t } = require('./i18n');

const RETRY_MS = 5000;
// obs-websocket close code for a missing or wrong password: retrying cannot succeed until settings change.
const AUTH_FAILED = 4009;
// obs-websocket vendor name of the Aitum Vertical plugin (second, vertical canvas for TikTok & co).
const VERTICAL_VENDOR = 'aitum-vertical-canvas';
// State that only makes sense while connected; reset on disconnection.
const OFFLINE_STATE = {
  verticalScene: null,
  verticalAvailable: false,
  mutedInputs: {},
  streamingSince: null,
  recordingSince: null,
  recordingPaused: false,
  recordingPausedAt: null,
  verticalStreamingSince: null,
  verticalRecordingSince: null,
};

// When an output (stream / recording) started, as a timestamp, from its obs-websocket status.
const outputSince = (status) => (status.outputActive ? Date.now() - (status.outputDuration || 0) : null);
// While paused, recordingPausedAt freezes the elapsed time shown on the key.
const recordState = (status) => {
  const paused = Boolean(status.outputActive && status.outputPaused);
  return { recordingSince: outputSince(status), recordingPaused: paused, recordingPausedAt: paused ? Date.now() : null };
};
// obs-websocket output states. Its "outputActive" flag is false while paused or reconnecting,
// so the state itself tells a real start or stop apart.
const OUTPUT_STARTED = 'OBS_WEBSOCKET_OUTPUT_STARTED';
const OUTPUT_STOPPED = 'OBS_WEBSOCKET_OUTPUT_STOPPED';
const OUTPUT_PAUSED = 'OBS_WEBSOCKET_OUTPUT_PAUSED';
const OUTPUT_RESUMED = 'OBS_WEBSOCKET_OUTPUT_RESUMED';

// Keeps a single connection to OBS Studio alive, reconnecting in the background
// so the deck works whether OBS is started before or after the app.
// Shares its public interface with StreamlabsManager (see streamlabs.js).
class ObsManager extends EventEmitter {
  constructor() {
    super();
    this.label = 'OBS';
    this.ws = new OBSWebSocket();
    this.settings = null;
    this.retryTimer = null;
    // Bumped by stop()/reconnect() so a connection attempt still in flight is ignored.
    this.generation = 0;
    this.flashTimers = new Map();
    this.state = {
      status: 'disconnected',
      currentScene: null,
      // Live scene of the Aitum Vertical canvas; verticalAvailable is false when the plugin is missing.
      verticalScene: null,
      verticalAvailable: false,
      // Audio inputs by name, and whether each one is muted.
      mutedInputs: {},
      // When the stream / recording started (timestamps), null when off.
      streamingSince: null,
      recordingSince: null,
      recordingPaused: false,
      recordingPausedAt: null,
      // Same for Aitum Vertical's own stream / recording.
      verticalStreamingSince: null,
      verticalRecordingSince: null,
      error: null,
      authFailed: false,
    };

    this.ws.on('ConnectionClosed', () => {
      // Closures during connect/reconnect are handled by connect() itself.
      if (this.state.status !== 'connected') return;
      this.setState({ status: 'disconnected', currentScene: null });
      this.scheduleRetry();
    });
    this.ws.on('CurrentProgramSceneChanged', ({ sceneName }) => {
      this.setState({ currentScene: sceneName });
    });
    this.ws.on('InputMuteStateChanged', ({ inputName, inputMuted }) => this.setMuted(inputName, inputMuted));
    this.ws.on('InputCreated', ({ inputName }) => {
      this.ws
        .call('GetInputMute', { inputName })
        .then(({ inputMuted }) => this.setMuted(inputName, inputMuted))
        .catch(() => {}); // Not an audio input.
    });
    this.ws.on('InputRemoved', ({ inputName }) => {
      const { [inputName]: _removed, ...rest } = this.state.mutedInputs;
      this.setState({ mutedInputs: rest });
    });
    this.ws.on('InputNameChanged', ({ oldInputName, inputName }) => {
      if (!(oldInputName in this.state.mutedInputs)) return;
      const { [oldInputName]: muted, ...rest } = this.state.mutedInputs;
      this.setState({ mutedInputs: { ...rest, [inputName]: muted } });
    });
    this.ws.on('StreamStateChanged', ({ outputState }) => {
      // Reconnecting keeps the timer running: only a real start or stop changes it.
      if (outputState === OUTPUT_STOPPED) this.setState({ streamingSince: null });
      else if (outputState === OUTPUT_STARTED) this.setState({ streamingSince: this.state.streamingSince ?? Date.now() });
    });
    // Timed here, like OBS's own status bar: the duration obs-websocket reports counts encoded
    // frames, which lag a second or more behind, so reading it after a pause would shift the timer.
    this.ws.on('RecordStateChanged', ({ outputState }) => {
      const now = Date.now();
      const { recordingSince, recordingPausedAt } = this.state;
      if (outputState === OUTPUT_STOPPED) {
        this.setState({ recordingSince: null, recordingPaused: false, recordingPausedAt: null });
      } else if (outputState === OUTPUT_STARTED) {
        this.setState({ recordingSince: now, recordingPaused: false, recordingPausedAt: null });
      } else if (outputState === OUTPUT_PAUSED && recordingSince) {
        this.setState({ recordingPaused: true, recordingPausedAt: now });
      } else if (outputState === OUTPUT_RESUMED && recordingSince) {
        // The pause doesn't count: move the start forward by its length.
        const pausedFor = recordingPausedAt ? now - recordingPausedAt : 0;
        this.setState({ recordingSince: recordingSince + pausedFor, recordingPaused: false, recordingPausedAt: null });
      }
    });
    this.ws.on('VendorEvent', ({ vendorName, eventType, eventData }) => {
      if (vendorName !== VERTICAL_VENDOR) return;
      if (eventType === 'switch_scene' && eventData?.new_scene) this.setState({ verticalScene: eventData.new_scene });
      else if (eventType === 'streaming_started') this.setState({ verticalStreamingSince: Date.now() });
      else if (eventType === 'streaming_stopped') this.setState({ verticalStreamingSince: null });
      else if (eventType === 'recording_started') this.setState({ verticalRecordingSince: Date.now() });
      else if (eventType === 'recording_stopped') this.setState({ verticalRecordingSince: null });
    });
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    if (this.state.status !== 'connected') this.state = { ...this.state, ...OFFLINE_STATE };
    this.emit('state', this.state);
  }

  setMuted(inputName, muted) {
    this.setState({ mutedInputs: { ...this.state.mutedInputs, [inputName]: muted } });
  }

  configure(settings) {
    const same =
      this.settings &&
      this.settings.url === settings.url &&
      this.settings.password === settings.password;
    this.settings = { url: settings.url, password: settings.password };
    if (same && this.state.status !== 'disconnected') return;
    this.reconnect();
  }

  // Disconnects and stays idle until configure()/reconnect() is called again.
  async stop() {
    this.generation++;
    clearTimeout(this.retryTimer);
    this.clearFlashTimers();
    this.settings = null;
    this.setState({ status: 'disconnected', currentScene: null, error: null, authFailed: false });
    try {
      await this.ws.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  async reconnect() {
    const generation = ++this.generation;
    clearTimeout(this.retryTimer);
    this.clearFlashTimers();
    this.setState({ status: 'connecting', error: null });
    try {
      await this.ws.disconnect();
    } catch {
      // Already disconnected.
    }
    if (generation === this.generation) this.connect();
  }

  async connect() {
    clearTimeout(this.retryTimer);
    if (!this.settings?.url) {
      this.setState({ status: 'disconnected', currentScene: null, error: null });
      return;
    }
    const generation = this.generation;
    this.setState({ status: 'connecting', error: null, authFailed: false });
    try {
      await this.ws.connect(this.settings.url, this.settings.password || undefined);
      const { currentProgramSceneName } = await this.ws.call('GetCurrentProgramScene');
      const verticalScene = await this.fetchVerticalScene();
      const [mutedInputs, streamStatus, recordStatus, verticalStatus] = await Promise.all([
        this.fetchMutedInputs(),
        this.ws.call('GetStreamStatus'),
        this.ws.call('GetRecordStatus'),
        this.fetchVerticalStatus(verticalScene !== null),
      ]);
      if (generation !== this.generation) return;
      this.setState({
        status: 'connected',
        currentScene: currentProgramSceneName,
        verticalScene,
        verticalAvailable: verticalScene !== null,
        mutedInputs,
        streamingSince: outputSince(streamStatus),
        ...recordState(recordStatus),
        // Aitum doesn't tell how long it has been running: the timer starts at connection.
        verticalStreamingSince: verticalStatus.streaming ? Date.now() : null,
        verticalRecordingSince: verticalStatus.recording ? Date.now() : null,
        error: null,
      });
    } catch (err) {
      if (generation !== this.generation) return;
      const authFailed = err.code === AUTH_FAILED;
      this.setState({ status: 'disconnected', currentScene: null, error: err.message, authFailed });
      if (!authFailed) this.scheduleRetry();
    }
  }

  // Audio inputs (the ones OBS can mute) with their mute state, in OBS order.
  async fetchMutedInputs() {
    const { inputs } = await this.ws.call('GetInputList');
    const results = await Promise.allSettled(
      inputs.map(({ inputName }) => this.ws.call('GetInputMute', { inputName })),
    );
    const muted = {};
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') muted[inputs[i].inputName] = result.value.inputMuted;
    });
    return muted;
  }

  // Aitum Vertical's stream / recording / Backtrack status ({} without the plugin).
  async fetchVerticalStatus(available) {
    if (!available) return {};
    try {
      const { responseData } = await this.ws.call('CallVendorRequest', { vendorName: VERTICAL_VENDOR, requestType: 'status' });
      return responseData ?? {};
    } catch {
      return {};
    }
  }

  // Name of the live vertical scene ('' if none), or null when Aitum Vertical is not installed.
  async fetchVerticalScene() {
    try {
      const { responseData } = await this.ws.call('CallVendorRequest', {
        vendorName: VERTICAL_VENDOR,
        requestType: 'current_scene',
      });
      return responseData?.success ? responseData.scene || '' : null;
    } catch {
      return null;
    }
  }

  // Why the vertical part of a key can't run right now.
  verticalUnavailableMessage() {
    return t('error.verticalMissing');
  }

  async verticalRequest(requestType, requestData) {
    if (this.state.status === 'connected' && !this.state.verticalAvailable) throw new Error(t('error.verticalMissing'));
    const { responseData } = await this.call('CallVendorRequest', { vendorName: VERTICAL_VENDOR, requestType, requestData });
    if (!responseData?.success) throw new Error(responseData?.error || t('error.verticalMissing'));
    return responseData;
  }

  // A pending "hide again" must not hit a later session (item ids may differ after a reconnect).
  clearFlashTimers() {
    for (const timer of this.flashTimers.values()) clearTimeout(timer);
    this.flashTimers.clear();
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), RETRY_MS);
  }

  call(request, data) {
    if (this.state.status !== 'connected') {
      throw new Error(t('error.notConnected', { software: this.label }));
    }
    return this.ws.call(request, data);
  }

  async getScenes() {
    if (this.state.status !== 'connected') return [];
    const { scenes } = await this.ws.call('GetSceneList');
    // OBS lists scenes bottom-up; reverse to match the order shown in OBS.
    return scenes.map((s) => s.sceneName).reverse();
  }

  async getVerticalScenes() {
    if (!this.state.verticalAvailable) return [];
    const { scenes } = await this.verticalRequest('get_scenes');
    return (scenes || []).map((s) => s.name);
  }

  // Vertical scenes live in Aitum's own canvas, reachable through obs-websocket since OBS 32.
  // Returns the UUID of the canvas holding sceneName.
  async findVerticalCanvas(sceneName) {
    if (this.state.status !== 'connected') throw new Error(t('error.notConnected', { software: this.label }));
    if (!this.state.verticalAvailable) throw new Error(t('error.verticalMissing'));
    let canvases;
    try {
      ({ canvases } = await this.call('GetCanvasList'));
    } catch {
      throw new Error(t('error.verticalSourcesObs32'));
    }
    // Aitum's canvas first, in case another canvas has a scene with the same name.
    const isAitum = (c) => Number(String(c.canvasName).startsWith('Aitum'));
    for (const canvas of [...canvases].sort((a, b) => isAitum(b) - isAitum(a))) {
      const { scenes } = await this.call('GetSceneList', { canvasUuid: canvas.canvasUuid }).catch(() => ({ scenes: [] }));
      if (scenes.some((s) => s.sceneName === sceneName)) return canvas.canvasUuid;
    }
    throw new Error(t('error.sceneNotFound', { name: sceneName, software: 'Aitum Vertical' }));
  }

  // Request fields addressing a scene. An empty name means the scene currently on air.
  async sceneRef(sceneName, vertical) {
    if (!vertical) return { sceneName: sceneName || this.state.currentScene };
    const scene = sceneName || this.state.verticalScene;
    return { sceneName: scene, canvasUuid: await this.findVerticalCanvas(scene) };
  }

  async getSources(sceneName, { vertical = false } = {}) {
    if (this.state.status !== 'connected') return [];
    const ref = await this.sceneRef(sceneName, vertical);
    if (!ref.sceneName) return [];
    const { sceneItems } = await this.ws.call('GetSceneItemList', ref);
    return sceneItems.map((i) => i.sourceName).reverse();
  }

  async setScene(sceneName) {
    const generation = this.generation;
    await this.call('SetCurrentProgramScene', { sceneName });
    // OBS only sends CurrentProgramSceneChanged once the transition has finished:
    // show the new scene as live as soon as OBS has accepted the switch.
    if (generation === this.generation && this.state.status === 'connected') this.setState({ currentScene: sceneName });
  }

  // Throws when the vertical scene can't be switched to. The plugin answers "success" even for
  // an unknown name, so this is what reports a typo.
  async checkVerticalScene(sceneName) {
    if (this.state.status !== 'connected') throw new Error(t('error.notConnected', { software: this.label }));
    if (!this.state.verticalAvailable) throw new Error(t('error.verticalMissing'));
    if (!(await this.getVerticalScenes()).includes(sceneName)) {
      throw new Error(t('error.sceneNotFound', { name: sceneName, software: 'Aitum Vertical' }));
    }
  }

  async setVerticalScene(sceneName) {
    const generation = this.generation;
    await this.verticalRequest('switch_scene', { scene: sceneName });
    if (generation === this.generation && this.state.status === 'connected') this.setState({ verticalScene: sceneName });
  }

  async getAudioInputs() {
    return Object.keys(this.state.mutedInputs);
  }

  // mode: 'toggle' | 'mute' | 'unmute'.
  async setInputMute(inputName, mode) {
    if (this.state.status !== 'connected') throw new Error(t('error.notConnected', { software: this.label }));
    if (!(inputName in this.state.mutedInputs)) {
      throw new Error(t('error.inputNotFound', { name: inputName, software: this.label }));
    }
    let inputMuted;
    if (mode === 'toggle') {
      ({ inputMuted } = await this.call('ToggleInputMute', { inputName }));
    } else {
      inputMuted = mode === 'mute';
      await this.call('SetInputMute', { inputName, inputMuted });
    }
    this.setMuted(inputName, inputMuted);
  }

  // Saves a clip from the replay buffer (horizontal) and/or Aitum Vertical's Backtrack (vertical).
  // Both buffers are checked first, so a clip is never saved on one canvas only.
  async saveReplay({ horizontal, vertical }) {
    if (this.state.status !== 'connected') throw new Error(t('error.notConnected', { software: this.label }));
    if (horizontal) {
      // OBS answers with an error when the replay buffer isn't enabled in its settings.
      const status = await this.call('GetReplayBufferStatus').catch(() => null);
      if (!status) throw new Error(t('error.replayDisabled', { software: this.label }));
      if (!status.outputActive) throw new Error(t('error.replayNotStarted', { software: this.label }));
    }
    if (vertical) {
      const { backtrack } = await this.verticalRequest('status');
      if (!backtrack) throw new Error(t('error.verticalReplayNotStarted'));
    }
    await Promise.all([
      horizontal && this.call('SaveReplayBuffer'),
      vertical && this.verticalRequest('save_backtrack'),
    ]);
  }

  // Starts or stops an output on the horizontal canvas (OBS) and/or the vertical one (Aitum).
  // With both, the horizontal output decides, so the two never end up one on and one off.
  async toggleOutput({ horizontal, vertical }, { status, start, stop, toggle, verticalKey, verticalVerb }) {
    if (!vertical) return this.call(toggle);
    if (!horizontal) return this.verticalRequest(`toggle_${verticalVerb}`);
    const [{ outputActive }, verticalStatus] = await Promise.all([this.call(status), this.verticalRequest('status')]);
    const verticalActive = Boolean(verticalStatus[verticalKey]);
    await Promise.all(
      outputActive
        ? [this.call(stop), verticalActive && this.verticalRequest(`stop_${verticalVerb}`)]
        : [this.call(start), !verticalActive && this.verticalRequest(`start_${verticalVerb}`)],
    );
  }

  async toggleRecord(targets = { horizontal: true, vertical: false }) {
    await this.toggleOutput(targets, {
      status: 'GetRecordStatus',
      start: 'StartRecord',
      stop: 'StopRecord',
      toggle: 'ToggleRecord',
      verticalKey: 'recording',
      verticalVerb: 'recording',
    });
  }

  async toggleStream(targets = { horizontal: true, vertical: false }) {
    await this.toggleOutput(targets, {
      status: 'GetStreamStatus',
      start: 'StartStream',
      stop: 'StopStream',
      toggle: 'ToggleStream',
      verticalKey: 'streaming',
      verticalVerb: 'streaming',
    });
  }

  // mode: 'toggle' | 'show' | 'hide' | 'flash' (show, then hide again after durationMs).
  // targets: [{ sceneName, sourceName, vertical }], vertical meaning an Aitum Vertical scene (OBS 32+).
  // mode: 'toggle' | 'show' | 'hide' | 'flash' (show, then hide again after durationMs).
  // Every item is looked up before anything changes, so a typo never animates one canvas alone.
  async setSourcesVisibility(targets, mode, durationMs = 0) {
    if (this.state.status !== 'connected') throw new Error(t('error.notConnected', { software: this.label }));
    const items = [];
    for (const { sceneName, sourceName, vertical } of targets) {
      const ref = await this.sceneRef(sceneName, vertical);
      const { sceneItemId } = await this.call('GetSceneItemId', { ...ref, sourceName });
      items.push({ ref, sceneItemId });
    }
    const setEnabled = ({ ref, sceneItemId }, sceneItemEnabled) =>
      this.call('SetSceneItemEnabled', { ...ref, sceneItemId, sceneItemEnabled });

    if (mode === 'flash') {
      // Hide first so a media source restarts even if it was left visible.
      await Promise.all(
        items.map(async (item) => {
          await setEnabled(item, false);
          await setEnabled(item, true);
        }),
      );
      for (const item of items) {
        // Scene item ids are only unique within a scene (and scene names within a canvas).
        const timerKey = `${item.ref.canvasUuid || ''}\n${item.ref.sceneName}\n${item.sceneItemId}`;
        clearTimeout(this.flashTimers.get(timerKey));
        this.flashTimers.set(
          timerKey,
          setTimeout(() => {
            this.flashTimers.delete(timerKey);
            Promise.resolve()
              .then(() => setEnabled(item, false))
              .catch(() => {});
          }, durationMs),
        );
      }
      return;
    }
    let enabled = mode === 'show';
    if (mode === 'toggle') {
      // The first source decides, so both canvases end up in the same state.
      const { sceneItemEnabled } = await this.call('GetSceneItemEnabled', { ...items[0].ref, sceneItemId: items[0].sceneItemId });
      enabled = !sceneItemEnabled;
    }
    await Promise.all(items.map((item) => setEnabled(item, enabled)));
  }
}

module.exports = { ObsManager };
