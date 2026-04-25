import { contextBridge, ipcRenderer } from 'electron';

export interface ElectronAPI {
  openFileDialog: () => Promise<void>;
  saveStlDialog: (stlData: ArrayBuffer) => Promise<{ success: boolean }>;
  onLoadModel: (
    callback: (data: { fileName: string; buffer: ArrayBuffer }) => void,
  ) => void;
}

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),

  saveStlDialog: (stlData: ArrayBuffer) =>
    ipcRenderer.invoke('save-stl-dialog', stlData),

  onLoadModel: (
    callback: (data: { fileName: string; buffer: ArrayBuffer }) => void,
  ) => {
    ipcRenderer.on('load-model', (_event, data) => callback(data));
  },
} satisfies ElectronAPI);
