// Shared test setup. Run the suite with `npm test` (Node's built-in test runner, no dependency).
const Module = require('module');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The app's main-process modules require Electron, which only exists inside the Electron runtime:
// hand them a small stand-in. Tests can swap its functions (e.g. shell.openPath) as needed.
const electron = {
  app: { getPath: () => path.join(require('os').tmpdir(), 'virtualdeck-tests') },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString(),
  },
  shell: { openExternal: async () => {}, openPath: async () => '' },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? electron : load.call(this, request, ...rest);
};

const i18n = require('../src/i18n');
i18n.setLanguage('en');

const SRC = path.join(__dirname, '..', 'src');

// Loads a renderer script (plain browser globals, no exports) and returns its top-level functions.
function loadBrowserScript(relativePath, globals = {}) {
  const context = vm.createContext({ t: i18n.t, ...globals });
  vm.runInContext(fs.readFileSync(path.join(SRC, relativePath), 'utf8'), context);
  return context;
}

// An ObsManager talking to a fake OBS. `handlers` maps request types (and, for Aitum Vertical,
// 'vendor:<requestType>') to functions returning the response; unknown requests return {}.
// `calls` records every request made, as [requestType, data].
async function connectedObs(handlers = {}) {
  const { ObsManager } = require('../src/obs');
  const obs = new ObsManager();
  const calls = [];
  const defaults = {
    GetCurrentProgramScene: () => ({ currentProgramSceneName: 'Game' }),
    GetInputList: () => ({ inputs: [] }),
    GetStreamStatus: () => ({ outputActive: false }),
    GetRecordStatus: () => ({ outputActive: false }),
  };
  obs.ws.connect = async () => {};
  obs.ws.call = async (request, data = {}) => {
    calls.push([request, data]);
    const key = request === 'CallVendorRequest' ? `vendor:${data.requestType}` : request;
    const handler = handlers[key] ?? defaults[key];
    if (handler) return handler(data);
    if (request === 'CallVendorRequest') throw new Error('No vendor');
    return {};
  };
  obs.settings = { url: 'ws://test' };
  await obs.connect();
  return { obs, calls };
}

// Fake Aitum Vertical plugin: its vendor requests, with the given vertical scenes.
function aitum({ scene = 'V-Start', scenes = ['V-Start', 'V-Game'], backtrack = true } = {}) {
  return {
    'vendor:current_scene': () => ({ responseData: { success: true, scene } }),
    'vendor:get_scenes': () => ({ responseData: { success: true, scenes: scenes.map((name) => ({ name })) } }),
    'vendor:switch_scene': () => ({ responseData: { success: true } }),
    'vendor:status': () => ({ responseData: { success: true, backtrack } }),
    'vendor:save_backtrack': () => ({ responseData: { success: true } }),
    'vendor:start_backtrack': () => ({ responseData: { success: true } }),
    // Its own stream / recording: toggle_streaming, start_recording, stop_streaming…
    ...Object.fromEntries(
      ['toggle', 'start', 'stop'].flatMap((verb) =>
        ['streaming', 'recording'].map((output) => [`vendor:${verb}_${output}`, () => ({ responseData: { success: true } })]),
      ),
    ),
  };
}

module.exports = { electron, i18n, SRC, loadBrowserScript, connectedObs, aitum };
