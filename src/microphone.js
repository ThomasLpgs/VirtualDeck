// The PC's microphones, muted for every app at once (Discord, OBS, games…), like the mute switch of
// Windows' sound settings. Talks to Windows' audio (Core Audio, through koffi) only when a key
// asks: nothing runs in the background.

// Windows' audio, through its COM interfaces. Loaded once, on first use.
let coreAudio = null;
function loadCoreAudio() {
  if (coreAudio) return coreAudio;
  const koffi = require('koffi');
  const GUID = koffi.struct('VD_GUID', { data1: 'uint32', data2: 'uint16', data3: 'uint16', data4: koffi.array('uint8', 8) });
  const guid = (text) => {
    const hex = text.replace(/-/g, '');
    return {
      data1: parseInt(hex.slice(0, 8), 16),
      data2: parseInt(hex.slice(8, 12), 16),
      data3: parseInt(hex.slice(12, 16), 16),
      data4: [...Buffer.from(hex.slice(16), 'hex')],
    };
  };
  const CLSID_MMDeviceEnumerator = guid('BCDE0395-E52F-467C-8E3D-C4579291692E');
  const IID_IMMDeviceEnumerator = guid('A95664D2-9614-4F35-A746-DE8DB63617E6');
  const IID_IAudioEndpointVolume = guid('5CDF2C82-841E-4546-9722-0CF74078229A');
  const CLSCTX_ALL = 0x17;
  const E_CAPTURE = 1;
  const DEVICE_STATE_ACTIVE = 1;

  const failed = (result) => new Error(`Windows audio error 0x${(result >>> 0).toString(16)}`);
  const ole32 = koffi.load('ole32.dll');
  const CoInitializeEx = ole32.func('int32 __stdcall CoInitializeEx(void *, uint32)');
  const CoCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', [
    koffi.pointer(GUID),
    'void *',
    'uint32',
    koffi.pointer(GUID),
    koffi.out(koffi.pointer('void *')),
  ]);
  // Methods by their place in each interface (see Windows' mmdeviceapi.h and endpointvolume.h).
  const METHODS = {
    release: [2, koffi.proto('uint32 __stdcall VD_Release(void *)')],
    enumEndpoints: [3, koffi.proto('int32 __stdcall VD_EnumAudioEndpoints(void *, int32, uint32, _Out_ void **)')],
    count: [3, koffi.proto('int32 __stdcall VD_GetCount(void *, _Out_ uint32 *)')],
    item: [4, koffi.proto('int32 __stdcall VD_Item(void *, uint32, _Out_ void **)')],
    activate: [3, koffi.proto('int32 __stdcall VD_Activate(void *, VD_GUID *, uint32, void *, _Out_ void **)')],
    setMute: [14, koffi.proto('int32 __stdcall VD_SetMute(void *, int32, void *)')],
    getMute: [15, koffi.proto('int32 __stdcall VD_GetMute(void *, _Out_ int32 *)')],
  };
  const POINTER = koffi.sizeof('void *');
  const call = (object, name, ...args) => {
    const [index, proto] = METHODS[name];
    const fn = koffi.decode(koffi.decode(object, 'void *'), index * POINTER, 'void *');
    const result = koffi.call(fn, proto, object, ...args);
    if (name !== 'release' && result < 0) throw failed(result);
    return result;
  };
  const created = (fill) => {
    const out = [null];
    fill(out);
    return out[0];
  };

  // Already set up by Electron on its main thread: this only makes sure, whatever it returns.
  CoInitializeEx(null, 2);
  coreAudio = {
    // Runs fn on the volume control of each active microphone, then lets go of them all.
    eachMicrophone(fn) {
      const held = [];
      try {
        const enumerator = created((out) => {
          const result = CoCreateInstance(CLSID_MMDeviceEnumerator, null, CLSCTX_ALL, IID_IMMDeviceEnumerator, out);
          if (result < 0) throw failed(result);
        });
        held.push(enumerator);
        const devices = created((out) => call(enumerator, 'enumEndpoints', E_CAPTURE, DEVICE_STATE_ACTIVE, out));
        held.push(devices);
        const count = [0];
        call(devices, 'count', count);
        const results = [];
        for (let i = 0; i < count[0]; i++) {
          const device = created((out) => call(devices, 'item', i, out));
          held.push(device);
          const volume = created((out) => call(device, 'activate', IID_IAudioEndpointVolume, CLSCTX_ALL, null, out));
          held.push(volume);
          results.push(
            fn({
              muted: () => {
                const muted = [0];
                call(volume, 'getMute', muted);
                return muted[0] !== 0;
              },
              setMuted: (muted) => call(volume, 'setMute', muted ? 1 : 0, null),
            }),
          );
        }
        return results;
      } finally {
        for (const object of held.reverse()) if (object) call(object, 'release');
      }
    },
  };
  return coreAudio;
}

class MicrophoneError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const MODES = ['toggle', 'mute', 'unmute'];

// system: Windows' audio (loadCoreAudio by default, a fake in the tests).
function createMicrophone({ system = loadCoreAudio } = {}) {
  return {
    // true when every microphone is muted, false when one can hear, null without a microphone.
    isMuted() {
      const states = system().eachMicrophone((mic) => mic.muted());
      return states.length ? states.every(Boolean) : null;
    },

    // Mutes or unmutes every microphone. Toggle mutes them all as long as one can still hear.
    // Returns whether they are muted now.
    set(mode = 'toggle') {
      const states = system().eachMicrophone((mic) => mic.muted());
      if (!states.length) throw new MicrophoneError('noMic');
      const muted = mode === 'mute' || (mode !== 'unmute' && !states.every(Boolean));
      system().eachMicrophone((mic) => mic.setMuted(muted));
      return muted;
    },
  };
}

module.exports = { createMicrophone, MicrophoneError, MODES };
