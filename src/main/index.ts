import { app, ipcMain, screen, utilityProcess, type BrowserWindow } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { Supervisor } from './supervisor'
import { spikeFromArgv, runSpike, type SpikeName } from './spikes'
import { UiCoordinator } from './ui'
import { PROTOCOL_VERSION, type AgentInit } from '../shared/protocol'
import { UiAct, UiDone, UiStatus, type UiEvent } from '../shared/ui-events'
import { readDisplays } from '../shared/native'

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
let ui: UiCoordinator | undefined
const status: string[] = ['JevAuto: starting']

export function emit(line: string) {
  status.push(line)
  if (status.length > 500) status.shift()
  ui?.broadcast({ type: 'status-line', line })
}
const broadcast = (event: UiEvent) => ui?.broadcast(event)

/** Loads one surface of the single renderer entry (the dev server in development). */
const load = (window: BrowserWindow, query: Record<string, string>) =>
  process.env.ELECTRON_RENDERER_URL && !app.isPackaged
    ? void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${new URLSearchParams(query)}`)
    : void window.loadFile(join(root, '../renderer/index.html'), { query })

const Command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('run'), spike: z.enum(['demo']) }),
  z.object({ type: z.literal('island-hit'), rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable() }),
])

ipcMain.handle('jevauto:command', (event, raw: unknown) => {
  if (!sameDocument(event.senderFrame?.url)) throw new Error('Untrusted sender')
  const parsed = Command.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Unknown command' }
  const command = parsed.data
  if (command.type === 'status') return { ok: true, value: status }
  if (command.type === 'stop') stopWork()
  else if (command.type === 'run') void startRun(command.spike)
  else ui?.setIslandHit(command.rect)
  return { ok: true, value: null }
})

/** Agent `ui.*` events go to every surface once they match the schema; anything else is logged. */
function relay(name: string, data: unknown) {
  const parsed =
    name === 'ui.act' ? UiAct.safeParse(data)
    : name === 'ui.done' ? UiDone.safeParse(data)
    : name === 'ui.status' ? UiStatus.safeParse(data)
    : undefined
  if (parsed?.success) {
    if (name === 'ui.act') broadcast({ type: 'act', act: parsed.data as UiAct })
    else if (name === 'ui.done') broadcast({ type: 'done', done: parsed.data as UiDone })
    else broadcast({ type: 'status', status: parsed.data as UiStatus })
    return
  }
  emit(`agent event ${name}: ${JSON.stringify(data)}`)
}

export function agentPaths() {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return {
    cuaSdkPath: join(base, app.isPackaged ? 'cua-sdk/cua-sdk.mjs' : 'resources/cua-sdk/cua-sdk.mjs'),
    cuaLibraryPath: join(base, app.isPackaged ? 'cua-sdk/native/libcua_driver_sdk.dylib' : 'resources/cua-sdk/native/libcua_driver_sdk.dylib'),
    nativeHelperPath: join(base, app.isPackaged ? 'native/JevNative' : 'native/build/JevNative'),
  }
}

let supervisor: Supervisor | undefined
let lastInit: AgentInit | undefined
let shutdownComplete = false

async function startAgent() {
  const init: AgentInit = {
    type: 'init',
    version: PROTOCOL_VERSION,
    ...agentPaths(),
    evidenceDir: join(app.getPath('userData'), 'evidence'),
  }
  lastInit = init
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
      onEvent: relay,
      onGiveUp: (reason) => emit(reason),
    },
  )
  await supervisor.start()
  const pong = await supervisor.request<{ pid: number }>('ping', {}, { timeoutMs: 5_000 })
  emit(`agent ready (pid ${pong.pid})`)
}

let run: AbortController | undefined

async function startRun(name: SpikeName) {
  if (run || !supervisor || !lastInit) return
  const controller = new AbortController()
  run = controller
  try {
    await runSpike(name, {
      supervisor,
      paths: agentPaths(),
      evidenceDir: lastInit.evidenceDir,
      argv: process.argv,
      emit,
      broadcast: (event) => broadcast(event),
      signal: controller.signal,
      halt: haltAgent,
      preload: join(root, '../preload/index.cjs'),
      load,
    })
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error)
      emit(`${name} failed: ${message}`)
      broadcast({ type: 'status', status: { state: 'error', title: 'Something went wrong', detail: message.slice(0, 120) } })
    }
  } finally {
    if (run === controller) run = undefined
  }
}

/**
 * Stop's backstop (spec §8): 250 ms after a cancel, kill the agent. Cancelling a Cua call does not stop the keystrokes
 * it already queued (Spike A), but the in-process driver dies with the agent; the supervisor restarts it.
 */
function haltAgent() {
  setTimeout(() => supervisor?.kill(), 250)
}

/** Stop: cancel the run at once, then halt the agent. */
function stopWork() {
  if (!run) return
  run.abort()
  broadcast({ type: 'status', status: { state: 'stopped', title: 'Stopped' } })
  emit('Stop: run cancelled; the agent is killed in 250 ms so queued input stops too.')
  haltAgent()
}

async function watchDisplays() {
  const refresh = async () => ui?.setDisplays(await readDisplays(agentPaths().nativeHelperPath))
  await refresh()
  let pending: NodeJS.Timeout | undefined
  const later = () => {
    clearTimeout(pending)
    pending = setTimeout(() => void refresh().catch((error) => emit(`displays: ${error instanceof Error ? error.message : error}`)), 400)
  }
  screen.on('display-added', later)
  screen.on('display-removed', later)
  screen.on('display-metrics-changed', later)
}

app.whenReady().then(async () => {
  ui = new UiCoordinator(join(root, '../preload/index.cjs'), load)
  try {
    await startAgent()
    await watchDisplays()
    await startRun(spikeFromArgv(process.argv))
  } catch (error) {
    emit(`startup failed: ${error instanceof Error ? error.message : error}`)
  }
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
