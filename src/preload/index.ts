import { contextBridge, ipcRenderer } from 'electron'

const surfaceArg = process.argv.find((a) => a.startsWith('--jevauto-surface='))
const api = {
  surface: surfaceArg ? surfaceArg.split('=')[1] : 'harness',
  async command<T>(command: unknown): Promise<T> {
    const result = (await ipcRenderer.invoke('jevauto:command', command)) as
      | { ok: true; value: T }
      | { ok: false; error: string }
    if (!result.ok) throw new Error(result.error)
    return result.value
  },
  subscribe(listener: (event: unknown) => void) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value)
    ipcRenderer.on('jevauto:event', receive)
    return () => ipcRenderer.removeListener('jevauto:event', receive)
  },
}
contextBridge.exposeInMainWorld('jevauto', Object.freeze(api))
