const { EventEmitter } = require('events');
const { OBSWebSocket } = require('obs-websocket-js');
const { t } = require('./i18n');

const RETRY_MS = 5000;
// obs-websocket close code for a missing or wrong password: retrying cannot succeed until settings change.
const AUTH_FAILED = 4009;

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
    this.state = { status: 'disconnected', currentScene: null, error: null, authFailed: false };

    this.ws.on('ConnectionClosed', () => {
      // Closures during connect/reconnect are handled by connect() itself.
      if (this.state.status !== 'connected') return;
      this.setState({ status: 'disconnected', currentScene: null });
      this.scheduleRetry();
    });
    this.ws.on('CurrentProgramSceneChanged', ({ sceneName }) => {
      this.setState({ currentScene: sceneName });
    });
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
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
      if (generation !== this.generation) return;
      this.setState({ status: 'connected', currentScene: currentProgramSceneName, error: null });
    } catch (err) {
      if (generation !== this.generation) return;
      const authFailed = err.code === AUTH_FAILED;
      this.setState({ status: 'disconnected', currentScene: null, error: err.message, authFailed });
      if (!authFailed) this.scheduleRetry();
    }
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

  async getSources(sceneName) {
    if (this.state.status !== 'connected') return [];
    const scene = sceneName || this.state.currentScene;
    if (!scene) return [];
    const { sceneItems } = await this.ws.call('GetSceneItemList', { sceneName: scene });
    return sceneItems.map((i) => i.sourceName).reverse();
  }

  async setScene(sceneName) {
    await this.call('SetCurrentProgramScene', { sceneName });
  }

  async toggleRecord() {
    await this.call('ToggleRecord');
  }

  async toggleStream() {
    await this.call('ToggleStream');
  }

  // mode: 'toggle' | 'show' | 'hide' | 'flash' (show, then hide again after durationMs).
  async setSourceVisibility(sceneName, sourceName, mode, durationMs = 0) {
    const scene = sceneName || this.state.currentScene;
    const { sceneItemId } = await this.call('GetSceneItemId', { sceneName: scene, sourceName });
    const setEnabled = (sceneItemEnabled) =>
      this.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId, sceneItemEnabled });

    if (mode === 'flash') {
      // Hide first so a media source restarts even if it was left visible.
      await setEnabled(false);
      await setEnabled(true);
      clearTimeout(this.flashTimers.get(sceneItemId));
      this.flashTimers.set(
        sceneItemId,
        setTimeout(() => {
          this.flashTimers.delete(sceneItemId);
          Promise.resolve()
            .then(() => setEnabled(false))
            .catch(() => {});
        }, durationMs),
      );
      return;
    }
    let enabled = mode === 'show';
    if (mode === 'toggle') {
      const { sceneItemEnabled } = await this.call('GetSceneItemEnabled', { sceneName: scene, sceneItemId });
      enabled = !sceneItemEnabled;
    }
    await setEnabled(enabled);
  }
}

module.exports = { ObsManager };
