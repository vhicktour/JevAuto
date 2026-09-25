import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { Lessons } from './lessons'
import { z } from 'zod'
import type { Handler, HandlerContext } from './agent'
import type { AgentMethod } from '../shared/protocol'
import { PHASE0_MODELS } from '../shared/constants'
import { SPEEDS } from '../shared/motion'
import { guardKeys, readFocus, readFrontmost } from '../shared/native'
import { instructionsFor } from './loop/instructions'
import { FULL_AUTO_BUDGET } from './loop/budget'
import { runTask, type Decision } from './loop/run'
import { RunLog } from './loop/runlog'
import { jevShadow } from './jev/shadow'
import { DEVELOPER_APPS } from './loop/targets'
import { adapterFor } from './providers'
import { loadStagedCua, MacDriver } from './mac/cua'
import { runSpikeA, SpikeAParams, startLongType } from './spikes/spike-a'
import { spikeBCapture, SpikeBParams } from './spikes/spike-b'
import { runDemo } from './spikes/demo'
import { VisibleMac } from './mac/visible'
import { RoutingMac } from './browser/routing'
import { WebDriver } from './browser/web'
import { DriveAdapter } from './drive/adapter'
import { parseDriveCall } from '../shared/drive'
import type { Budget } from './loop/budget'

let mac: MacDriver | undefined
export async function macDriver(init: { cuaSdkPath: string; cuaLibraryPath: string }): Promise<MacDriver> {
  if (!mac) mac = MacDriver.open(await loadStagedCua(init.cuaSdkPath, init.cuaLibraryPath))
  return mac
}

let web: WebDriver | undefined
let visible: VisibleMac | undefined
/**
 * The driver the agent's work goes through: Mac apps through Cua and web pages through the agent Chrome, behind one
 * router, with every action announced to the cursor and the island first (spec §9).
 */
async function visibleMac(ctx: HandlerContext): Promise<VisibleMac> {
  if (!web && ctx.init.browserProfileDir) web = new WebDriver(ctx.init.browserProfileDir)
  if (!visible) visible = new VisibleMac(web ? new RoutingMac(await macDriver(ctx.init), web) : await macDriver(ctx.init), ctx.emit)
  return visible
}

const CuaCall = z.object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) })
const AgentRun = z.object({
  task: z.string().trim().min(1).max(2000),
  watch: z.boolean().default(false),
  model: z.string().min(1).default(PHASE0_MODELS.openai),
  excluded: z.array(z.string()).max(100).default([]),
  speed: z.enum(SPEEDS).default('balanced'),
  /** Apps you always allow to come forward for shortcuts (Settings). */
  trusted: z.array(z.string().min(1).max(300)).max(100).default([]),
  /** Full auto (Settings): JevAuto answers its own questions; see RunDeps.auto. */
  auto: z.boolean().default(false),
})
/** Typed text longer than this is approved as shown, not edited in place (the reply carries at most 4000 characters). */
const EDITABLE_MAX = 4000
/** Unanswered approvals expire as a no (spec §8); a question waits longer. */
const APPROVAL_MS = 60_000
const QUESTION_MS = 5 * 60_000

let lessonsStore: Lessons | undefined
/** Tips earlier runs saved about apps and sites, in userData next to the run logs. */
const lessonsOf = (ctx: HandlerContext) => (lessonsStore ??= new Lessons(join(dirname(ctx.init.runsDir), 'lessons.json')))

/** One brain at a time: JevAuto's own task, or Claude Code driving. */
let task: 'run' | undefined
type Session = { adapter: DriveAdapter; controller: AbortController; idle?: NodeJS.Timeout; done: Promise<unknown> }
let session: Session | undefined
/** Where Claude Code may be running: terminals, editors and the Claude app. Never targets while it drives. */
const CLAUDE_CODE_HOSTS = [...DEVELOPER_APPS, 'com.anthropic.claudefordesktop']
/** A Claude Code session ends after this long without a call; the next call starts a new one. */
const DRIVE_IDLE_MS = 3 * 60_000
/** No model is paid for, so only actions and time bound a session. */
const DRIVE_BUDGET: Budget = { maxActions: 2000, maxMs: 2 * 60 * 60_000, maxUsd: 1 }
const DriveSettings = AgentRun.pick({ excluded: true, speed: true, trusted: true, auto: true })

/**
 * The approval and question round trips through main, the island and the activity window. `until` ends a wait early:
 * a Claude Code session's approvals must end on Stop even though the request that started the session is long done.
 */
function asker(ctx: HandlerContext, until?: AbortSignal) {
  return {
    approve: async (approval: Parameters<Parameters<typeof runTask>[0]['approve']>[0]): Promise<Decision> => {
      const id = randomUUID()
      const { appId, text, ...shown } = approval
      const editable = text !== undefined && text.length <= EDITABLE_MAX
      const foreground = approval.kind === 'foreground'
      ctx.emit('ui.approval', { id, ...shown, ...(editable ? { text } : {}), offersRun: foreground, offersAlways: foreground && appId !== undefined })
      const reply = await ctx.waitReply(id, APPROVAL_MS, until)
      ctx.emit('ui.approval-closed', { id })
      const answer = reply?.answer ?? 'deny'
      return editable && typeof reply?.text === 'string' ? { answer, text: reply.text } : answer
    },
    ask: async (question: string) => {
      const id = randomUUID()
      ctx.emit('ui.question', { id, question })
      const reply = await ctx.waitReply(id, QUESTION_MS, until)
      ctx.emit('ui.question-closed', { id })
      return reply?.text?.trim() || null
    },
  }
}

/** `open -g -b <bundle id>`: LaunchServices asks the app to show a window, and the app you use stays in front. */
const reopen = (bundleId: string) =>
  new Promise<void>((resolve, reject) => {
    if (!/^[\w.-]+$/.test(bundleId)) return reject(new Error('not a bundle id'))
    execFile('/usr/bin/open', ['-g', '-b', bundleId], { timeout: 5_000 }, (error) => (error ? reject(error) : resolve()))
  })

const newLog = (runsDir: string) => RunLog.open(runsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)

/**
 * Claude Code driving over MCP: the first call starts a session of JevAuto's own loop with a DriveAdapter as its brain,
 * later calls feed it, and it ends when Claude Code disconnects, after DRIVE_IDLE_MS without a call, or on Stop.
 */
async function driveCall(params: unknown, ctx: HandlerContext) {
  const { call: raw, settings } = z.object({ call: z.unknown(), settings: DriveSettings }).parse(params)
  const parsed = parseDriveCall(raw)
  if (!parsed.ok) return { ok: false, text: parsed.error }
  if (task) return { ok: false, text: 'JevAuto is running one of its own tasks. Wait for it to finish, or press Stop.' }
  // Claude Code may send calls in parallel; the first one makes the session synchronously and the rest queue in it.
  if (!session) session = startSession(settings, ctx)
  const s = session
  clearTimeout(s.idle)
  const result = await s.adapter.submit(parsed.call)
  s.idle = setTimeout(() => s.adapter.end(), DRIVE_IDLE_MS)
  return result
}

function startSession(settings: z.infer<typeof DriveSettings>, ctx: HandlerContext): Session {
  const adapter = new DriveAdapter()
  const controller = new AbortController()
  const log = newLog(ctx.init.runsDir)
  const s: Session = { adapter, controller, done: Promise.resolve() }
  let mac: VisibleMac | undefined
  s.done = (async () => {
    mac = await visibleMac(ctx)
    // Claude Code's user is typing in a terminal, so its sessions never pull apps to the front (Watch or not): only
    // Cinematic and Teach wait for the cursor.
    mac.pace = settings.speed === 'cinematic' || settings.speed === 'teach'
    mac.speed = settings.speed
    return runTask({
      task: 'Claude Code is driving JevAuto',
      adapter,
      mac,
      focus: (pid, windowId) => (web?.isWeb(windowId) ? web.focus(windowId) : readFocus(ctx.init.nativeHelperPath, pid)).catch(() => 'unknown' as const),
      frontmost: () => readFrontmost(ctx.init.nativeHelperPath).catch(() => undefined),
      ...asker(ctx, controller.signal),
      log,
      signal: controller.signal,
      emit: ctx.emit,
      front: false,
      excluded: settings.excluded,
      avoid: DEVELOPER_APPS,
      ...(web ? { web } : {}),
      trusted: settings.trusted,
      trust: (app) => ctx.emit('ui.trust', app),
      auto: settings.auto,
      stall: false,
      budget: DRIVE_BUDGET,
      host: CLAUDE_CODE_HOSTS,
      reopen,
      lessons: lessonsOf(ctx),
      guardKeys: () => guardKeys(ctx.init.nativeHelperPath),
    })
  })()
    // Setup failed before the loop ran (the loop answers its own failures): tell whoever is waiting.
    .catch(async (error) => {
      await adapter.close()
      ctx.emit('drive.failed', { message: error instanceof Error ? error.message : String(error) })
    })
    .finally(() => {
      clearTimeout(s.idle)
      if (mac) {
        mac.pace = false
        mac.speed = 'balanced'
      }
      log.close()
      if (session === s) session = undefined
      ctx.emit('drive.ended', {})
    })
  return s
}

/** Runs one task through the loop, asking you (through main, the island and the activity window) when it must. */
async function agentRun(params: unknown, ctx: HandlerContext) {
  const { task: text, watch, model, excluded, speed, trusted, auto } = AgentRun.parse(params)
  if (session || task) throw new Error(session ? 'Claude Code is driving JevAuto right now. Try again when it is done.' : 'A task is already running.')
  task = 'run' // set before any await, so a Claude Code call can't start a session in between
  let log: RunLog | undefined
  let mac: VisibleMac | undefined
  try {
    ctx.takeSteers() // anything said to a task that already ended is not for this one
    const adapter = adapterFor(model, instructionsFor(auto), ctx.init.keys ?? {})
    log = newLog(ctx.init.runsDir)
    mac = await visibleMac(ctx)
    // Watch mode waits for the cursor; so do Cinematic and Teach, whose whole point is that you can follow it.
    mac.pace = watch || speed === 'cinematic' || speed === 'teach'
    mac.speed = speed
    const result = await runTask({
      task: text,
      adapter,
      mac,
      focus: (pid, windowId) => (web?.isWeb(windowId) ? web.focus(windowId) : readFocus(ctx.init.nativeHelperPath, pid)).catch(() => 'unknown' as const),
      frontmost: () => readFrontmost(ctx.init.nativeHelperPath).catch(() => undefined),
      ...asker(ctx),
      log,
      signal: ctx.signal,
      emit: ctx.emit,
      front: watch,
      excluded,
      avoid: DEVELOPER_APPS,
      ...(web ? { web } : {}),
      ...(ctx.init.keys?.typesafe ? { shadow: jevShadow(ctx.init.keys.typesafe) } : {}),
      trusted,
      trust: (app) => ctx.emit('ui.trust', app),
      steer: () => ctx.takeSteers(),
      reopen,
      lessons: lessonsOf(ctx),
      guardKeys: () => guardKeys(ctx.init.nativeHelperPath),
      ...(auto ? { auto, budget: FULL_AUTO_BUDGET } : {}),
    })
    return { ...result, log: log.path }
  } finally {
    task = undefined
    if (mac) {
      mac.pace = false
      mac.speed = 'balanced'
    }
    log?.close()
  }
}

export const handlers: Partial<Record<AgentMethod, Handler>> = {
  ping: async () => ({ pong: true, pid: process.pid }),
  'agent.run': agentRun,
  'drive.call': driveCall,
  'drive.end': async () => {
    const s = session
    s?.adapter.end()
    await s?.done
    return { ended: Boolean(s) }
  },
  'lessons.list': async (_params, ctx) => lessonsOf(ctx).all(),
  'lessons.forget': async (params, ctx) => {
    const { app, tip } = z.object({ app: z.string().max(100), tip: z.string().max(300) }).parse(params)
    return { removed: lessonsOf(ctx).remove(app, tip) }
  },
  'drive.stop': async () => {
    session?.controller.abort()
    return { stopped: Boolean(session) }
  },
  'spike.demo': async (_params, ctx) => runDemo(await visibleMac(ctx), ctx.emit, ctx.init, ctx.signal),
  'spike.stop.type': async (_params, ctx) => startLongType(await visibleMac(ctx)),
  'spike.b.capture': async (params, ctx) => spikeBCapture(await visibleMac(ctx), SpikeBParams.parse(params)),
  'spike.a': async (params, ctx) => runSpikeA(await visibleMac(ctx), ctx.init, SpikeAParams.parse(params ?? {}), ctx.signal),
  'permissions.check': async (_params, ctx) => {
    const mac = await macDriver(ctx.init)
    const permissions = await mac.call('check_permissions', { prompt: false })
    // A real capture attempt is what makes macOS list JevAuto under Screen Recording (critic M13).
    const capture = await mac.call('get_desktop_state', {})
    const s = (permissions.structured ?? {}) as { accessibility?: boolean; screen_recording?: boolean; source?: unknown }
    return {
      accessibility: s.accessibility === true,
      screenRecording: s.screen_recording === true,
      source: s.source ?? null,
      captureOk: !capture.isError && capture.imageCount > 0,
      captureError: capture.isError ? capture.text.slice(0, 300) : null,
    }
  },
  'cua.call': async (params, ctx) => {
    const { name, args } = CuaCall.parse(params)
    const result = await (await macDriver(ctx.init)).call(name, args, ctx.signal)
    return { ...result, images: [] } // screenshots stay in the agent
  },
}

export async function shutdown(): Promise<void> {
  await web?.close()
  web = undefined
  await mac?.close()
  mac = undefined
  visible = undefined
}
