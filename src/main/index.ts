import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Supervisor } from './supervisor'
import { PROTOCOL_VERSION, type AgentInit } from '../shared/protocol'

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


export function agentPaths() {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return {
    cuaSdkPath: join(base, app.isPackaged ? 'cua-sdk/cua-sdk.mjs' : 'resources/cua-sdk/cua-sdk.mjs'),
    cuaLibraryPath: join(base, app.isPackaged ? 'cua-sdk/native/libcua_driver_sdk.dylib' : 'resources/cua-sdk/native/libcua_driver_sdk.dylib'),
    nativeHelperPath: join(base, app.isPackaged ? 'native/JevNative' : 'native/build/JevNative'),
  }
}

let supervisor: Supervisor | undefined
let shutdownComplete = false

async function startAgent() {
  const init: AgentInit = {
    type: 'init',
    version: PROTOCOL_VERSION,
    ...agentPaths(),
    evidenceDir: join(app.getPath('userData'), 'evidence'),
  }
  supervisor = new Supervisor(
    () => {
      const child = utilityProcess.fork(join(root, 'agent.js'), [], {
        serviceName: 'JevAuto Agent',
        stdio: 'pipe',
        disclaim: false, // stay in JevAuto's TCC responsibility chain (spec §3)
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: app.getPath('home'),
          LANG: 'en_US.UTF-8',
          CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
        },
      })
      // Drain the pipes so a chatty agent can never block on a full buffer.
      child.stdout?.on('data', (chunk) => console.log(`[agent] ${String(chunk).trimEnd()}`))
      child.stderr?.on('data', (chunk) => console.error(`[agent] ${String(chunk).trimEnd()}`))
      return child
    },
    init,
    {
      maxRestarts: 3,
      windowMs: 60_000,
      backoffMs: 500,
      readyTimeoutMs: 15_000,
      onEvent: (name, data) => emit(`agent event ${name}: ${JSON.stringify(data)}`),
      onGiveUp: (reason) => emit(reason),
    },
  )
  await supervisor.start()
  const pong = await supervisor.request<{ pid: number }>('ping', {}, { timeoutMs: 5_000 })
  emit(`agent ready (pid ${pong.pid})`)
}

app.whenReady().then(async () => {
  harness = createHarness()
  await startAgent().catch((error) => emit(`agent failed: ${error instanceof Error ? error.message : error}`))
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event) => {
  if (shutdownComplete || !supervisor) return
  event.preventDefault()
  void supervisor.stop().finally(() => {
    shutdownComplete = true
    app.quit()
  })
})
