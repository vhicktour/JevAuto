import { app, clipboard, globalShortcut, ipcMain, safeStorage, screen, shell, utilityProcess, type BrowserWindow } from 'electron'
import { release } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { Supervisor } from './supervisor'
import { spikeFromArgv, runSpike, type SpikeName } from './spikes'
import { UiCoordinator } from './ui'
import { PROTOCOL_VERSION, type AgentInit } from '../shared/protocol'
import { UiAct, UiApproval, UiDone, UiQuestion, UiStatus, UiView, type UiEvent } from '../shared/ui-events'
import { keysFromEnvFile } from './keys'
import { MODELS, type ModelId } from '../shared/models'
import { SPEEDS } from '../shared/motion'
import { SettingsStore } from './settings'
import { KEY_NAMES, KeyStore, keySources, type KeyName } from './secrets'
import { readDisplays } from '../shared/native'
import electronUpdater from 'electron-updater'
import { Updates, type Updater } from './updates'
import { McpServer } from './mcp'
import type { DriveResult } from '../shared/drive'

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
/** Watch mode (on by default), the model and your excluded apps, kept in settings.json. */
let settings: SettingsStore | undefined
/** Keys you saved in Settings, encrypted with your Keychain; they override .env.local. */
let keys: KeyStore | undefined
/** Release builds keep themselves up to date (off in the dev bundle). */
let updates: Updates | undefined
/** Claude Code's way in, while you allow it in Settings. */
let mcp: McpServer | undefined
const mcpSocket = () => join(app.getPath('home'), '.jevauto', 'mcp.sock')
/** Adds JevAuto to every Claude Code session on this Mac (user scope). */
const mcpCommand = () => `claude mcp add --scope user jevauto -- /usr/bin/nc -U ${JSON.stringify(mcpSocket())}`
/** Only the models whose provider key JevAuto has. */
const availableModels = () => MODELS.filter((m) => lastInit?.keys?.[m.key]).map((m) => ({ id: m.id, label: m.label }))

function settingsView() {
  const s = settings!.get()
  const set = keySources(keys!.all(), loadKeys() ?? {})
  return {
    watch: s.watch,
    model: s.model,
    speed: s.speed,
    auto: s.auto,
    models: availableModels(),
    excluded: s.excluded,
    trusted: s.trusted,
    keys: set,
    version: app.getVersion(),
    update: updates?.current ?? { status: 'off' },
    mcp: s.mcp,
    mcpCommand: mcpCommand(),
  }
}

/** Every surface hears Watch mode, the model and the cursor speed whenever one of them changes. */
function broadcastSettings() {
  const { watch, model, speed, auto } = settings!.get()
  broadcast({ type: 'settings', watch, model, speed, auto })
}

/** New keys reach the agent in its next init: restart it (between runs only). */
function applyKeys() {
  if (!lastInit) return
  lastInit.keys = { ...loadKeys(), ...keys!.all() }
  if (!run) supervisor?.kill()
  broadcastSettings()
}

/** What helps a bug report, and nothing private: no keys, no screenshots, no task text. */
function diagnostics(): string {
  const set = KEY_NAMES.filter((k) => lastInit?.keys?.[k]).join(', ') || 'none'
  return [
    `JevAuto ${app.getVersion()} (${app.isPackaged ? 'packaged' : 'dev'}) · macOS ${release()} · ${process.arch}`,
    `keys set: ${set} · model: ${settings?.get().model} · watch: ${settings?.get().watch} · speed: ${settings?.get().speed} · full auto: ${settings?.get().auto}`,
    ...status.slice(-60).filter((line) => !/sk-|key=/i.test(line)),
  ].join('\n')
}
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
  /** `next` queues the task behind the one running; otherwise it starts now. */
  z.object({ type: z.literal('task'), text: z.string().trim().min(1).max(2000), when: z.enum(['now', 'next']).default('now') }),
  z.object({ type: z.literal('unqueue'), index: z.number().int().min(0).max(9) }),
  z.object({ type: z.literal('steer'), text: z.string().trim().min(1).max(2000) }),
  /** `text`: what a typing step should type instead, when you edited it. */
  z.object({ type: z.literal('answer'), id: z.string().min(1), answer: z.enum(['once', 'run', 'always', 'deny']), text: z.string().max(4000).optional() }),
  z.object({ type: z.literal('untrust'), id: z.string().min(1).max(300) }),
  z.object({ type: z.literal('reply'), id: z.string().min(1), text: z.string().max(4000).nullable() }),
  z.object({ type: z.literal('command-bar'), open: z.boolean() }),
  z.object({ type: z.literal('settings') }),
  z.object({ type: z.literal('watch'), on: z.boolean() }),
  z.object({ type: z.literal('model'), id: z.enum(MODELS.map((m) => m.id) as [ModelId, ...ModelId[]]) }),
  z.object({ type: z.literal('speed'), speed: z.enum(SPEEDS) }),
  z.object({ type: z.literal('auto'), on: z.boolean() }),
  z.object({ type: z.literal('mcp'), on: z.boolean() }),
  z.object({ type: z.literal('copy-mcp-command') }),
  z.object({ type: z.literal('lessons') }),
  z.object({ type: z.literal('forget-lesson'), app: z.string().max(100), tip: z.string().max(300) }),
  z.object({ type: z.literal('set-key'), name: z.enum(KEY_NAMES as [KeyName, ...KeyName[]]), value: z.string().max(500) }),
  z.object({ type: z.literal('set-excluded'), apps: z.array(z.string().trim().min(1).max(200)).max(100) }),
  z.object({ type: z.literal('open-privacy'), pane: z.enum(['accessibility', 'screen']) }),
  z.object({ type: z.literal('diagnostics') }),
  z.object({ type: z.literal('install-update') }),
])

ipcMain.handle('jevauto:command', async (event, raw: unknown) => {
  if (!sameDocument(event.senderFrame?.url)) throw new Error('Untrusted sender')
  const parsed = Command.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Unknown command' }
  const command = parsed.data
  if (command.type === 'status') return { ok: true, value: status }
  if (command.type === 'settings') return { ok: true, value: settingsView() }
  if (command.type === 'watch' || command.type === 'model' || command.type === 'speed' || command.type === 'auto') {
    settings!.update(
      command.type === 'watch' ? { watch: command.on }
      : command.type === 'model' ? { model: command.id }
      : command.type === 'speed' ? { speed: command.speed }
      : { auto: command.on },
    )
    broadcastSettings()
    return { ok: true, value: settingsView() }
  }
  if (command.type === 'set-excluded') {
    settings!.update({ excluded: command.apps })
    return { ok: true, value: settingsView() }
  }
  if (command.type === 'mcp') {
    settings!.update({ mcp: command.on })
    await applyMcp()
    return { ok: true, value: settingsView() }
  }
  if (command.type === 'lessons' || command.type === 'forget-lesson') {
    if (!supervisor) return { ok: true, value: [] }
    if (command.type === 'forget-lesson') await supervisor.request('lessons.forget', { app: command.app, tip: command.tip }, { timeoutMs: 5_000 })
    return { ok: true, value: await supervisor.request('lessons.list', {}, { timeoutMs: 5_000 }) }
  }
  if (command.type === 'copy-mcp-command') {
    clipboard.writeText(mcpCommand())
    return { ok: true, value: null }
  }
  if (command.type === 'untrust') {
    settings!.update({ trusted: settings!.get().trusted.filter((t) => t.id !== command.id) })
    return { ok: true, value: settingsView() }
  }
  if (command.type === 'steer') {
    if (!run || !supervisor) return { ok: false, error: 'Nothing is running.' }
    supervisor.steer(command.text)
    emit(`You told JevAuto: ${command.text}`)
    return { ok: true, value: null }
  }
  if (command.type === 'task' && mcp?.driving) return { ok: false, error: 'Claude Code is driving JevAuto right now. Try again when it has finished.' }
  if (command.type === 'task' && command.when === 'next' && run) {
    if (queue.length >= QUEUE_MAX) return { ok: false, error: `At most ${QUEUE_MAX} tasks can wait.` }
    queue.push(command.text)
    broadcast({ type: 'queue', tasks: [...queue] })
    return { ok: true, value: null }
  }
  if (command.type === 'unqueue') {
    queue.splice(command.index, 1)
    broadcast({ type: 'queue', tasks: [...queue] })
    return { ok: true, value: null }
  }
  if (command.type === 'set-key') {
    keys!.set(command.name, command.value)
    applyKeys()
    return { ok: true, value: settingsView() }
  }
  if (command.type === 'open-privacy') {
    void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${command.pane === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture'}`)
    return { ok: true, value: null }
  }
  if (command.type === 'diagnostics') {
    clipboard.writeText(diagnostics())
    return { ok: true, value: null }
  }
  if (command.type === 'install-update') {
    if (run) return { ok: false, error: 'Finish or stop the task first.' }
    return updates?.install() ? { ok: true, value: null } : { ok: false, error: 'No update is ready.' }
  }
  if (command.type === 'stop') stopWork()
  else if (command.type === 'run') void startRun(command.spike)
  else if (command.type === 'task') void startTask(command.text)
  else if (command.type === 'answer') supervisor?.reply(command.id, { answer: command.answer, ...(command.text !== undefined ? { text: command.text } : {}) })
  else if (command.type === 'reply') supervisor?.reply(command.id, { text: command.text })
  else if (command.type === 'command-bar') ui?.showCommandBar(command.open)
  else ui?.setIslandHit(command.rect)
  return { ok: true, value: null }
})

const Closed = z.object({ id: z.string() })
const Trust = z.object({ id: z.string().min(1).max(300), app: z.string().min(1).max(200) })

/** Agent `ui.*` events go to every surface once they match the schema; anything else is logged. */
function relay(name: string, data: unknown) {
  const closed = Closed.safeParse(data)
  const event: UiEvent | undefined =
    name === 'ui.act' ? parsedEvent(UiAct, data, (act) => ({ type: 'act', act }))
    : name === 'ui.done' ? parsedEvent(UiDone, data, (done) => ({ type: 'done', done }))
    : name === 'ui.status' ? parsedEvent(UiStatus, data, (status) => ({ type: 'status', status }))
    : name === 'ui.approval' ? parsedEvent(UiApproval, data, (approval) => ({ type: 'approval', approval }))
    : name === 'ui.question' ? parsedEvent(UiQuestion, data, (question) => ({ type: 'question', question }))
    : name === 'ui.view' ? parsedEvent(UiView, data, (view) => ({ type: 'view', view }))
    : name === 'ui.approval-closed' && closed.success ? { type: 'approval-closed', id: closed.data.id }
    : name === 'ui.question-closed' && closed.success ? { type: 'question-closed', id: closed.data.id }
    : undefined
  if (name === 'drive.ended') return mcp?.ended()
  if (name === 'drive.failed') return emit(`Claude Code session could not start: ${String((data as { message?: unknown })?.message ?? '')}`)
  const trust = name === 'ui.trust' ? Trust.safeParse(data) : undefined
  if (trust?.success) {
    const { id, app } = trust.data
    settings!.update({ trusted: [...settings!.get().trusted.filter((t) => t.id !== id), { id, app }].slice(-100) })
    emit(`JevAuto will bring ${app} forward for shortcuts without asking. Change this in Settings.`)
    return
  }
  if (event) broadcast(event)
  // A picture that fails the schema is dropped unseen: screenshots never go into the log (or diagnostics).
  else emit(name === 'ui.view' ? 'agent event ui.view dropped: not a valid picture' : `agent event ${name}: ${JSON.stringify(data).slice(0, 300)}`)
  // A question needs typing, so the window comes back even if Watch mode moved it aside.
  if (event?.type === 'question' && !ui?.activity.isVisible()) ui?.activity.show()
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
    browserProfileDir: join(app.getPath('userData'), 'browser-profile'),
    keys: { ...loadKeys(), ...keys!.all() },
  }
  if (!Object.values(init.keys ?? {}).some(Boolean)) emit('No model keys yet. Add one in Settings (or .env.local).')
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

type RunOutcome = { status: string; summary: string; actions: number; turns: number; usd: number; ms: number; log: string; unheard?: string[] }

/** Tasks you queued behind the running one (spec §9: steer vs. queue). Stop clears them. */
let queue: string[] = []
const QUEUE_MAX = 10

/** A task you typed: the agent's loop runs it; its status events drive the island and the activity window. */
async function startTask(task: string) {
  ui?.showCommandBar(false)
  if (run || !supervisor) {
    emit(run ? 'A task is already running. Stop it first.' : 'The agent is not ready yet.')
    return
  }
  const controller = new AbortController()
  run = controller
  const { watch, model, excluded, speed, trusted, auto } = settings!.get()
  // In Watch mode JevAuto's own window steps aside so it never covers the app being worked in; the island stays.
  const stepAside = watch && ui?.activity.isVisible() === true
  if (stepAside) ui?.activity.hide()
  broadcast({ type: 'status', status: { state: 'working', title: task } })
  try {
    const r = await supervisor.request<RunOutcome>(
      'agent.run',
      { task, watch, model, excluded, speed, auto, trusted: trusted.map((t) => t.id) },
      { signal: controller.signal },
    )
    emit(`${r.status}: ${r.summary} (${r.actions} actions, ${r.turns} turns, ${(r.ms / 1000).toFixed(1)} s, $${r.usd.toFixed(3)}) · log ${r.log}`)
    for (const said of r.unheard ?? []) emit(`The task finished before JevAuto read: ${said}`)
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error)
      emit(`task failed: ${message}`)
      broadcast({ type: 'status', status: { state: 'error', title: 'Could not finish', detail: message.slice(0, 160) } })
    }
  } finally {
    if (run === controller) run = undefined
    if (stepAside) ui?.activity.showInactive()
    // The next queued task starts once this one is over, however it ended; Stop has already emptied the queue.
    const next = queue.shift()
    if (next !== undefined) {
      broadcast({ type: 'queue', tasks: [...queue] })
      setTimeout(() => void startTask(next), 600)
    }
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
  const driving = mcp?.driving === true
  if (!run && !driving) return
  queue = []
  broadcast({ type: 'queue', tasks: [] })
  run?.abort()
  if (driving) {
    // Claude Code is told to ask you before it goes on; its session ends with the agent.
    mcp!.pause(60_000)
    void supervisor?.request('drive.stop', {}, { timeoutMs: 2_000 }).catch(() => undefined)
  }
  broadcast({ type: 'status', status: { state: 'stopped', title: 'Stopped' } })
  emit('Stop: run cancelled; the agent is killed in 250 ms so queued input stops too.')
  haltAgent()
}

/** Opens or closes Claude Code's socket to match Settings. */
async function applyMcp() {
  const on = settings!.get().mcp
  if (on && !mcp) {
    const server = new McpServer({
      socketPath: mcpSocket(),
      version: app.getVersion(),
      call: async (call) => {
        if (!supervisor) return { ok: false, text: 'JevAuto is still starting. Try again in a moment.' }
        if (run) return { ok: false, text: 'JevAuto is running one of its own tasks. Wait for it to finish, or ask the user to press Stop.' }
        const { watch, speed, auto, excluded, trusted } = settings!.get()
        return supervisor.request<DriveResult>('drive.call', { call, settings: { watch, speed, auto, excluded, trusted: trusted.map((t) => t.id) } }, { timeoutMs: 5 * 60_000 })
      },
      end: () => void supervisor?.request('drive.end', {}, { timeoutMs: 10_000 }).catch(() => undefined),
      log: emit,
    })
    try {
      await server.start()
      mcp = server
      emit(`Claude Code can drive JevAuto through ${mcpSocket()}.`)
    } catch (error) {
      emit(`Claude Code's socket could not open: ${error instanceof Error ? error.message : error}`)
    }
  } else if (!on && mcp) {
    mcp.stop()
    mcp = undefined
    emit('Claude Code can no longer drive JevAuto.')
  }
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
  settings = new SettingsStore(app.getPath('userData'))
  keys = new KeyStore(app.getPath('userData'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  })
  ui = new UiCoordinator(join(root, '../preload/index.cjs'), load)
  updates = new Updates({
    packaged: app.isPackaged,
    name: app.getName(),
    updater: () => electronUpdater.autoUpdater as unknown as Updater,
    onChange: (update) => broadcast({ type: 'update', update }),
    log: emit,
  })
  updates.start()
  await applyMcp()
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
  mcp?.stop() // no socket left behind for Claude Code to find
  mcp = undefined
  if (shutdownComplete || !supervisor) return
  event.preventDefault()
  void supervisor.stop().finally(() => {
    shutdownComplete = true
    app.quit()
  })
})
