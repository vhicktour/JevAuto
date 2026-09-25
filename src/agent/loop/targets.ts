import { windowsOf, windowStateOf } from '../mac/results'
import type { Mac } from '../mac/visible'
import type { Rect } from '../frame/frame'
import { exclusionReason } from './gate'
import type { Target } from './observe'

type AppRecord = { pid: number; bundleId?: string; name: string; running: boolean }
export type Window = Target & { title: string; bounds?: Rect; z: number }

/** macOS shows a sandboxed app's Open and Save panels from a separate service process. */
const PANEL_SERVICE = /open ?and ?save ?panel/i
const NOT_CONTROLS = new Set(['AXWindow', 'AXMenuBar', 'AXMenuBarItem', 'AXMenu', 'AXMenuItem'])
/**
 * Never picked as the first target on their own: the terminal or editor you may be running JevAuto (or Claude Code)
 * from. A task can still name them; this only changes which window a run starts in.
 */
export const DEVELOPER_APPS = ['com.apple.Terminal', 'com.googlecode.iterm2', 'com.mitchellh.ghostty', 'dev.warp.Warp-Stable', 'com.github.wez.wezterm', 'org.alacritty', 'net.kovidgoyal.kitty', 'com.microsoft.VSCode', 'com.todesktop.230313mzl4w4u92', 'dev.zed.Zed']

/** Names people (and models) use for apps whose real name differs. */
export const ALIASES: Record<string, string> = {
  imessage: 'messages',
  'system preferences': 'system settings',
  settings: 'system settings',
  itunes: 'music',
  'address book': 'contacts',
  ical: 'calendar',
  chrome: 'google chrome',
}

/** Which windows exist, which may be acted in, and how the target follows new windows (spec §4). */
export class Targets {
  private apps: AppRecord[] = []
  private byPid = new Map<number, AppRecord>()
  private known = new Set<number>()
  private untitled = new Map<number, boolean>()
  /** Snapshots taken of windows other than the target; the loop re-reads its own snapshot when this changes. */
  probes = 0

  constructor(
    private readonly mac: Mac,
    private readonly excluded: string[] = [],
    /** Cua errors are reported here instead of passing for "no apps" or "no windows". */
    private readonly onError: (what: string, text: string) => void = () => {},
    /** Apps the driving brain may run in (see GateInput.host). */
    private readonly host: string[] = [],
  ) {}

  /** `list_apps` is slow (~0.9 s), so it runs at start and again only for a pid it has not seen. A failed read keeps the last list. */
  async refreshApps(signal?: AbortSignal) {
    const r = await this.mac.call('list_apps', {}, signal)
    if (r.isError) return this.onError('list_apps', r.text.slice(0, 300))
    const list = ((r.structured as { apps?: unknown[] })?.apps ?? []) as { pid?: number; bundle_id?: string; name?: string; running?: boolean }[]
    this.apps = list.filter((a) => typeof a.name === 'string').map((a) => ({ pid: a.pid ?? 0, bundleId: a.bundle_id, name: a.name!, running: a.running === true }))
    this.byPid = new Map(this.apps.filter((a) => a.running && a.pid > 0).map((a) => [a.pid, a]))
  }

  private async bundleOf(pid: number, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.byPid.has(pid)) await this.refreshApps(signal)
    return this.byPid.get(pid)?.bundleId
  }

  /** On-screen windows, frontmost first, each with its app's bundle id. */
  async windows(signal?: AbortSignal): Promise<Window[]> {
    const r = await this.mac.call('list_windows', { on_screen_only: true }, signal)
    if (r.isError) this.onError('list_windows', r.text.slice(0, 300))
    const out: Window[] = []
    for (const w of windowsOf(r.structured)) {
      const b = w.bounds
      if (w.is_on_screen === false || !b || b.width < 50 || b.height < 50) continue
      if (!w.title && (b.width * b.height < 100 * 100 || !(await this.hasControls(w.pid, w.window_id, signal)))) continue
      out.push({ pid: w.pid, windowId: w.window_id, app: w.app_name ?? 'App', title: w.title ?? '', bounds: b, z: w.z_index ?? -1, bundleId: await this.bundleOf(w.pid, signal) })
    }
    this.known = new Set(out.map((w) => w.windowId))
    return out.sort((a, b) => b.z - a.z)
  }

  /**
   * An untitled window counts only when it holds at least two controls: alerts and sheets do, while helper windows
   * such as the Siri orb macOS 27 attaches to text apps (one button, subrole AXDialog like a real dialog) do not.
   */
  private async hasControls(pid: number, windowId: number, signal?: AbortSignal): Promise<boolean> {
    const known = this.untitled.get(windowId)
    if (known !== undefined) return known
    const r = await this.mac.call('get_window_state', { pid, window_id: windowId, include_screenshot: false, max_elements: 40 }, signal)
    this.probes += 1
    const controls = r.isError ? 0 : windowStateOf(r.structured).elements.filter((e) => !NOT_CONTROLS.has(e.role)).length
    this.untitled.set(windowId, controls >= 2)
    return controls >= 2
  }

  allowed(windows: Window[]): Window[] {
    return windows.filter((w) => exclusionReason(w, this.excluded, this.host) === undefined)
  }

  /** The frontmost window you could see and JevAuto may act in, skipping `avoid` (the terminal running the CLI). */
  async initial(avoid: string[], signal?: AbortSignal): Promise<Window | undefined> {
    return this.allowed(await this.windows(signal)).find((w) => !w.bundleId || !avoid.includes(w.bundleId))
  }

  /**
   * After an action: a window the target's app (or its Open/Save panel service) just opened becomes the target.
   * Returns the new window, `null` when the target closed, or undefined when nothing changed.
   */
  async follow(target: Target, signal?: AbortSignal): Promise<Window | null | undefined> {
    const before = this.known
    const now = await this.windows(signal)
    const fresh = now.filter((w) => !before.has(w.windowId) && (w.pid === target.pid || PANEL_SERVICE.test(w.app)))
    if (fresh.length) return fresh[0]
    return now.some((w) => w.windowId === target.windowId) ? undefined : null
  }

  /** Finds an installed app by name: exact first, then prefix, running apps first. Common other names map to the real one. */
  findApp(name: string): AppRecord | undefined {
    const typed = name.trim().toLowerCase().replace(/\.app$/, '')
    const n = ALIASES[typed] ?? typed
    const rank = (a: AppRecord) => (a.running ? 0 : 1)
    const sorted = [...this.apps].sort((a, b) => rank(a) - rank(b))
    return sorted.find((a) => a.name.toLowerCase() === n) ?? sorted.find((a) => a.name.toLowerCase().startsWith(n))
  }

  exclusion(t: Target): string | undefined {
    return exclusionReason(t, this.excluded, this.host)
  }
}

export const describeWindow = (w: Target) => `${w.app}${w.title ? ` — “${w.title}”` : ''} (window ${w.windowId})`
