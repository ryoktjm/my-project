const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  saveStlDialog: (stlData) => ipcRenderer.invoke('save-stl-dialog', stlData),
  onLoadModel: (callback) => ipcRenderer.on('load-model', (event, data) => callback(data)),
});
