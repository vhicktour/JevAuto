import { windowsOf } from '../mac/results'
import type { CuaResult } from '../mac/cua'
import type { Mac } from '../mac/visible'
import { WEB_APP, WEB_BUNDLE, WEB_PID, type WebDriver } from './web'

export type WebSide = Pick<WebDriver, 'running' | 'isWeb' | 'call' | 'windows' | 'chromePid'>

const inside = (inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }) =>
  inner.x >= outer.x - 2 && inner.y >= outer.y - 2 && inner.x + inner.width <= outer.x + outer.width + 2 && inner.y + inner.height <= outer.y + outer.height + 2

/**
 * One driver for Mac apps and the web: calls for a web tab go to the agent Chrome over CDP, everything else to Cua.
 * The window list shows each tab in place of the Chrome window that holds it, so the loop, the gate and the cursor's
 * occlusion check treat a web page like any other window.
 */
export class RoutingMac implements Mac {
  constructor(
    private readonly cua: Mac,
    private readonly web: WebSide,
  ) {}

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    if (this.web.isWeb(args.window_id)) return this.web.call(name, args, signal)
    if (name === 'list_windows' && this.web.running) return this.listWindows(args, signal)
    if (name === 'list_apps' && this.web.running) {
      const r = await this.cua.call(name, args, signal)
      const apps = ((r.structured as { apps?: unknown[] })?.apps ?? []) as unknown[]
      return { ...r, structured: { ...(r.structured as object), apps: [...apps, { pid: WEB_PID, bundle_id: WEB_BUNDLE, name: WEB_APP, running: true }] } }
    }
    return this.cua.call(name, args, signal)
  }

  close(): Promise<void> {
    return this.cua.close()
  }

  private async listWindows(args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    const onlyWeb = args.pid === WEB_PID
    if (typeof args.pid === 'number' && !onlyWeb) return this.cua.call('list_windows', args, signal)
    const r = await this.cua.call('list_windows', onlyWeb ? { ...args, pid: undefined } : args, signal)
    if (r.isError) return r
    const chrome = this.web.chromePid()
    const listed = windowsOf(r.structured)
    const holders = listed.filter((w) => w.pid === chrome)
    const tabs = (await this.web.windows())
      .map((t) => {
        const holder = holders.find((h) => h.bounds && inside(t.bounds, h.bounds))
        return { ...t, is_on_screen: t.is_on_screen && holder?.is_on_screen !== false, ...(holder?.z_index !== undefined ? { z_index: holder.z_index } : {}) }
      })
      .filter((t) => !args.on_screen_only || t.is_on_screen)
    const others = onlyWeb ? [] : listed.filter((w) => w.pid !== chrome)
    return { ...r, structured: { ...(r.structured as object), windows: [...others, ...tabs] } }
  }
}
