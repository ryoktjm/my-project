import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';

let mainWindow: BrowserWindow;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // electron-vite outputs preload to dist/preload/index.js
      preload: join(__dirname, '../preload/index.js'),
    },
    title: '3D モデルビューアー',
  });

  // Dev: load Vite dev server; Production: load bundled HTML
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  const menu = Menu.buildFromTemplate([
    {
      label: 'ファイル',
      submenu: [
        { label: 'ファイルを開く', accelerator: 'CmdOrCtrl+O', click: () => openFile() },
        { type: 'separator' },
        { role: 'quit', label: '終了' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

async function openFile(): Promise<void> {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: '3D Models', extensions: ['step', 'stp', 'stl'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled) return;

  for (const filePath of result.filePaths) {
    const buffer = readFileSync(filePath);
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
    mainWindow.webContents.send('load-model', {
      filePath,
      fileName: filePath.split('/').pop() ?? filePath,
      buffer: arrayBuffer,
    });
  }
}

ipcMain.handle('open-file-dialog', () => openFile());

ipcMain.handle('save-stl-dialog', async (_event, stlData: ArrayBuffer) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'STL Files', extensions: ['stl'] }],
    defaultPath: 'export.stl',
  });
  if (!result.canceled && result.filePath) {
    writeFileSync(result.filePath, Buffer.from(stlData));
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
