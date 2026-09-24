import { app, globalShortcut, ipcMain, screen, utilityProcess, type BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { Supervisor } from './supervisor'
import { spikeFromArgv, runSpike, type SpikeName } from './spikes'
import { UiCoordinator } from './ui'
import { PROTOCOL_VERSION, type AgentInit } from '../shared/protocol'
import { UiAct, UiApproval, UiDone, UiQuestion, UiStatus, type UiEvent } from '../shared/ui-events'
import { keysFromEnvFile } from './keys'
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
  z.object({ type: z.literal('task'), text: z.string().trim().min(1).max(2000) }),
  z.object({ type: z.literal('answer'), id: z.string().min(1), answer: z.enum(['once', 'run', 'deny']) }),
  z.object({ type: z.literal('reply'), id: z.string().min(1), text: z.string().max(4000).nullable() }),
  z.object({ type: z.literal('command-bar'), open: z.boolean() }),
])

ipcMain.handle('jevauto:command', (event, raw: unknown) => {
  if (!sameDocument(event.senderFrame?.url)) throw new Error('Untrusted sender')
  const parsed = Command.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Unknown command' }
  const command = parsed.data
  if (command.type === 'status') return { ok: true, value: status }
  if (command.type === 'stop') stopWork()
  else if (command.type === 'run') void startRun(command.spike)
  else if (command.type === 'task') void startTask(command.text)
  else if (command.type === 'answer') supervisor?.reply(command.id, { answer: command.answer })
  else if (command.type === 'reply') supervisor?.reply(command.id, { text: command.text })
  else if (command.type === 'command-bar') ui?.showCommandBar(command.open)
  else ui?.setIslandHit(command.rect)
  return { ok: true, value: null }
})

const Closed = z.object({ id: z.string() })

/** Agent `ui.*` events go to every surface once they match the schema; anything else is logged. */
function relay(name: string, data: unknown) {
  const closed = Closed.safeParse(data)
  const event: UiEvent | undefined =
    name === 'ui.act' ? parsedEvent(UiAct, data, (act) => ({ type: 'act', act }))
    : name === 'ui.done' ? parsedEvent(UiDone, data, (done) => ({ type: 'done', done }))
    : name === 'ui.status' ? parsedEvent(UiStatus, data, (status) => ({ type: 'status', status }))
    : name === 'ui.approval' ? parsedEvent(UiApproval, data, (approval) => ({ type: 'approval', approval }))
    : name === 'ui.question' ? parsedEvent(UiQuestion, data, (question) => ({ type: 'question', question }))
    : name === 'ui.approval-closed' && closed.success ? { type: 'approval-closed', id: closed.data.id }
    : name === 'ui.question-closed' && closed.success ? { type: 'question-closed', id: closed.data.id }
    : undefined
  if (event) broadcast(event)
  else emit(`agent event ${name}: ${JSON.stringify(data)}`)
}

function parsedEvent<T>(schema: z.ZodType<T>, data: unknown, wrap: (value: T) => UiEvent): UiEvent | undefined {
  const parsed = schema.safeParse(data)
  return parsed.success ? wrap(parsed.data) : undefined
}

/**
 * Provider keys for the agent. `pnpm dev` reads this checkout's .env.local; the signed dev bundle carries the path in its
 * package.json (scripts/app.mjs). Keys go to the agent in its init message and nowhere else.
 */
function loadKeys(): AgentInit['keys'] {
  let file: string | undefined = join(app.getAppPath(), '.env.local')
  if (app.isPackaged)
    try {
      file = (JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { jevautoEnvFile?: string }).jevautoEnvFile
    } catch {
      file = undefined
    }
  return file && existsSync(file) ? keysFromEnvFile(readFileSync(file, 'utf8')) : {}
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
    runsDir: join(app.getPath('userData'), 'runs'),
    keys: loadKeys(),
  }
  if (!init.keys?.openai) emit('No OpenAI key found. Add OPENAI_API_KEY to .env.local and restart JevAuto.')
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

type RunOutcome = { status: string; summary: string; actions: number; turns: number; usd: number; ms: number; log: string }

/** A task you typed: the agent's loop runs it; its status events drive the island and the activity window. */
async function startTask(task: string) {
  ui?.showCommandBar(false)
  if (run || !supervisor) {
    emit(run ? 'A task is already running. Stop it first.' : 'The agent is not ready yet.')
    return
  }
  const controller = new AbortController()
  run = controller
  broadcast({ type: 'status', status: { state: 'working', title: task } })
  try {
    const r = await supervisor.request<RunOutcome>('agent.run', { task }, { signal: controller.signal })
    emit(`${r.status}: ${r.summary} (${r.actions} actions, ${r.turns} turns, ${(r.ms / 1000).toFixed(1)} s, $${r.usd.toFixed(3)}) · log ${r.log}`)
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error)
      emit(`task failed: ${message}`)
      broadcast({ type: 'status', status: { state: 'error', title: 'Could not finish', detail: message.slice(0, 160) } })
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
  // ⌃⌥Space, not ⌥Space: ChatGPT owns that one (spec §9).
  if (!globalShortcut.register('Control+Alt+Space', () => ui?.toggleCommandBar()))
    emit('⌃⌥Space is taken by another app; type tasks in the JevAuto window instead.')
  try {
    await startAgent()
    await watchDisplays()
    await startRun(spikeFromArgv(process.argv))
  } catch (error) {
    emit(`startup failed: ${error instanceof Error ? error.message : error}`)
  }
})

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('before-quit', (event) => {
  if (shutdownComplete || !supervisor) return
  event.preventDefault()
  void supervisor.stop().finally(() => {
    shutdownComplete = true
    app.quit()
  })
})
