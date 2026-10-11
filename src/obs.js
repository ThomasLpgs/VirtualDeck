const { EventEmitter } = require('events');
const { OBSWebSocket } = require('obs-websocket-js');
const { t } = require('./i18n');

const RETRY_MS = 5000;
// obs-websocket close code for a missing or wrong password: retrying cannot succeed until settings change.
const AUTH_FAILED = 4009;
// obs-websocket vendor name of the Aitum Vertical plugin (second, vertical canvas for TikTok & co).
const VERTICAL_VENDOR = 'aitum-vertical-canvas';

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
    this.ws.on('VendorEvent', ({ vendorName, eventType, eventData }) => {
      if (vendorName === VERTICAL_VENDOR && eventType === 'switch_scene' && eventData?.new_scene) {
        this.setState({ verticalScene: eventData.new_scene });
      }
    });
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    if (this.state.status !== 'connected') this.state = { ...this.state, verticalScene: null, verticalAvailable: false };
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
      if (generation !== this.generation) return;
      this.setState({
        status: 'connected',
        currentScene: currentProgramSceneName,
        verticalScene,
        verticalAvailable: verticalScene !== null,
        error: null,
      });
    } catch (err) {
      if (generation !== this.generation) return;
      const authFailed = err.code === AUTH_FAILED;
      this.setState({ status: 'disconnected', currentScene: null, error: err.message, authFailed });
      if (!authFailed) this.scheduleRetry();
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

  async toggleRecord() {
    await this.call('ToggleRecord');
  }

  async toggleStream() {
    await this.call('ToggleStream');
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
