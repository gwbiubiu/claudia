import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { registerIPC } from './ipc';

let mainWindow: BrowserWindow | null = null;
let pendingNewChatCwd: string | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, '../../dist/preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../../src/renderer/index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingNewChatCwd) {
      mainWindow!.webContents.send('open-new-chat', pendingNewChatCwd);
      pendingNewChatCwd = null;
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function handleUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'claudia:' && parsed.hostname === 'chat') {
      const cwd = parsed.searchParams.get('cwd') ?? require('os').homedir();
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('open-new-chat', cwd);
      } else {
        pendingNewChatCwd = cwd;
      }
    }
  } catch { /* ignore invalid URLs */ }
}

app.setName('Claudia');
app.setAsDefaultProtocolClient('claudia');

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleUrl(url);
});

app.whenReady().then(() => {
  registerIPC();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

