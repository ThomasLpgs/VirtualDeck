const { contextBridge, ipcRenderer } = require('electron');

const listener = (channel) => (callback) => {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  press: (index) => ipcRenderer.invoke('deck:press', index),
  hideDeck: () => ipcRenderer.send('deck:hide'),
  openEditor: (buttonIndex) => ipcRenderer.send('editor:open', buttonIndex),
  pauseHotkey: (paused) => ipcRenderer.send('hotkey:pause', paused),
  pickFile: (kind) => ipcRenderer.invoke('dialog:pick', kind),
  listIcons: () => ipcRenderer.invoke('icons:list'),
  obsState: () => ipcRenderer.invoke('obs:state'),
  obsConnect: (settings) => ipcRenderer.invoke('obs:connect', settings),
  obsScenes: () => ipcRenderer.invoke('obs:scenes'),
  obsSources: (scene) => ipcRenderer.invoke('obs:sources', scene),
  onConfig: listener('config:changed'),
  onObsState: listener('obs:state'),
  onDeckShow: listener('deck:show'),
  onAudio: listener('audio:toggle'),
  onEditorSelect: listener('editor:select'),
});
