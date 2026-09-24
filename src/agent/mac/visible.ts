import { windowsOf, windowStateOf, type ElementInfo, type WindowInfo } from './results'
import type { CuaResult } from './cua'
import type { UiAct } from '../../shared/ui-events'

type Point = { x: number; y: number }
type Rect = Point & { width: number; height: number }

/** The driver surface the agent's work goes through; `MacDriver` and `VisibleMac` both provide it. */
export interface Mac {
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult>
  close(): Promise<void>
}

const VERBS: Record<string, UiAct['verb']> = {
  click: 'click',
  double_click: 'click',
  right_click: 'click',
  type_text: 'type',
  set_value: 'set',
  drag: 'drag',
  press_key: 'key',
  hotkey: 'key',
  invoke_menu: 'menu',
  launch_app: 'launch',
  scroll: 'scroll',
}

const inside = (p: Point, r: Rect) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height
const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * The occlusion rule (spec §9): the cursor may only point at what you can see. The target window must be on screen,
 * contain the point, and have no normal window (layer 0) in front of it there. Floating panels, JevAuto's overlay
 * among them, never count as cover.
 */
export function isPointVisible(point: Point, windowId: number, windows: WindowInfo[]): boolean {
  const target = windows.find((w) => w.window_id === windowId && w.is_on_screen !== false)
  if (!target?.bounds || !inside(point, target.bounds)) return false
  const depth = target.z_index ?? 0
  return !windows.some(
    (w) => w.window_id !== windowId && (w.layer ?? 0) === 0 && (w.z_index ?? 0) > depth && w.bounds !== undefined && inside(point, w.bounds),
  )
}

type WindowGeometry = { app?: string; bounds?: Rect; screenshotWidth?: number }

/** Wraps the driver so every action announces where it lands before it runs, and whether it worked after. */
export class VisibleMac implements Mac {
  private snapshots = new Map<string, Map<number, ElementInfo>>()
  private windows = new Map<number, WindowGeometry>()
  private desktopScale?: number

  constructor(
    private readonly mac: Mac,
    private readonly emit: (name: string, data: unknown) => void,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    const verb = VERBS[name]
    if (!verb) {
      const result = await this.mac.call(name, args, signal)
      this.remember(name, result.structured)
      return result
    }
    const act = await this.announce(verb, name, args)
    this.emit('ui.act', act)
    const started = performance.now()
    try {
      const result = await this.mac.call(name, args, signal)
      this.emit('ui.done', { id: act.id, ok: !result.isError, ms: Math.round(performance.now() - started) })
      return result
    } catch (error) {
      this.emit('ui.done', { id: act.id, ok: false, ms: Math.round(performance.now() - started) })
      throw error
    }
  }

  close(): Promise<void> {
    return this.mac.close()
  }

  /** Keep what later actions need to be placed on screen: element frames by snapshot, and window geometry. */
  private remember(name: string, structured: unknown) {
    if (name === 'get_window_state') {
      const s = structured as { snapshot_id?: string; window_id?: number; app_name?: string; window_bounds?: Rect; screenshot_width?: number }
      const state = windowStateOf(structured)
      if (state.snapshotId) {
        this.snapshots.set(state.snapshotId, new Map(state.elements.map((e) => [e.element_index, e])))
        if (this.snapshots.size > 16) this.snapshots.delete(this.snapshots.keys().next().value!)
      }
      if (typeof s?.window_id === 'number')
        this.windows.set(s.window_id, { app: s.app_name, bounds: s.window_bounds, screenshotWidth: s.screenshot_width })
    } else if (name === 'list_windows') {
      for (const w of windowsOf(structured)) this.windows.set(w.window_id, { ...this.windows.get(w.window_id), app: w.app_name ?? this.windows.get(w.window_id)?.app })
    } else if (name === 'get_screen_size') {
      const scale = (structured as { scale_factor?: number })?.scale_factor
      if (typeof scale === 'number') this.desktopScale = scale
    }
  }

  private toScreen(windowId: number | undefined, x: unknown, y: unknown): Point | undefined {
    if (typeof x !== 'number' || typeof y !== 'number') return undefined
    if (windowId === undefined) return this.desktopScale ? { x: x / this.desktopScale, y: y / this.desktopScale } : undefined
    const w = this.windows.get(windowId)
    if (!w?.bounds || !w.screenshotWidth) return undefined
    const k = w.bounds.width / w.screenshotWidth
    return { x: w.bounds.x + x * k, y: w.bounds.y + y * k }
  }

  private async announce(verb: UiAct['verb'], name: string, args: Record<string, unknown>): Promise<UiAct> {
    const windowId = typeof args.window_id === 'number' ? args.window_id : undefined
    const element =
      typeof args.snapshot_id === 'string' && typeof args.element_index === 'number'
        ? this.snapshots.get(args.snapshot_id)?.get(args.element_index)
        : undefined
    const rect = element?.frame
    const point = rect ? centre(rect) : this.toScreen(windowId, args.x ?? args.from_x, args.y ?? args.from_y)
    const to = verb === 'drag' ? this.toScreen(windowId, args.to_x, args.to_y) : undefined
    const label =
      verb === 'type' && typeof args.text === 'string' ? `“${short(args.text, 24)}”`
      : verb === 'set' && typeof args.value === 'string' ? `“${short(args.value, 24)}”`
      : verb === 'key' ? String(args.key ?? (Array.isArray(args.keys) ? args.keys.join('+') : ''))
      : verb === 'menu' && Array.isArray(args.path) ? args.path.join(' › ')
      : verb === 'launch' ? String(args.name ?? args.bundle_id ?? '')
      : element ? short(element.label ?? element.role)
      : undefined
    let visible = false
    if (point && windowId !== undefined) {
      const listed = await this.mac.call('list_windows', { on_screen_only: true })
      this.remember('list_windows', listed.structured)
      visible = isPointVisible(point, windowId, windowsOf(listed.structured))
    } else if (point) visible = true // a desktop-scope click is a real cursor click on screen
    const app = windowId !== undefined ? this.windows.get(windowId)?.app : undefined
    return {
      id: this.newId(),
      verb,
      ...(label ? { label } : {}),
      ...(app ? { app } : {}),
      ...(rect ? { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}),
      ...(point ? { point } : {}),
      ...(to ? { to } : {}),
      visible,
    }
  }
}
