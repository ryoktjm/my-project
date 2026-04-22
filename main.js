'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    title: '3D モデルビューアー',
  });

  mainWindow.loadFile('index.html');

  const menu = Menu.buildFromTemplate([
    {
      label: 'ファイル',
      submenu: [
        {
          label: 'ファイルを開く',
          accelerator: 'CmdOrCtrl+O',
          click: () => openFile(),
        },
        { type: 'separator' },
        { role: 'quit', label: '終了' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

async function openFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: '3D Models', extensions: ['step', 'stp', 'stl'] }],
    properties: ['openFile', 'multiSelections'],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    for (const filePath of result.filePaths) {
      const buffer = fs.readFileSync(filePath);
      mainWindow.webContents.send('load-model', {
        filePath,
        fileName: path.basename(filePath),
        buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      });
    }
  }
}

ipcMain.handle('open-file-dialog', async () => {
  await openFile();
});

ipcMain.handle('save-stl-dialog', async (event, stlData) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'STL Files', extensions: ['stl'] }],
    defaultPath: 'export.stl',
  });

  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, Buffer.from(stlData));
    return { success: true };
  }
  return { success: false };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
