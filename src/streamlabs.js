const { EventEmitter } = require('events');
const { t } = require('./i18n');

const RETRY_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
// State that only makes sense while connected; reset on disconnection.
const OFFLINE_STATE = {
  mutedInputs: {},
  streamingSince: null,
  recordingSince: null,
  recordingPaused: false,
  recordingPausedAt: null,
  verticalStreamingSince: null,
  verticalRecordingSince: null,
};
// Streamlabs output states during which the stream / recording is running.
const STREAMING_STATES = ['live', 'reconnecting', 'ending'];
const RECORDING_STATES = ['recording', 'stopping'];

// Remote-control client for Streamlabs Desktop (Settings > Remote Control).
// The API is JSON-RPC 2.0 over SockJS; SockJS also serves a raw WebSocket at <prefix>/websocket,
// so Node's built-in WebSocket is enough. Same public interface as ObsManager (see obs.js).
class StreamlabsManager extends EventEmitter {
  constructor() {
    super();
    this.label = 'Streamlabs';
    this.ws = null;
    this.settings = null;
    this.retryTimer = null;
    this.generation = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.sceneSwitchedId = null;
    // Subscribed events (other than sceneSwitched): resourceId -> handler(data).
    this.eventHandlers = new Map();
    this.flashTimers = new Map();
    this.state = { status: 'disconnected', currentScene: null, ...OFFLINE_STATE, error: null, authFailed: false };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    if (this.state.status !== 'connected') this.state = { ...this.state, ...OFFLINE_STATE };
    this.emit('state', this.state);
  }

  setMuted(name, muted) {
    this.setState({ mutedInputs: { ...this.state.mutedInputs, [name]: muted } });
  }

  async subscribe(resource, event, handler) {
    const subscription = await this.request(resource, event);
    if (subscription?.resourceId) this.eventHandlers.set(subscription.resourceId, handler);
  }

  // Mute states, stream / recording status: nice to have, never a reason to refuse the connection.
  async fetchExtras() {
    try {
      await this.subscribe('StreamingService', 'streamingStatusChange', (status) => {
        const live = STREAMING_STATES.includes(status);
        this.setState({ streamingSince: live ? (this.state.streamingSince ?? Date.now()) : null });
      });
      await this.subscribe('StreamingService', 'recordingStatusChange', (status) => {
        const recording = RECORDING_STATES.includes(status);
        this.setState({ recordingSince: recording ? (this.state.recordingSince ?? Date.now()) : null });
      });
      await this.subscribe('SourcesService', 'sourceUpdated', (source) => {
        if (source?.name in this.state.mutedInputs && typeof source.muted === 'boolean') {
          this.setMuted(source.name, source.muted);
        }
      });
      const model = await this.request('StreamingService', 'getModel');
      const sources = await this.request('AudioService', 'getSources');
      const since = (active, time) => (active ? Date.parse(time) || Date.now() : null);
      return {
        mutedInputs: Object.fromEntries(sources.map((s) => [s.name, Boolean(s.muted)])),
        streamingSince: since(STREAMING_STATES.includes(model.streamingStatus), model.streamingStatusTime),
        recordingSince: since(RECORDING_STATES.includes(model.recordingStatus), model.recordingStatusTime),
      };
    } catch {
      return {};
    }
  }

  configure(settings) {
    const same =
      this.settings &&
      this.settings.url === settings.url &&
      this.settings.token === settings.token;
    this.settings = { url: settings.url, token: settings.token };
    if (same && this.state.status !== 'disconnected') return;
    this.reconnect();
  }

  stop() {
    this.generation++;
    clearTimeout(this.retryTimer);
    this.clearFlashTimers();
    this.settings = null;
    this.closeSocket();
    this.setState({ status: 'disconnected', currentScene: null, error: null, authFailed: false });
  }

  reconnect() {
    this.generation++;
    this.clearFlashTimers();
    this.closeSocket();
    this.connect();
  }

  closeSocket() {
    const ws = this.ws;
    this.ws = null;
    this.rejectPending(new Error(t('error.notConnected', { software: this.label })));
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  }

  // A pending "hide again" must not hit a later session (item ids may differ after a reconnect).
  clearFlashTimers() {
    for (const timer of this.flashTimers.values()) clearTimeout(timer);
    this.flashTimers.clear();
  }

  rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  connect() {
    clearTimeout(this.retryTimer);
    if (!this.settings?.url) {
      this.setState({ status: 'disconnected', currentScene: null, error: null });
      return;
    }
    const generation = this.generation;
    this.setState({ status: 'connecting', error: null, authFailed: false });

    let ws;
    try {
      ws = new WebSocket(this.settings.url);
    } catch (err) {
      this.setState({ status: 'disconnected', error: err.message });
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.addEventListener('message', (event) => {
      // Frames from a socket being closed must not touch the new session's state.
      if (generation === this.generation) this.handleMessage(event.data);
    });
    ws.addEventListener('open', () => {
      if (generation === this.generation) this.handshake(generation);
    });
    ws.addEventListener('close', () => {
      if (generation !== this.generation) return;
      this.ws = null;
      this.rejectPending(new Error(t('error.notConnected', { software: this.label })));
      // Wrong token: retrying cannot succeed until the user changes it.
      if (this.state.authFailed) return;
      this.setState({ status: 'disconnected', currentScene: null, error: this.state.error || 'closed' });
      this.scheduleRetry();
    });
  }

  async handshake(generation) {
    try {
      await this.request('TcpServerService', 'auth', this.settings.token || '');
    } catch (err) {
      if (generation !== this.generation) return;
      // Only a refusal from Streamlabs means a wrong token; a timeout or a dropped socket is retried.
      if (err.rpc) this.setState({ status: 'disconnected', currentScene: null, error: err.message, authFailed: true });
      else this.setState({ error: err.message });
      this.ws?.close();
      return;
    }
    try {
      this.eventHandlers.clear();
      const subscription = await this.request('ScenesService', 'sceneSwitched');
      this.sceneSwitchedId = subscription?.resourceId ?? null;
      const activeId = await this.request('ScenesService', 'activeSceneId');
      const scenes = await this.request('ScenesService', 'getScenes');
      const extras = await this.fetchExtras();
      if (generation !== this.generation) return;
      this.setState({
        status: 'connected',
        currentScene: scenes.find((s) => s.id === activeId)?.name ?? null,
        ...extras,
        error: null,
      });
    } catch (err) {
      if (generation !== this.generation) return;
      this.setState({ error: err.message });
      this.ws?.close();
    }
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), RETRY_MS);
  }

  handleMessage(raw) {
    // The server terminates every JSON message with a newline; a frame may hold several.
    for (const line of String(raw).split('\n')) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const result = message.result;
      if (result?._type === 'EVENT') {
        if (result.resourceId === this.sceneSwitchedId && result.data?.name) {
          this.setState({ currentScene: result.data.name });
        } else {
          this.eventHandlers.get(result.resourceId)?.(result.data);
        }
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(Object.assign(new Error(message.error.message || 'Streamlabs error'), { rpc: true }));
      }
      else pending.resolve(result);
    }
  }

  request(resource, method, ...args) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(t('error.notConnected', { software: this.label })));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(t('error.timeout', { software: this.label })));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: { resource, args } }));
    });
  }

  ensureConnected() {
    if (this.state.status !== 'connected') {
      throw new Error(t('error.notConnected', { software: this.label }));
    }
  }

  async findScene(sceneName) {
    const scenes = await this.request('ScenesService', 'getScenes');
    const name = sceneName || this.state.currentScene;
    const scene = scenes.find((s) => s.name === name);
    if (!scene) throw new Error(t('error.sceneNotFound', { name, software: this.label }));
    return scene;
  }

  async sceneItems(scene) {
    const items = await this.request(scene.resourceId, 'getItems');
    return items.filter((item) => item.resourceId);
  }

  async getScenes() {
    if (this.state.status !== 'connected') return [];
    const scenes = await this.request('ScenesService', 'getScenes');
    return scenes.map((s) => s.name);
  }

  // Vertical scenes come from the Aitum Vertical plugin for OBS: Streamlabs has none to offer.
  async getVerticalScenes() {
    return [];
  }

  verticalUnavailableMessage() {
    return t('error.verticalUnsupported');
  }

  async checkVerticalScene() {
    throw new Error(t('error.verticalUnsupported'));
  }

  async setVerticalScene() {
    throw new Error(t('error.verticalUnsupported'));
  }

  async getSources(sceneName, { vertical = false } = {}) {
    if (this.state.status !== 'connected' || vertical) return [];
    const scene = await this.findScene(sceneName);
    return (await this.sceneItems(scene)).map((item) => item.name);
  }

  async setScene(sceneName) {
    this.ensureConnected();
    const generation = this.generation;
    const scene = await this.findScene(sceneName);
    await this.request('ScenesService', 'makeSceneActive', scene.id);
    // Show the new scene as live without waiting for the end of the transition.
    if (generation === this.generation && this.state.status === 'connected') this.setState({ currentScene: scene.name });
  }

  async getAudioInputs() {
    if (this.state.status !== 'connected') return [];
    const sources = await this.request('AudioService', 'getSources');
    return sources.map((s) => s.name);
  }

  // mode: 'toggle' | 'mute' | 'unmute'.
  async setInputMute(name, mode) {
    this.ensureConnected();
    const sources = await this.request('AudioService', 'getSources');
    const source = sources.find((s) => s.name === name);
    if (!source) throw new Error(t('error.inputNotFound', { name, software: this.label }));
    const muted = mode === 'toggle' ? !source.muted : mode === 'mute';
    await this.request(source.resourceId, 'setMuted', muted);
    this.setMuted(name, muted);
  }

  async saveReplay({ vertical }) {
    if (vertical) throw new Error(t('error.verticalUnsupported'));
    this.ensureConnected();
    const model = await this.request('StreamingService', 'getModel');
    if (model.replayBufferStatus !== 'running') {
      throw new Error(t('error.replayNotStarted', { software: this.label }));
    }
    await this.request('StreamingService', 'saveReplay');
  }

  // Same interface as ObsManager; Streamlabs has no vertical canvas.
  async toggleRecord({ vertical } = {}) {
    if (vertical) throw new Error(t('error.verticalUnsupported'));
    this.ensureConnected();
    await this.request('StreamingService', 'toggleRecording');
  }

  async toggleStream({ vertical } = {}) {
    if (vertical) throw new Error(t('error.verticalUnsupported'));
    this.ensureConnected();
    await this.request('StreamingService', 'toggleStreaming');
  }

  // mode: 'toggle' | 'show' | 'hide' | 'flash' (show, then hide again after durationMs).
  // Same interface as ObsManager.setSourcesVisibility; Streamlabs has no vertical canvas.
  async setSourcesVisibility(targets, mode, durationMs = 0) {
    if (targets.some((target) => target.vertical)) throw new Error(t('error.verticalUnsupported'));
    const [{ sceneName, sourceName }] = targets;
    await this.setSourceVisibility(sceneName, sourceName, mode, durationMs);
  }

  async setSourceVisibility(sceneName, sourceName, mode, durationMs = 0) {
    this.ensureConnected();
    const scene = await this.findScene(sceneName);
    const item = (await this.sceneItems(scene)).find((i) => i.name === sourceName);
    if (!item) throw new Error(t('error.sourceNotFound', { name: sourceName, scene: scene.name }));
    const setVisible = (visible) => this.request(item.resourceId, 'setVisibility', visible);

    if (mode === 'flash') {
      // Hide first so a media source restarts even if it was left visible.
      await setVisible(false);
      await setVisible(true);
      clearTimeout(this.flashTimers.get(item.resourceId));
      this.flashTimers.set(
        item.resourceId,
        setTimeout(() => {
          this.flashTimers.delete(item.resourceId);
          setVisible(false).catch(() => {});
        }, durationMs),
      );
      return;
    }
    await setVisible(mode === 'toggle' ? !item.visible : mode === 'show');
  }
}

module.exports = { StreamlabsManager };
