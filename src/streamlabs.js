const { EventEmitter } = require('events');
const { t } = require('./i18n');

const RETRY_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;

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
    this.flashTimers = new Map();
    this.state = { status: 'disconnected', currentScene: null, error: null, authFailed: false };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
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
    this.settings = null;
    this.closeSocket();
    this.setState({ status: 'disconnected', currentScene: null, error: null, authFailed: false });
  }

  reconnect() {
    this.generation++;
    this.closeSocket();
    this.connect();
  }

  closeSocket() {
    const ws = this.ws;
    this.ws = null;
    this.rejectPending(new Error(t('error.notConnected', { software: this.label })));
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
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

    ws.addEventListener('message', (event) => this.handleMessage(event.data));
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
      this.setState({ status: 'disconnected', currentScene: null, error: err.message, authFailed: true });
      this.ws?.close();
      return;
    }
    try {
      const subscription = await this.request('ScenesService', 'sceneSwitched');
      this.sceneSwitchedId = subscription?.resourceId ?? null;
      const activeId = await this.request('ScenesService', 'activeSceneId');
      const scenes = await this.request('ScenesService', 'getScenes');
      if (generation !== this.generation) return;
      this.setState({
        status: 'connected',
        currentScene: scenes.find((s) => s.id === activeId)?.name ?? null,
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
        }
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'Streamlabs error'));
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

  async getSources(sceneName) {
    if (this.state.status !== 'connected') return [];
    const scene = await this.findScene(sceneName);
    return (await this.sceneItems(scene)).map((item) => item.name);
  }

  async setScene(sceneName) {
    this.ensureConnected();
    const scene = await this.findScene(sceneName);
    await this.request('ScenesService', 'makeSceneActive', scene.id);
  }

  async toggleRecord() {
    this.ensureConnected();
    await this.request('StreamingService', 'toggleRecording');
  }

  async toggleStream() {
    this.ensureConnected();
    await this.request('StreamingService', 'toggleStreaming');
  }

  // mode: 'toggle' | 'show' | 'hide' | 'flash' (show, then hide again after durationMs).
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
