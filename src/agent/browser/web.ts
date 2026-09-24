import { execFileSync } from 'node:child_process'
import type { BrowserContext, JSHandle, Page } from 'playwright-core'
import type { CuaResult } from '../mac/cua'
import type { Focus } from '../../shared/native'
import { launchAgentChrome } from './chrome'

/** Web tabs stand in the window list under one made-up app, so the loop treats them like any other window. */
export const WEB_PID = 999_999_000
export const WEB_BUNDLE = 'personal.jevauto.web'
export const WEB_APP = 'Web'
const FIRST_ID = 2 ** 30

type Rect = { x: number; y: number; width: number; height: number }
type Row = { role: string; label: string; value?: string; rect: { x: number; y: number; w: number; h: number } }
type Snapshot = { page: Page; handle: JSHandle<{ rows: Row[]; nodes: Element[] }> }
export type WebWindow = { window_id: number; pid: number; app_name: string; title: string; url: string; bounds: Rect; is_on_screen: boolean; layer: number; z_index?: number }

const KEYS: Record<string, string> = {
  return: 'Enter', tab: 'Tab', escape: 'Escape', delete: 'Backspace', forwarddelete: 'Delete', space: 'Space',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown',
}
const MODIFIERS: Record<string, string> = { cmd: 'Meta', shift: 'Shift', option: 'Alt', alt: 'Alt', ctrl: 'Control' }
const keyName = (k: string) => KEYS[k] ?? (/^f\d{1,2}$/.test(k) ? k.toUpperCase() : k)

const ok = (structured: unknown = {}, images: CuaResult['images'] = [], text = 'ok'): CuaResult => ({ text, imageCount: images.length, images, structured, isError: false, durationMs: 0 })
const failed = (text: string, code = 'web_error'): CuaResult => ({ text, imageCount: 0, images: [], structured: { code }, isError: true, durationMs: 0 })

/**
 * Runs in the page: the controls on screen as AX-like rows (so the gate reads web buttons like Mac ones), or where
 * keyboard focus is. A password's value is never read. `cc-*` and one-time-code fields say so in their label.
 */
function pageScan(mode: 'snapshot' | 'focus') {
  const name = (e: Element | null, seen = new Set<Element>()): string => {
    if (!e || seen.has(e)) return ''
    seen.add(e)
    const byId = (e.getAttribute('aria-labelledby') ?? '').split(/\s+/).map((id) => name(document.getElementById(id), seen)).filter(Boolean).join(' ')
    const labels = 'labels' in e ? [...((e as HTMLInputElement).labels ?? [])].map((l) => name(l, seen)).filter(Boolean).join(' ') : ''
    const own =
      e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT'
        ? ''
        : [...e.childNodes]
            .map((n) => (n.nodeType === 3 ? n.textContent : n.nodeType === 1 && (n as Element).getAttribute('aria-hidden') !== 'true' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((n as Element).tagName) ? name(n as Element, seen) : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
    return byId || e.getAttribute('aria-label') || labels || own || e.getAttribute('alt') || e.getAttribute('title') || e.getAttribute('placeholder') || ''
  }
  const role = (e: Element): string | null => {
    const r = e.getAttribute('role')
    if (e instanceof HTMLInputElement) {
      const t = (e.type || 'text').toLowerCase()
      if (t === 'password') return 'AXSecureTextField'
      if (t === 'hidden' || t === 'file') return null
      if (t === 'checkbox') return 'AXCheckBox'
      if (t === 'radio') return 'AXRadioButton'
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'AXButton'
      return t === 'search' ? 'AXSearchField' : 'AXTextField'
    }
    if (e instanceof HTMLTextAreaElement || (e as HTMLElement).isContentEditable) return 'AXTextArea'
    if (e instanceof HTMLSelectElement || r === 'combobox') return 'AXPopUpButton'
    if (e instanceof HTMLAnchorElement || r === 'link') return 'AXLink'
    if (r === 'checkbox' || r === 'switch') return 'AXCheckBox'
    if (r === 'radio') return 'AXRadioButton'
    if (r === 'textbox') return 'AXTextField'
    if (r === 'searchbox') return 'AXSearchField'
    return 'AXButton'
  }
  const hint = (e: Element) => {
    const auto = (e.getAttribute('autocomplete') ?? '').toLowerCase()
    if (auto.startsWith('cc-')) return ` (credit card ${auto === 'cc-number' ? 'number' : auto.slice(3)})`
    return auto === 'one-time-code' ? ' (one-time code)' : ''
  }
  const row = (e: Element) => {
    const ax = role(e)
    if (!ax) return null
    const r = e.getBoundingClientRect()
    const value = ax === 'AXSecureTextField' ? undefined : 'value' in e && typeof (e as HTMLInputElement).value === 'string' ? (e as HTMLInputElement).value : (e as HTMLElement).isContentEditable ? (e as HTMLElement).innerText.slice(0, 2000) : undefined
    return { role: ax, label: `${name(e)}${hint(e)}`.trim().slice(0, 200), ...(value !== undefined ? { value } : {}), rect: { x: r.x, y: r.y, w: r.width, h: r.height } }
  }
  if (mode === 'focus') {
    const e = document.activeElement
    if (!e || e === document.body || e === document.documentElement) return { rows: [], nodes: [] }
    if (e.tagName === 'IFRAME') return { rows: [{ role: 'AXGroup', label: 'frame', rect: { x: 0, y: 0, w: 0, h: 0 } }], nodes: [e] }
    const r = row(e)
    return { rows: r ? [r] : [], nodes: r ? [e] : [] }
  }
  const selector =
    'a[href],button,input,textarea,select,summary,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],' +
    ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'combobox', 'textbox', 'searchbox', 'spinbutton'].map((x) => `[role="${x}"]`).join(',')
  const rows: Row[] = []
  const nodes: Element[] = []
  for (const e of document.querySelectorAll(selector)) {
    const r = e.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue
    if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || (e as HTMLButtonElement).disabled) continue
    const x = row(e)
    if (!x) continue
    rows.push(x)
    nodes.push(e)
    if (rows.length >= 400) break
  }
  return { rows, nodes }
}

/**
 * The scan as an expression. tsx and esbuild keep function names by wrapping inner functions in `__name(...)`, which
 * doesn't exist inside the page, so a local stand-in comes first; nothing is added to the page's globals.
 */
const scan = (mode: 'snapshot' | 'focus') => `(() => { const __name = (f) => f; return (${pageScan.toString()})(${JSON.stringify(mode)}) })()`

/**
 * JevAuto's own browser (spec §5), driven only through CDP, answering the same calls the loop makes of Cua. Each tab
 * is a "window": its viewport is the screenshot, its controls are the elements, and clicks, keys and typing arrive as
 * page input, so shortcuts work in the background. Chrome launches the first time a task needs the web.
 */
export class WebDriver {
  private context?: BrowserContext
  private ids = new Map<Page, number>()
  private pages = new Map<number, Page>()
  private next = FIRST_ID
  private snapshots = new Map<string, Snapshot>()
  private counter = 0
  private pid?: number

  constructor(
    private readonly profileDir: string,
    private readonly launch: (profileDir: string) => Promise<BrowserContext> = launchAgentChrome,
  ) {}

  get running(): boolean {
    return this.context !== undefined
  }

  isWeb(windowId: unknown): windowId is number {
    return typeof windowId === 'number' && windowId >= FIRST_ID
  }

  /** Opens `url` in the tab `windowId`, or in a new tab. Call `checkUrl` first: this goes wherever it is told. */
  async open(url: string, windowId?: number): Promise<{ windowId: number; title: string; url: string }> {
    const context = await this.ensure()
    const page = windowId !== undefined && this.pages.has(windowId) ? this.pages.get(windowId)! : await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return { windowId: this.idOf(page), title: await page.title(), url: page.url() }
  }

  /** Every open tab as a window. The routing driver gives them the z-order of the Chrome window they sit in. */
  async windows(): Promise<WebWindow[]> {
    if (!this.context) return []
    const out: WebWindow[] = []
    for (const page of this.context.pages()) {
      if (page.isClosed()) continue
      const g = await this.geometry(page).catch(() => undefined)
      if (!g) continue
      out.push({ window_id: this.idOf(page), pid: WEB_PID, app_name: WEB_APP, title: g.title || page.url(), url: page.url(), bounds: g.bounds, is_on_screen: g.visible, layer: 0 })
    }
    return out
  }

  /** The agent Chrome's browser process, found by its profile (a persistent context exposes no process handle). */
  chromePid(): number | undefined {
    if (!this.context) return undefined
    if (this.pid) return this.pid
    const line = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .find((l) => l.includes(`--user-data-dir=${this.profileDir}`) && !l.includes('--type='))
    const pid = line ? Number(/^\s*(\d+)/.exec(line)?.[1]) : NaN
    this.pid = Number.isInteger(pid) && pid > 0 ? pid : undefined
    return this.pid
  }

  /** Where keystrokes go in this tab, in the same shape JevNative reports for Mac apps. */
  async focus(windowId: number): Promise<Focus> {
    const page = this.pages.get(windowId)
    if (!page) return { ok: false, error: 'no such tab', webArea: true, secure: false }
    const g = await this.geometry(page)
    const handle = await page.evaluateHandle<{ rows: Row[]; nodes: Element[] }>(scan('focus'))
    const { rows } = (await handle.jsonValue()) as { rows: Row[] }
    await handle.dispose()
    const r = rows[0]
    if (!r) return { ok: false, error: 'no focused element', webArea: true, secure: false }
    // A frame from another site can't be read, so where its keystrokes land is unknown (spec §5: treated as sensitive).
    if (r.role === 'AXGroup') return { ok: false, error: 'focus is inside a frame', webArea: true, secure: false }
    return {
      ok: true,
      role: r.role,
      ...(r.role === 'AXSecureTextField' ? { subrole: 'AXSecureTextField' } : {}),
      frame: { x: g.bounds.x + r.rect.x, y: g.bounds.y + r.rect.y, width: r.rect.w, height: r.rect.h },
      windowFrame: g.bounds,
      webArea: true,
      secure: r.role === 'AXSecureTextField',
    }
  }

  /** Cua's calls, answered for a tab. Coordinates are pixels of this tab's screenshot, as with a Mac window. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    signal?.throwIfAborted()
    const page = this.pages.get(Number(args.window_id))
    if (!page || page.isClosed()) return failed('That tab is closed.', 'window_id_not_found')
    const started = performance.now()
    try {
      const result = await this.dispatch(page, name, args)
      return { ...result, durationMs: Math.round(performance.now() - started) }
    } catch (error) {
      return failed(error instanceof Error ? error.message.split('\n')[0].slice(0, 300) : String(error))
    }
  }

  async close() {
    for (const s of this.snapshots.values()) await s.handle.dispose().catch(() => {})
    this.snapshots.clear()
    await this.context?.close().catch(() => {})
    this.context = undefined
    this.pid = undefined
  }

  private async ensure(): Promise<BrowserContext> {
    if (this.context) return this.context
    const context = await this.launch(this.profileDir)
    context.on('page', (page) => void this.idOf(page)) // tabs a page opens become windows the target can follow
    context.on('close', () => {
      if (this.context === context) this.context = undefined
    })
    this.context = context
    return context
  }

  private idOf(page: Page): number {
    let id = this.ids.get(page)
    if (id === undefined) {
      id = this.next++
      this.ids.set(page, id)
      this.pages.set(id, page)
      page.on('close', () => this.pages.delete(id!))
    }
    return id
  }

  /** The viewport in screen points (window position plus the browser's own toolbars), and whether the tab shows. */
  private geometry(page: Page) {
    return page.evaluate(() => ({
      title: document.title,
      visible: document.visibilityState === 'visible',
      dpr: devicePixelRatio,
      bounds: { x: screenX + (outerWidth - innerWidth), y: screenY + (outerHeight - innerHeight), width: innerWidth, height: innerHeight },
    }))
  }

  private async dispatch(page: Page, name: string, args: Record<string, unknown>): Promise<CuaResult> {
    const g = await this.geometry(page)
    const css = (x: unknown, y: unknown) => ({ x: Number(x) / g.dpr, y: Number(y) / g.dpr })
    switch (name) {
      case 'get_window_state': {
        const handle = await page.evaluateHandle<{ rows: Row[]; nodes: Element[] }>(scan('snapshot'))
        const { rows } = (await handle.evaluate((o) => ({ rows: o.rows }))) as { rows: Row[] }
        const snapshotId = `w${++this.counter}`
        this.snapshots.set(snapshotId, { page, handle })
        for (const [key, old] of this.snapshots)
          if (this.snapshots.size > 4) {
            this.snapshots.delete(key)
            await old.handle.dispose().catch(() => {})
          }
        const elements = rows.map((r, i) => ({
          element_index: i,
          role: r.role,
          label: r.label,
          ...(r.value !== undefined ? { value: r.value } : {}),
          frame: { x: g.bounds.x + r.rect.x, y: g.bounds.y + r.rect.y, w: r.rect.w, h: r.rect.h },
        }))
        const images: CuaResult['images'] = []
        let size = { width: Math.round(g.bounds.width * g.dpr), height: Math.round(g.bounds.height * g.dpr) }
        if (args.include_screenshot !== false) {
          const png = await page.screenshot({ type: 'png' })
          images.push({ mimeType: 'image/png', dataBase64: png.toString('base64') })
          size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
        }
        return ok(
          { snapshot_id: snapshotId, window_id: args.window_id, app_name: WEB_APP, window_title: g.title || page.url(), url: page.url(), window_bounds: g.bounds, screenshot_width: size.width, screenshot_height: size.height, elements },
          images,
        )
      }
      case 'click':
      case 'double_click':
      case 'right_click': {
        const at = await this.pointOf(page, args, g)
        const button = name === 'right_click' ? 'right' : ((args.button as 'left' | 'right' | 'middle' | undefined) ?? 'left')
        await this.holding(page, args.modifier, () => page.mouse.click(at.x, at.y, { button, clickCount: name === 'double_click' ? 2 : Number(args.count ?? 1) }))
        await this.settle(page)
        return ok({ effect: 'dispatched', route: 'cdp' })
      }
      case 'type_text': {
        if (typeof args.text !== 'string') return failed('No text to type.')
        if (typeof args.element_index === 'number') await (await this.node(page, args)).focus()
        else if (typeof args.x === 'number') {
          const at = css(args.x, args.y)
          await page.mouse.click(at.x, at.y)
        }
        await page.keyboard.insertText(args.text)
        await this.settle(page)
        return ok({ effect: 'dispatched', route: 'cdp' })
      }
      case 'press_key':
        await page.keyboard.press([...((args.modifiers as string[] | undefined) ?? []).map((m) => MODIFIERS[m] ?? m), keyName(String(args.key))].join('+'))
        await this.settle(page)
        return ok({ effect: 'dispatched', route: 'cdp' })
      case 'hotkey': {
        const keys = (args.keys as string[]).map((k) => MODIFIERS[k] ?? keyName(k))
        await page.keyboard.press(keys.join('+'))
        await this.settle(page)
        return ok({ effect: 'dispatched', route: 'cdp' })
      }
      case 'scroll': {
        const at = typeof args.x === 'number' ? css(args.x, args.y) : { x: g.bounds.width / 2, y: g.bounds.height / 2 }
        // The loop turns distance into ~12 pt notches; a web page scrolls in CSS pixels, which are points.
        const distance = Number(args.amount ?? 3) * 12
        const d = String(args.direction)
        await page.mouse.move(at.x, at.y)
        await page.mouse.wheel(d === 'left' ? -distance : d === 'right' ? distance : 0, d === 'up' ? -distance : d === 'down' ? distance : 0)
        await page.waitForTimeout(250)
        return ok({ effect: 'dispatched', route: 'cdp' })
      }
      case 'drag': {
        const from = css(args.from_x, args.from_y)
        const to = css(args.to_x, args.to_y)
        await this.holding(page, args.modifier, async () => {
          await page.mouse.move(from.x, from.y)
          await page.mouse.down()
          await page.mouse.move(to.x, to.y, { steps: 20 })
          await page.mouse.up()
        })
        await this.settle(page)
        return ok({ effect: 'dispatched', route: 'cdp' })
      }
      case 'bring_to_front':
        await page.bringToFront()
        return ok({ effect: 'dispatched' })
      default:
        return failed(`${name} is not available on a web page.`, 'unsupported_on_web')
    }
  }

  private async node(page: Page, args: Record<string, unknown>) {
    const snap = this.snapshots.get(String(args.snapshot_id))
    if (!snap || snap.page !== page) throw new Error('That element list is out of date; look at the page again.')
    const element = (await snap.handle.evaluateHandle((o, i) => o.nodes[i], Number(args.element_index))).asElement()
    if (!element) throw new Error('That element is gone.')
    return element
  }

  private async pointOf(page: Page, args: Record<string, unknown>, g: { dpr: number }) {
    if (typeof args.element_index === 'number') {
      const box = await (await this.node(page, args)).boundingBox()
      if (!box) throw new Error('That element is not on the page any more.')
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    return { x: Number(args.x) / g.dpr, y: Number(args.y) / g.dpr }
  }

  /** Holds modifier keys (⇧, ⌘…) through a pointer action, then lets them go even if it fails. */
  private async holding(page: Page, modifier: unknown, act: () => Promise<void>) {
    const held = Array.isArray(modifier) ? modifier.map((m) => MODIFIERS[String(m)]).filter(Boolean) : []
    for (const m of held) await page.keyboard.down(m)
    try {
      await act()
    } finally {
      for (const m of held.reverse()) await page.keyboard.up(m)
    }
  }

  /** Give the page a moment to react: a started navigation reaches DOMContentLoaded, script handlers run. */
  private async settle(page: Page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {})
    await page.waitForTimeout(150)
  }
}
