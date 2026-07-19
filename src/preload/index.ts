import { contextBridge, ipcRenderer } from 'electron'

const api = {
  /** Port the local FastAPI backend is listening on. */
  getBackendPort: (): Promise<number> => ipcRenderer.invoke('backend:port'),
  /** Open the native folder picker; returns selected absolute paths. */
  pickFolders: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickFolder'),
  /** Pick a single destination folder for export; null if cancelled. */
  pickExportDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickExportDir'),
  /** OS-level dark/light preference at startup. */
  getSystemTheme: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('theme:get')
}

export type MemoraApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('memora', api)
} else {
  // @ts-ignore - fallback when context isolation is disabled
  window.memora = api
}
