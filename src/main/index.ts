import { app, shell, BrowserWindow, ipcMain, dialog, nativeTheme } from 'electron'
import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'

const BACKEND_PORT = 8756
let backend: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null

const isDev = !app.isPackaged

/**
 * Resolve the Python interpreter for the backend. In dev we prefer the venv
 * created by `npm run backend:install`; otherwise fall back to system python.
 */
function resolvePython(): string {
  const venvWin = join(__dirname, '../../backend/.venv/Scripts/python.exe')
  const venvNix = join(__dirname, '../../backend/.venv/bin/python')
  if (existsSync(venvWin)) return venvWin
  if (existsSync(venvNix)) return venvNix
  return process.platform === 'win32' ? 'python' : 'python3'
}

function startBackend(): void {
  const python = resolvePython()
  const script = join(__dirname, '../../backend/run.py')
  if (!existsSync(script)) {
    console.error('[memora] backend script not found at', script)
    return
  }
  backend = spawn(python, [script], {
    env: { ...process.env, MEMORA_PORT: String(BACKEND_PORT), PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  backend.stdout?.on('data', (d) => console.log('[backend]', d.toString().trim()))
  backend.stderr?.on('data', (d) => console.log('[backend]', d.toString().trim()))
  backend.on('exit', (code) => console.log('[memora] backend exited', code))
}

function stopBackend(): void {
  if (backend && !backend.killed) {
    backend.kill()
    backend = null
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- IPC ------------------------------------------------------------------

ipcMain.handle('backend:port', () => BACKEND_PORT)

ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'multiSelections']
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('dialog:pickExportDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose export destination',
    properties: ['openDirectory', 'createDirectory']
  })
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
})

ipcMain.handle('theme:get', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))

// ---- App lifecycle --------------------------------------------------------

app.whenReady().then(() => {
  startBackend()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', stopBackend)
app.on('will-quit', stopBackend)
