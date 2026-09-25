import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Handler, HandlerContext } from './agent'
import type { AgentMethod } from '../shared/protocol'
import { PHASE0_MODELS } from '../shared/constants'
import { SPEEDS } from '../shared/motion'
import { readFocus, readFrontmost } from '../shared/native'
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

/** Runs one task through the loop, asking you (through main, the island and the activity window) when it must. */
async function agentRun(params: unknown, ctx: HandlerContext) {
  const { task, watch, model, excluded, speed, trusted, auto } = AgentRun.parse(params)
  ctx.takeSteers() // anything said to a task that already ended is not for this one
  const adapter = adapterFor(model, instructionsFor(auto), ctx.init.keys ?? {})
  const log = RunLog.open(ctx.init.runsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  const mac = await visibleMac(ctx)
  // Watch mode waits for the cursor; so do Cinematic and Teach, whose whole point is that you can follow it.
  mac.pace = watch || speed === 'cinematic' || speed === 'teach'
  mac.speed = speed
  try {
    const result = await runTask({
      task,
      adapter,
      mac,
      focus: (pid, windowId) => (web?.isWeb(windowId) ? web.focus(windowId) : readFocus(ctx.init.nativeHelperPath, pid)).catch(() => 'unknown' as const),
      frontmost: () => readFrontmost(ctx.init.nativeHelperPath).catch(() => undefined),
      approve: async (approval): Promise<Decision> => {
        const id = randomUUID()
        const { appId, text, ...shown } = approval
        const editable = text !== undefined && text.length <= EDITABLE_MAX
        const foreground = approval.kind === 'foreground'
        ctx.emit('ui.approval', { id, ...shown, ...(editable ? { text } : {}), offersRun: foreground, offersAlways: foreground && appId !== undefined })
        const reply = await ctx.waitReply(id, APPROVAL_MS)
        ctx.emit('ui.approval-closed', { id })
        const answer = reply?.answer ?? 'deny'
        return editable && typeof reply?.text === 'string' ? { answer, text: reply.text } : answer
      },
      ask: async (question) => {
        const id = randomUUID()
        ctx.emit('ui.question', { id, question })
        const reply = await ctx.waitReply(id, QUESTION_MS)
        ctx.emit('ui.question-closed', { id })
        return reply?.text?.trim() || null
      },
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
      ...(auto ? { auto, budget: FULL_AUTO_BUDGET } : {}),
    })
    return { ...result, log: log.path }
  } finally {
    mac.pace = false
    mac.speed = 'balanced'
    log.close()
  }
}

export const handlers: Partial<Record<AgentMethod, Handler>> = {
  ping: async () => ({ pong: true, pid: process.pid }),
  'agent.run': agentRun,
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
