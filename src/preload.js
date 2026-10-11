const { contextBridge, ipcRenderer } = require('electron');

const listener = (channel) => (callback) => {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getI18n: () => ipcRenderer.invoke('i18n:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),
  press: (index) => ipcRenderer.invoke('deck:press', index),
  hideDeck: () => ipcRenderer.send('deck:hide'),
  resetDeckPosition: () => ipcRenderer.send('deck:resetPosition'),
  openEditor: (buttonIndex) => ipcRenderer.send('editor:open', buttonIndex),
  pauseHotkey: (paused) => ipcRenderer.send('hotkey:pause', paused),
  pickFile: (kind) => ipcRenderer.invoke('dialog:pick', kind),
  listIcons: () => ipcRenderer.invoke('icons:list'),
  streamState: () => ipcRenderer.invoke('stream:state'),
  streamReconnect: () => ipcRenderer.invoke('stream:reconnect'),
  streamScenes: () => ipcRenderer.invoke('stream:scenes'),
  streamVerticalScenes: () => ipcRenderer.invoke('stream:verticalScenes'),
  streamSources: (scene, vertical) => ipcRenderer.invoke('stream:sources', scene, vertical),
  getUpdate: () => ipcRenderer.invoke('update:get'),
  openUpdate: () => ipcRenderer.send('update:open'),
  onConfig: listener('config:changed'),
  onStreamState: listener('stream:state'),
  onDeckShow: listener('deck:show'),
  onAudio: listener('audio:toggle'),
  onEditorSelect: listener('editor:select'),
  onUpdate: listener('update:available'),
});
