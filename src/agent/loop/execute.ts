import { canvasToCapture, normalized1000ToCanvas, type Point } from '../frame/frame'
import type { ElementInfo } from '../mac/results'
import type { Mac } from '../mac/visible'
import type { IrAction, IrPoint, Space } from '../providers/ir'
import type { Focus } from '../../shared/native'
import { modifierName, toCuaKeys } from './keys'
import type { Observation } from './observe'

export type CuaCall = { tool: string; args: Record<string, unknown> }
/** What one IR action becomes. `point` is where it lands, in screen points, for the gate and the cursor. */
export type Plan =
  | { kind: 'cua'; calls: CuaCall[]; point?: Point }
  | { kind: 'wait'; ms: number }
  | { kind: 'noop'; note: string }
  | { kind: 'error'; message: string }

/** `escalation` is Cua's own verdict when it posted input it could not deliver ("delivery_failed"). */
export type ExecResult = { ok: boolean; message?: string; code?: string; effect?: string; escalation?: string }

/** Model point → pixels of the window capture (Cua's coordinates) and screen points; null on the letterbox padding. */
function locate(p: IrPoint, space: Space, obs: Observation): { px: Point; screen: Point } | null {
  const { frame } = obs
  const canvasPoint = space === 'normalized1000' ? normalized1000ToCanvas(p, frame.letterbox.canvas) : p
  const c = canvasToCapture(canvasPoint, frame.letterbox, frame.capture)
  if (!c) return null
  const px = { x: Math.round(c.x), y: Math.round(c.y) }
  return { px, screen: { x: frame.originPoints.x + px.x / frame.pixelsPerPoint, y: frame.originPoints.y + px.y / frame.pixelsPerPoint } }
}

function heldModifiers(keys: string[] | undefined): string[] | { error: string } {
  const out: string[] = []
  for (const k of keys ?? []) {
    const m = modifierName(k)
    if (!m) return { error: `Only modifier keys (cmd, shift, option, ctrl) can be held during a pointer action, not "${k}".` }
    if (!out.includes(m)) out.push(m)
  }
  return out
}

const outside = (p: IrPoint): Plan => ({ kind: 'error', message: `(${p.x}, ${p.y}) is outside the window, on the black padding. Nothing was done.` })

/** One scroll line is about 12 points in AppKit views; Cua takes 1–50 wheel notches. */
function notches(canvasPixels: number, obs: Observation): number {
  const points = Math.abs(canvasPixels) / obs.frame.letterbox.scale.y / obs.frame.pixelsPerPoint
  return Math.min(50, Math.max(1, Math.round(points / 12)))
}

export function planAction(a: IrAction, obs: Observation): Plan {
  const target = { pid: obs.target.pid, window_id: obs.target.windowId }
  switch (a.kind) {
    case 'click': {
      const at = locate(a, a.space, obs)
      if (!at) return outside(a)
      const modifier = heldModifiers(a.keys)
      if (!Array.isArray(modifier)) return { kind: 'error', message: modifier.error }
      const args: Record<string, unknown> = { ...target, x: at.px.x, y: at.px.y }
      if (a.button !== 'left') args.button = a.button
      if ((a.count ?? 1) > 1) args.count = a.count
      if (modifier.length) args.modifier = modifier
      return { kind: 'cua', calls: [{ tool: 'click', args }], point: at.screen }
    }
    case 'drag': {
      const from = locate(a.path[0], a.space, obs)
      const to = locate(a.path[a.path.length - 1], a.space, obs)
      if (!from) return outside(a.path[0])
      if (!to) return outside(a.path[a.path.length - 1])
      const modifier = heldModifiers(a.keys)
      if (!Array.isArray(modifier)) return { kind: 'error', message: modifier.error }
      const args: Record<string, unknown> = { ...target, from_x: from.px.x, from_y: from.px.y, to_x: to.px.x, to_y: to.px.y }
      if (modifier.length) args.modifier = modifier
      return { kind: 'cua', calls: [{ tool: 'drag', args }], point: from.screen }
    }
    case 'scroll': {
      const at = locate(a, a.space, obs)
      if (!at) return outside(a)
      if (a.keys?.length) return { kind: 'error', message: 'Scrolling with keys held is not supported.' }
      const calls: CuaCall[] = []
      if (a.dy) calls.push({ tool: 'scroll', args: { ...target, x: at.px.x, y: at.px.y, direction: a.dy > 0 ? 'down' : 'up', amount: notches(a.dy, obs) } })
      if (a.dx) calls.push({ tool: 'scroll', args: { ...target, x: at.px.x, y: at.px.y, direction: a.dx > 0 ? 'right' : 'left', amount: notches(a.dx, obs) } })
      return calls.length ? { kind: 'cua', calls, point: at.screen } : { kind: 'noop', note: 'A scroll of zero does nothing.' }
    }
    case 'keys': {
      const k = toCuaKeys(a.keys)
      if ('error' in k) return { kind: 'error', message: k.error }
      return { kind: 'cua', calls: [k.tool === 'hotkey' ? { tool: 'hotkey', args: { ...target, keys: k.keys } } : { tool: 'press_key', args: { ...target, key: k.key } }] }
    }
    case 'type':
      return planType(a.text, obs, undefined)
    case 'wait':
      return { kind: 'wait', ms: 1000 }
    case 'move':
      return { kind: 'noop', note: 'The pointer cannot hover in the background; nothing moved.' }
    case 'screenshot':
      return { kind: 'noop', note: 'Screenshot taken.' }
    case 'tool':
    case 'other':
      return { kind: 'error', message: `"${a.name}" is not an action JevAuto supports.` }
  }
}

/**
 * Text goes into an exact element when AX can place the focus in this window's snapshot: Cua refuses process-wide
 * typing whenever the app has another window (same_pid_keyboard_ambiguity).
 */
export function planType(text: string, obs: Observation, element: ElementInfo | undefined): Plan {
  const target = { pid: obs.target.pid, window_id: obs.target.windowId }
  if (element && obs.snapshotId)
    return { kind: 'cua', calls: [{ tool: 'type_text', args: { ...target, element_index: element.element_index, snapshot_id: obs.snapshotId, text } }] }
  return { kind: 'cua', calls: [{ tool: 'type_text', args: { ...target, text } }] }
}

const within = (a: number, b: number) => Math.abs(a - b) <= 1.5

/** The snapshot element AX says has keyboard focus: same role, same frame. */
export function focusedElement(focus: Focus, elements: ElementInfo[]): ElementInfo | undefined {
  const f = focus.frame
  if (!focus.ok || !f || !focus.role) return undefined
  return elements.find(
    (e) => e.role === focus.role && e.frame && within(e.frame.x, f.x) && within(e.frame.y, f.y) && within(e.frame.width, f.width) && within(e.frame.height, f.height),
  )
}

const CONTAINERS = new Set(['AXWindow', 'AXApplication', 'AXMenuBar'])

/** The smallest element under a screen point: what a click there would hit, as far as the snapshot can tell. */
export function elementAt(p: Point, elements: ElementInfo[]): ElementInfo | undefined {
  let best: ElementInfo | undefined
  for (const e of elements) {
    const f = e.frame
    if (!f || CONTAINERS.has(e.role) || p.x < f.x || p.y < f.y || p.x >= f.x + f.width || p.y >= f.y + f.height) continue
    if (!best?.frame || f.width * f.height < best.frame.width * best.frame.height) best = e
  }
  return best
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true })
  })

/** Runs a plan's Cua calls in order and stops at the first refusal or error. */
export async function runPlan(plan: Plan, mac: Mac, signal: AbortSignal): Promise<ExecResult> {
  if (plan.kind === 'error') return { ok: false, message: plan.message }
  if (plan.kind === 'noop') return { ok: true, message: plan.note }
  if (plan.kind === 'wait') {
    await sleep(plan.ms, signal)
    return { ok: true }
  }
  let effect: string | undefined
  let escalation: string | undefined
  for (const call of plan.calls) {
    const r = await mac.call(call.tool, call.args, signal)
    const s = (r.structured ?? {}) as { code?: string; effect?: string; escalation?: { reason?: string } }
    if (r.isError) return { ok: false, message: r.text.slice(0, 400), code: s.code ?? r.errorCode, effect: s.effect }
    effect = s.effect ?? effect
    escalation = s.escalation?.reason ?? escalation
  }
  return { ok: true, effect, ...(escalation ? { escalation } : {}) }
}

/** The same calls, delivered by briefly bringing the window forward (spec §4: only after the user's OK). */
export function inForeground(plan: Plan): Plan {
  return plan.kind === 'cua' ? { ...plan, calls: plan.calls.map((c) => ({ ...c, args: { ...c.args, delivery_mode: 'foreground' } })) } : plan
}
