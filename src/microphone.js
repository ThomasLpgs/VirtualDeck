// The PC's microphones (all of them, the default one or a chosen one), muted for every app at once
// (Discord, OBS, games…), like the mute switch of Windows' sound settings. Talks to Windows' audio
// (Core Audio, through koffi) only when a key asks: nothing runs in the background.

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
  const E_CONSOLE = 0;
  const DEVICE_STATE_ACTIVE = 1;
  const STGM_READ = 0;
  // The name Windows shows for a device ("Microphone (Blue Yeti)"), a text value of its properties.
  koffi.struct('VD_PROPERTYKEY', { fmtid: GUID, pid: 'uint32' });
  koffi.struct('VD_PROPVARIANT', { vt: 'uint16', r1: 'uint16', r2: 'uint16', r3: 'uint16', value: 'void *', extra: 'void *' });
  const PKEY_Device_FriendlyName = { fmtid: guid('A45C254E-DF1C-4EFD-8020-67D146A850E0'), pid: 14 };
  const VT_LPWSTR = 31;

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
  const CoTaskMemFree = ole32.func('void __stdcall CoTaskMemFree(void *)');
  const PropVariantClear = ole32.func('int32 __stdcall PropVariantClear(_Inout_ VD_PROPVARIANT *)');
  // Methods by their place in each interface (see Windows' mmdeviceapi.h and endpointvolume.h).
  const METHODS = {
    release: [2, koffi.proto('uint32 __stdcall VD_Release(void *)')],
    enumEndpoints: [3, koffi.proto('int32 __stdcall VD_EnumAudioEndpoints(void *, int32, uint32, _Out_ void **)')],
    defaultEndpoint: [4, koffi.proto('int32 __stdcall VD_GetDefaultAudioEndpoint(void *, int32, int32, _Out_ void **)')],
    count: [3, koffi.proto('int32 __stdcall VD_GetCount(void *, _Out_ uint32 *)')],
    item: [4, koffi.proto('int32 __stdcall VD_Item(void *, uint32, _Out_ void **)')],
    activate: [3, koffi.proto('int32 __stdcall VD_Activate(void *, VD_GUID *, uint32, void *, _Out_ void **)')],
    openProperties: [4, koffi.proto('int32 __stdcall VD_OpenPropertyStore(void *, uint32, _Out_ void **)')],
    getId: [5, koffi.proto('int32 __stdcall VD_GetId(void *, _Out_ void **)')],
    getValue: [5, koffi.proto('int32 __stdcall VD_GetValue(void *, VD_PROPERTYKEY *, _Out_ VD_PROPVARIANT *)')],
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
  // A device's id: stays the same across restarts, as long as it is plugged into the same port.
  const deviceId = (device) => {
    const text = created((out) => call(device, 'getId', out));
    try {
      return koffi.decode(text, 'char16_t', -1);
    } finally {
      CoTaskMemFree(text);
    }
  };
  const deviceName = (device) => {
    const store = created((out) => call(device, 'openProperties', STGM_READ, out));
    const value = {};
    try {
      call(store, 'getValue', PKEY_Device_FriendlyName, value);
      try {
        return value.vt === VT_LPWSTR && value.value ? koffi.decode(value.value, 'char16_t', -1) : '';
      } finally {
        PropVariantClear(value);
      }
    } finally {
      call(store, 'release');
    }
  };

  coreAudio = {
    // Runs fn on each active microphone ({ id, isDefault, name(), muted(), setMuted() }), then lets
    // go of them all.
    eachMicrophone(fn) {
      const held = [];
      try {
        const enumerator = created((out) => {
          const result = CoCreateInstance(CLSID_MMDeviceEnumerator, null, CLSCTX_ALL, IID_IMMDeviceEnumerator, out);
          if (result < 0) throw failed(result);
        });
        held.push(enumerator);
        // The microphone Windows' sound settings use by default (none: every one is unplugged).
        let defaultId = null;
        try {
          const fallback = created((out) => call(enumerator, 'defaultEndpoint', E_CAPTURE, E_CONSOLE, out));
          held.push(fallback);
          defaultId = deviceId(fallback);
        } catch {
          // No microphone at all: the list below is empty too.
        }
        const devices = created((out) => call(enumerator, 'enumEndpoints', E_CAPTURE, DEVICE_STATE_ACTIVE, out));
        held.push(devices);
        const count = [0];
        call(devices, 'count', count);
        const results = [];
        for (let i = 0; i < count[0]; i++) {
          const device = created((out) => call(devices, 'item', i, out));
          held.push(device);
          const id = deviceId(device);
          let volume = null;
          const control = () => {
            if (!volume) {
              volume = created((out) => call(device, 'activate', IID_IAudioEndpointVolume, CLSCTX_ALL, null, out));
              held.push(volume);
            }
            return volume;
          };
          results.push(
            fn({
              id,
              isDefault: id === defaultId,
              name: () => deviceName(device),
              muted: () => {
                const muted = [0];
                call(control(), 'getMute', muted);
                return muted[0] !== 0;
              },
              setMuted: (muted) => call(control(), 'setMute', muted ? 1 : 0, null),
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
// Which microphones a key mutes: every one, the one Windows uses by default, or one by its id.
const ALL = '';
const DEFAULT = 'default';

const picks = (device) => (mic) => (device === DEFAULT ? mic.isDefault : device === ALL || mic.id === device);

// system: Windows' audio (loadCoreAudio by default, a fake in the tests).
function createMicrophone({ system = loadCoreAudio } = {}) {
  // The picked microphones' muted states.
  const statesOf = (device) => system().eachMicrophone((mic) => (picks(device)(mic) ? mic.muted() : null)).filter((state) => state !== null);
  const missing = (device) => new MicrophoneError(device === ALL || device === DEFAULT ? 'noMic' : 'notFound');

  return {
    // The PC's microphones, for the editor to pick one: { id, name, isDefault }.
    list() {
      return system().eachMicrophone((mic) => ({ id: mic.id, name: mic.name(), isDefault: mic.isDefault }));
    },

    // Whether each device (see ALL / DEFAULT) is muted: true when every picked microphone is,
    // false when one can hear, null when none is plugged in. Reads Windows' audio once.
    states(devices) {
      const mics = system().eachMicrophone((mic) => ({ id: mic.id, isDefault: mic.isDefault, muted: mic.muted() }));
      return Object.fromEntries(
        devices.map((device) => {
          const picked = mics.filter(picks(device));
          return [device, picked.length ? picked.every((mic) => mic.muted) : null];
        }),
      );
    },

    // Mutes or unmutes the picked microphones. Toggle mutes them all as long as one can still hear.
    // Returns whether they are muted now.
    set(mode = 'toggle', device = ALL) {
      const states = statesOf(device);
      if (!states.length) throw missing(device);
      const muted = mode === 'mute' || (mode !== 'unmute' && !states.every(Boolean));
      // Every microphone is tried, even after one refused (unplugged meanwhile, held by an app).
      const refused = system().eachMicrophone((mic) => {
        if (!picks(device)(mic)) return false;
        try {
          mic.setMuted(muted);
          return false;
        } catch {
          return true;
        }
      });
      if (refused.some(Boolean)) throw new MicrophoneError('refused');
      return muted;
    },
  };
}

module.exports = { createMicrophone, MicrophoneError, MODES, ALL, DEFAULT };
