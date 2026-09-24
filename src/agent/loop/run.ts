import { windowsOf, windowStateOf, type ElementInfo } from '../mac/results'
import type { Mac } from '../mac/visible'
import type { IrAction } from '../providers/ir'
import { costUsd } from '../providers/prices'
import type { Focus } from '../../shared/native'
import type { Adapter, CallResult, Turn } from './adapter'
import { DEFAULT_BUDGET, Meter, type Budget, type Limit } from './budget'
import { describeAction } from './describe'
import { elementAt, focusedElement, inForeground, planAction, planType, runPlan, type ExecResult, type Plan } from './execute'
import { gate } from './gate'
import { needsFront } from './keys'
import { blankCanvas, observe, ObserveError, sameView, type Observation, type Target } from './observe'
import { describeWindow, Targets, type Window } from './targets'
import { ToolInput, type ToolName } from './tools'

export type Approval = { kind: 'action' | 'foreground' | 'budget'; title: string; reason: string; app?: string }
/** 'run' allows this kind of step in this app for the rest of the run; only foreground delivery offers it. */
export type Answer = 'once' | 'run' | 'deny'
export type RunStatus = 'success' | 'failure' | 'blocked' | 'ended' | 'stopped' | 'budget' | 'stall' | 'refused' | 'error'
export type RunResult = { status: RunStatus; summary: string; turns: number; actions: number; usd: number; ms: number }

export type RunDeps = {
  task: string
  adapter: Adapter
  /** Cua, usually through VisibleMac so the cursor and the island see every action. */
  mac: Mac
  /** Where keystrokes for a pid go (JevNative ax-focus); 'unknown' when it can't tell. */
  focus: (pid: number) => Promise<Focus | 'unknown'>
  approve: (approval: Approval) => Promise<Answer>
  ask: (question: string) => Promise<string | null>
  log: { write(event: string, data?: Record<string, unknown>): void }
  signal: AbortSignal
  budget?: Budget
  excluded?: string[]
  /** Bundle ids never picked as the first target (the terminal running the CLI, for one). */
  avoid?: string[]
  /** Bring each new target to the front, to watch the run. Off by default: JevAuto works in the background. */
  front?: boolean
  emit?: (name: string, data: unknown) => void
  now?: () => number
  /** The app you are using (JevNative), so it comes back to the front after JevAuto borrows it for a shortcut. */
  frontmost?: () => Promise<{ pid: number } | undefined>
}

type Call = { callId: string; kind: 'computer' | 'function'; actions: IrAction[] }
type Tool = Extract<IrAction, { kind: 'tool' }>
type Ended = { status: RunStatus; summary: string }
type Step = { acted?: boolean; note?: string; halt?: string; stop?: Ended; acknowledged?: unknown[]; targetChanged?: boolean }

const POINTER = new Set<IrAction['kind']>(['click', 'drag', 'scroll', 'move'])
const ACTING = new Set<IrAction['kind']>(['click', 'drag', 'scroll', 'type', 'keys'])
const NOT_EXECUTED = 'Not executed: an earlier action in this turn failed.'
const GONE = new Set(['window_id_not_found', 'window_owner_pid_mismatch'])

/** One entry per call, in the order the model made them; a batch of actions shares its call. */
export function groupCalls(actions: IrAction[]): Call[] {
  const calls: Call[] = []
  for (const a of actions) {
    const kind = a.kind === 'tool' ? 'function' : 'computer'
    const last = calls.find((c) => c.callId === a.callId && c.kind === kind)
    if (last) last.actions.push(a)
    else calls.push({ callId: a.callId, kind, actions: [a] })
  }
  return calls
}

function friendly(error: unknown): string {
  const status = (error as { status?: number })?.status
  if (status === 401) return 'The model provider rejected the API key.'
  if (status === 403) return 'The model provider refused the request (403).'
  if (status === 429) return 'The model provider’s rate limit was reached. Try again in a minute.'
  if (typeof status === 'number' && status >= 500) return 'The model provider had a server error. Try again.'
  if (error instanceof ObserveError) return `JevAuto could not see the window: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

const sameElement = (a: ElementInfo, b: ElementInfo | undefined) =>
  !!b && a.role === b.role && (a.label ?? '') === (b.label ?? '') && !!a.frame && !!b.frame &&
  Math.abs(a.frame.x - b.frame.x) <= 2 && Math.abs(a.frame.y - b.frame.y) <= 2 &&
  Math.abs(a.frame.width - b.frame.width) <= 2 && Math.abs(a.frame.height - b.frame.height) <= 2

const LIMITS: Record<Limit, string> = { actions: 'actions', time: 'minutes', cost: 'dollars' }

/** The core loop (spec §11): observe, ask the model, gate and run each action in order, answer every call. */
export async function runTask(d: RunDeps): Promise<RunResult> {
  const { adapter, signal } = d
  const now = d.now ?? (() => performance.now())
  const started = now()
  const meter = new Meter(d.budget ?? DEFAULT_BUDGET, now)
  const targets = new Targets(d.mac, d.excluded)
  const foreground = new Set<number>()
  /** While a turn has the target in front for shortcuts: the window in front and the app to give the front back to. */
  let front: { windowId: number; restorePid?: number } | undefined
  let target: Target | undefined
  let obs: Observation | undefined
  let snap: { id?: string; elements: ElementInfo[]; probes: number } = { elements: [], probes: 0 }
  let turns = 0
  let stall = 0

  const announce = (state: string, title: string, detail?: string) => d.emit?.('ui.status', { state, title, ...(detail ? { detail } : {}) })
  const finish = (status: RunStatus, summary: string): RunResult => {
    const result = { status, summary, turns, actions: meter.actions, usd: Math.round(meter.usd * 10_000) / 10_000, ms: Math.round(now() - started) }
    d.log.write('run.end', result)
    const state = status === 'stopped' ? 'stopped' : ['success', 'ended'].includes(status) ? 'done' : 'error'
    announce(state, state === 'done' ? 'Done' : state === 'stopped' ? 'Stopped' : 'Could not finish', summary)
    return result
  }

  async function approval(a: Approval): Promise<Answer> {
    meter.pause()
    announce('needs-you', a.title, a.reason)
    try {
      const answer = await d.approve(a)
      d.log.write('approval', { ...a, answer })
      return answer
    } finally {
      meter.resume()
      signal.throwIfAborted()
      announce('working', d.task)
    }
  }

  async function refreshSnap() {
    if (!target) return
    const r = await d.mac.call('get_window_state', { pid: target.pid, window_id: target.windowId, include_screenshot: false }, signal)
    if (r.isError) return
    const state = windowStateOf(r.structured)
    snap = { id: state.snapshotId, elements: state.elements, probes: targets.probes }
  }

  async function retarget(w: Target) {
    target = { pid: w.pid, windowId: w.windowId, app: w.app, title: w.title, bundleId: w.bundleId }
    if (d.front) await d.mac.call('bring_to_front', { pid: w.pid, window_id: w.windowId }, signal)
    await refreshSnap()
    d.log.write('target', { ...target })
  }

  async function look(): Promise<string | undefined> {
    if (!target) {
      obs = undefined
      return undefined
    }
    try {
      obs = await observe(d.mac, target, adapter.canvas, signal)
      snap = { id: obs.snapshotId, elements: obs.elements, probes: targets.probes }
      target = obs.target
      d.log.write('observe', { window: target.windowId, title: obs.title, capture: obs.frame.capture })
      return undefined
    } catch (error) {
      if (!(error instanceof ObserveError) || !GONE.has(error.code ?? '')) throw error
      const gone = target
      const fallback = targets.allowed(await targets.windows(signal)).find((w) => w.pid === gone.pid)
      target = undefined
      obs = undefined
      if (!fallback) return `${describeWindow(gone)} closed. No window is targeted now; use open_app or switch_target.`
      await retarget(fallback)
      await look()
      return `${describeWindow(gone)} closed. The target is now ${describeWindow(fallback)}.`
    }
  }

  /** Brings the target forward (once per turn) and sends the plan as real key presses (spec §4, after your OK). */
  async function inFront(t: Target, plan: Plan): Promise<ExecResult> {
    if (front?.windowId !== t.windowId) {
      const before = front?.restorePid ?? (await d.frontmost?.().catch(() => undefined))?.pid
      await d.mac.call('bring_to_front', { pid: t.pid, window_id: t.windowId }, signal)
      front = { windowId: t.windowId, restorePid: before !== undefined && before !== t.pid ? before : undefined }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return runPlan(inForeground(plan), d.mac, signal)
  }

  /** Gives the front back to the app you were using, once the turn is over. */
  async function restoreFront() {
    const pid = front?.restorePid
    front = undefined
    if (pid === undefined) return
    const w = (await targets.windows(signal)).find((x) => x.pid === pid)
    if (w) await d.mac.call('bring_to_front', { pid, window_id: w.windowId }, signal)
  }

  async function boundsOf(t: Target) {
    const r = await d.mac.call('list_windows', { pid: t.pid }, signal)
    return windowsOf(r.structured).find((w) => w.window_id === t.windowId)?.bounds
  }

  function context(windows: Window[]): string {
    const others = windows.filter((w) => w.windowId !== target?.windowId).slice(0, 10).map(describeWindow)
    const list = others.length ? `\nOther windows: ${others.join('; ')}.` : ''
    return target
      ? `The target window is ${describeWindow(target)}. The screenshot shows only this window.${list}`
      : `No window is targeted yet. Use open_app, or switch_target with one of these windows.${list}`
  }

  async function runTool(a: Tool): Promise<{ output: unknown; changedTarget?: boolean; ended?: Ended }> {
    const schema = ToolInput[a.name as ToolName]
    if (!schema) return { output: { error: `There is no function called ${a.name}.` } }
    const parsed = schema.safeParse(a.input)
    if (!parsed.success) return { output: { error: `Invalid arguments for ${a.name}: ${parsed.error.issues.map((i) => i.message).join('; ')}` } }
    const input = parsed.data as Record<string, unknown>
    switch (a.name as ToolName) {
      case 'list_windows': {
        const windows = targets.allowed(await targets.windows(signal))
        return { output: { target: target?.windowId ?? null, windows: windows.slice(0, 30).map((w) => ({ window_id: w.windowId, app: w.app, title: w.title })) } }
      }
      case 'switch_target': {
        const w = (await targets.windows(signal)).find((x) => x.windowId === input.window_id)
        if (!w) return { output: { error: 'No window with that id is on screen. Call list_windows.' } }
        const why = targets.exclusion(w)
        if (why) return { output: { error: why } }
        await retarget(w)
        return { output: { ok: true, target: describeWindow(w) }, changedTarget: true }
      }
      case 'open_app':
        return openApp(String(input.name))
      case 'ask_user': {
        meter.pause()
        announce('needs-you', 'A question for you', String(input.question))
        const answer = await d.ask(String(input.question))
        meter.resume()
        signal.throwIfAborted()
        announce('working', d.task)
        d.log.write('ask', { question: input.question, answered: answer !== null })
        return { output: answer === null ? { answer: null, note: 'The user did not answer.' } : { answer } }
      }
      case 'done':
        return { output: { ok: true }, ended: { status: input.status as RunStatus, summary: String(input.summary) } }
    }
  }

  async function openApp(name: string): Promise<{ output: unknown; changedTarget?: boolean }> {
    let app = targets.findApp(name)
    if (!app) {
      await targets.refreshApps(signal)
      app = targets.findApp(name)
    }
    if (!app) return { output: { error: `No app called “${name}” is installed.` } }
    const why = targets.exclusion({ pid: app.pid, windowId: 0, app: app.name, bundleId: app.bundleId })
    if (why) return { output: { error: why } }
    const before = await targets.windows(signal)
    const existing = targets.allowed(before).find((w) => w.pid === app.pid && app.running)
    if (existing) {
      await retarget(existing)
      return { output: { ok: true, target: describeWindow(existing) }, changedTarget: true }
    }
    const known = new Set(before.map((w) => w.windowId))
    const r = await d.mac.call('launch_app', app.bundleId ? { bundle_id: app.bundleId } : { name: app.name }, signal)
    if (r.isError) return { output: { error: r.text.slice(0, 300) } }
    const pid = (r.structured as { pid?: number })?.pid
    for (let i = 0; i < 24; i++) {
      const windows = targets.allowed(await targets.windows(signal))
      const w = windows.find((x) => x.pid === pid && !known.has(x.windowId)) ?? windows.find((x) => x.pid === pid)
      if (w) {
        await retarget(w)
        return { output: { ok: true, target: describeWindow(w) }, changedTarget: true }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
      signal.throwIfAborted()
    }
    return { output: { error: `${app.name} opened but showed no window.` } }
  }

  /** Gate and run one action. Everything that reaches Cua passes through here (spec §8). */
  async function act(a: IrAction, safety: unknown[]): Promise<Step> {
    if (!target || !obs) {
      if (a.kind === 'wait' || a.kind === 'screenshot') return {}
      return { halt: 'no window is targeted; use open_app or switch_target first' }
    }
    const t = target
    let focus: Focus | 'unknown' | undefined
    let element: ElementInfo | undefined
    let plan: Plan
    if (a.kind === 'type' || a.kind === 'keys') {
      focus = await d.focus(t.pid)
      // Another window was snapshotted since ours; Cua may treat our element indexes as stale, so read them again.
      if (a.kind === 'type' && snap.probes !== targets.probes) await refreshSnap()
      const view = { ...obs, target: t, snapshotId: snap.id, elements: snap.elements }
      if (a.kind === 'type') {
        element = focus === 'unknown' ? undefined : focusedElement(focus, snap.elements)
        if (!element && focus !== 'unknown' && focus.ok) {
          await refreshSnap()
          element = focusedElement(focus, snap.elements)
        }
        plan = planType(a.text, { ...view, snapshotId: snap.id, elements: snap.elements }, element)
      } else plan = planAction(a, view)
    } else {
      plan = planAction(a, obs)
      if (plan.kind === 'cua' && plan.point) element = elementAt(plan.point, obs.elements)
    }
    const desc = describeAction(a, element)
    if (plan.kind === 'error') return { halt: plan.message.replace(/\.$/, '') }

    const verdict = gate({ action: a, target: t, element, focus, safety, excluded: d.excluded })
    d.log.write('gate', { action: desc, ...verdict })
    if (verdict.decision === 'refuse') return { halt: `${desc} was refused: ${verdict.reason}` }
    let acknowledged: unknown[] | undefined
    if (verdict.decision === 'ask') {
      const answer = await approval({ kind: 'action', title: `${desc[0].toUpperCase()}${desc.slice(1)} in ${t.app}`, reason: verdict.reason, app: t.app })
      if (answer === 'deny')
        return safety.length ? { stop: { status: 'stopped', summary: `You declined: ${desc}.` } } : { halt: `the user declined: ${desc}. Do not try another way to do this` }
      if (safety.length) acknowledged = safety
      // Re-resolve the target after the wait: what you approved must still be what gets clicked (spec §8).
      if (plan.kind === 'cua' && plan.point && element) {
        await refreshSnap()
        if (!sameElement(element, elementAt(plan.point, snap.elements)))
          return { halt: 'the screen changed while waiting for approval, so the step was not run', acknowledged }
      }
    }
    if (ACTING.has(a.kind) && meter.over() === 'actions') return { halt: 'the action budget is used up', acknowledged }
    if (plan.kind === 'cua' && plan.point) {
      const bounds = await boundsOf(t)
      if (!bounds || Math.abs(bounds.width - obs.bounds.width) > 1 || Math.abs(bounds.height - obs.bounds.height) > 1)
        return { halt: 'the window changed size since the screenshot; look again', acknowledged }
    }

    // Shortcuts never reach a background app, and Cua refuses keys and typing for an app with several windows; both
    // work with the window in front, which needs your OK (spec §4). Cua's foreground delivery drops ⌘ unless the app
    // really is frontmost, so the window is brought forward first.
    const shortcut = a.kind === 'keys' && needsFront(a.keys)
    let result = shortcut ? undefined : await runPlan(plan, d.mac, signal)
    const undelivered = !result || (!result.ok && result.code === 'same_pid_keyboard_ambiguity') || result.escalation === 'delivery_failed'
    // Modifier clicks and some drags are refused in the background (spec §4: "foreground, with your OK").
    const pointerRefused = POINTER.has(a.kind) && result !== undefined && !result.ok && result.code === 'background_unavailable'
    if (((a.kind === 'keys' || a.kind === 'type') && undelivered) || pointerRefused) {
      let allowed = foreground.has(t.pid)
      if (!allowed) {
        const answer = await approval({
          kind: 'foreground',
          title: `Bring ${t.app} forward for a moment?`,
          reason: `${pointerRefused ? `This only works in ${t.app}` : `${shortcut ? 'Keyboard shortcuts' : 'Keys'} only reach ${t.app}`} while it is in front, so JevAuto brings it forward to ${desc}, then puts your app back.`,
          app: t.app,
        })
        if (answer === 'run') foreground.add(t.pid)
        allowed = answer !== 'deny'
      }
      if (!allowed) return { halt: `the user did not allow bringing ${t.app} forward, so ${desc} was not run`, acknowledged }
      result = await inFront(t, plan)
    }
    if (!result) return { halt: `${desc} was not run`, acknowledged }
    if (ACTING.has(a.kind)) meter.addAction()
    d.log.write('action', { action: desc, app: t.app, ok: result.ok, code: result.code, effect: result.effect })
    if (!result.ok) return { halt: `${desc} failed: ${result.message ?? 'no reason given'}`, acknowledged, acted: false }

    const notes: string[] = []
    if (plan.kind === 'noop' && a.kind !== 'screenshot') notes.push(plan.note)
    if (a.kind === 'type' && focus !== 'unknown' && focus?.webArea) notes.push('The app could not confirm the text arrived; check the screenshot.')
    let targetChanged = false
    if (ACTING.has(a.kind)) {
      const next = await targets.follow(t, signal)
      if (next) {
        await retarget(next)
        notes.push(`A new window opened: ${describeWindow(next)}. It is now the target.`)
        targetChanged = true
      }
    }
    return { acted: ACTING.has(a.kind), acknowledged, targetChanged, ...(notes.length ? { note: notes.join(' ') } : {}) }
  }

  async function runTurn(turn: Turn): Promise<{ results: CallResult[]; notes: string[]; acted: boolean; ended?: Ended }> {
    const results: CallResult[] = []
    const notes: string[] = []
    const notRun: string[] = []
    let halted: string | undefined
    let ended: Ended | undefined
    let targetChanged = false
    let acted = false
    for (const call of groupCalls(turn.actions)) {
      if (call.kind === 'function') {
        const tool = call.actions[0] as Tool
        if (halted || ended) {
          results.push({ callId: call.callId, kind: 'function', output: JSON.stringify({ error: ended ? 'Not executed: the task was already finished.' : NOT_EXECUTED }) })
          continue
        }
        const out = await runTool(tool)
        d.log.write('tool', { name: tool.name, output: out.output })
        results.push({ callId: call.callId, kind: 'function', output: JSON.stringify(out.output) })
        if (out.changedTarget) targetChanged = true
        if (out.ended) ended = out.ended
        continue
      }
      let safety = turn.safety.filter((s) => s.callId === call.callId).flatMap((s) => (Array.isArray(s.detail) ? s.detail : [s.detail]))
      let acknowledged: unknown[] | undefined
      for (const a of call.actions) {
        if (halted || ended) {
          notRun.push(describeAction(a))
          continue
        }
        signal.throwIfAborted()
        if (POINTER.has(a.kind) && targetChanged) {
          halted = 'the target window changed, so coordinates from the old screenshot no longer apply'
          notRun.push(describeAction(a))
          continue
        }
        const step = await act(a, safety)
        if (step.acknowledged) {
          acknowledged = step.acknowledged
          safety = []
        }
        if (step.stop) return { results, notes, acted, ended: step.stop }
        if (step.acted) acted = true
        if (step.note) notes.push(step.note)
        if (step.targetChanged) targetChanged = true
        if (step.halt) halted = step.halt
      }
      results.push({ callId: call.callId, kind: 'computer', ...(acknowledged ? { acknowledged } : {}) })
    }
    if (halted) notes.push(`Stopped this turn: ${halted}.${notRun.length ? ` Not run: ${notRun.join('; ')}.` : ''}`)
    return { results, notes, acted, ended }
  }

  try {
    if (costUsd(adapter.model, { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }) === undefined)
      return finish('error', `No price is known for ${adapter.model}, so the cost budget cannot be kept.`)
    meter.start()
    await targets.refreshApps(signal)
    const first = await targets.initial(d.avoid ?? [], signal)
    const windows = targets.allowed(await targets.windows(signal))
    if (first) {
      await retarget(first)
      await look()
    }
    const opening = context(windows)
    d.log.write('run.start', { task: d.task, provider: adapter.provider, model: adapter.model, budget: d.budget ?? DEFAULT_BUDGET, target: target ?? null, context: opening })
    announce('working', d.task)
    let turn = await adapter.start({ task: d.task, context: opening, image: obs?.image }, signal)
    for (;;) {
      turns += 1
      meter.addCost(costUsd(adapter.model, turn.usage) ?? 0)
      d.log.write('turn', { n: turns, id: turn.id, usage: turn.usage, usd: meter.usd, text: turn.text, refusal: turn.refusal, actions: turn.actions.map((a) => describeAction(a)) })
      if (turn.text.length) announce('working', d.task, turn.text.join(' ').slice(0, 140))
      if (turn.refusal) return finish('refused', turn.text.join(' ').trim() || 'The model declined this task.')
      if (!turn.actions.length) return finish('ended', turn.text.join(' ').trim() || 'The model stopped without a summary.')

      const before = obs
      const { results, notes, acted, ended } = await runTurn(turn).finally(restoreFront)
      if (ended) return finish(ended.status, ended.summary)
      const moved = await look()
      if (moved) notes.push(moved)
      if (obs?.axMissing) notes.push(`${obs.target.app} did not answer accessibility queries in time, so this screenshot is all JevAuto can see of it.`)
      if (acted && before && obs && before.target.windowId === obs.target.windowId && sameView(before, obs)) stall += 1
      else if (acted) stall = 0
      if (stall >= 3) return finish('stall', 'The window stopped changing after three rounds of actions, so JevAuto stopped.')
      if (stall > 0) notes.push('The window looks the same as before your last actions.')
      const over = meter.over()
      if (over) {
        const answer = await approval({ kind: 'budget', title: 'Budget reached', reason: `This run used its ${LIMITS[over]} budget. Keep going?` })
        if (answer === 'deny') return finish('budget', `Stopped at the ${LIMITS[over]} budget.`)
        meter.extend(over)
      }
      turn = await adapter.next({ results, image: obs?.image ?? (await blankCanvas(adapter.canvas)), notes }, signal)
    }
  } catch (error) {
    if (signal.aborted) return finish('stopped', 'Stopped by you.')
    d.log.write('error', { message: friendly(error) })
    return finish('error', friendly(error))
  }
}
