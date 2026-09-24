import { app, BrowserWindow, ipcMain } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
/** The exact renderer entry; privileged IPC is accepted only from this document (onemynd trust-boundary lesson). */
const rendererEntry = () =>
  process.env.ELECTRON_RENDERER_URL && !app.isPackaged
    ? new URL(process.env.ELECTRON_RENDERER_URL).href
    : pathToFileURL(join(root, '../renderer/index.html')).href
const sameDocument = (url: string | undefined) => {
  if (!url) return false
  const u = new URL(url)
  u.search = ''
  u.hash = ''
  return u.href === rendererEntry()
}
let harness: BrowserWindow | undefined
const status: string[] = ['Phase 0 harness: idle']

export function emit(line: string) {
  status.push(line)
  harness?.webContents.send('jevauto:event', { type: 'status', line })
}

function createHarness(): BrowserWindow {
  const window = new BrowserWindow({
    width: 760,
    height: 540,
    title: 'JevAuto Phase 0',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#08121A',
    show: false,
    webPreferences: {
      preload: join(root, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      additionalArguments: ['--jevauto-surface=harness'],
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged)
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?surface=harness`)
  else void window.loadFile(join(root, '../renderer/index.html'), { query: { surface: 'harness' } })
  return window
}

ipcMain.handle('jevauto:command', (event, command: { type: string }) => {
  if (!sameDocument(event.senderFrame?.url)) throw new Error('Untrusted sender')
  if (command?.type === 'status') return { ok: true, value: status }
  return { ok: false, error: `Unknown command ${String(command?.type)}` }
})

app.whenReady().then(() => {
  harness = createHarness()
})
app.on('window-all-closed', () => app.quit())
