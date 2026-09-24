import { BrowserWindow, screen, type Rectangle } from 'electron'
import glass from 'electron-liquid-glass'
import { overlayRect, type NativeDisplay } from '../shared/native'
import type { UiEvent } from '../shared/ui-events'

export type Load = (window: BrowserWindow, query: Record<string, string>) => void
type Rect = { x: number; y: number; width: number; height: number }

const ISLAND_PANEL = { width: 560, height: 110 }

/**
 * Owns every JevAuto surface (spec §9): the activity window, one click-through overlay per display for the agent
 * cursor, and the status island on the notch. Main relays agent events to all of them.
 */
export class UiCoordinator {
  readonly activity: BrowserWindow
  private overlays: BrowserWindow[] = []
  private island?: BrowserWindow
  private islandHit: Rect | null = null
  private islandIgnoring = true
  private readonly timer: NodeJS.Timeout

  constructor(
    private readonly preload: string,
    private readonly load: Load,
  ) {
    this.activity = this.makeActivity()
    // Jarvis's hit test: the island panel is click-through except over the visible pill.
    this.timer = setInterval(() => this.hitTest(), 60)
    this.timer.unref()
  }

  broadcast(event: UiEvent) {
    for (const w of this.all()) if (!w.isDestroyed()) w.webContents.send('jevauto:event', event)
  }

  /** The island reports its pill in window coordinates; `null` while it rests. */
  setIslandHit(rect: Rect | null) {
    this.islandHit = rect
  }

  /** (Re)build the overlays and the island for the current displays. */
  setDisplays(displays: NativeDisplay[]) {
    for (const w of [...this.overlays, this.island]) if (w && !w.isDestroyed()) w.destroy()
    this.overlays = displays.map((d) => {
      const r = overlayRect(d)
      return this.panel(r, { surface: 'overlay', ox: String(r.x), oy: String(r.y), ow: String(r.width), oh: String(r.height) })
    })
    const home = displays.find((d) => d.notch) ?? displays[0]
    const centre = home.notch ? home.notch.x + home.notch.width / 2 : home.frame.x + home.frame.width / 2
    this.island = this.panel(
      { x: Math.round(centre - ISLAND_PANEL.width / 2), y: home.frame.y, ...ISLAND_PANEL },
      { surface: 'island', nw: String(home.notch?.width ?? 0), nh: String(home.notch?.height ?? 32) },
      true,
    )
    this.islandHit = null
    this.islandIgnoring = true
  }

  destroy() {
    clearInterval(this.timer)
    for (const w of this.all()) if (!w.isDestroyed()) w.destroy()
  }

  private all() {
    return [this.activity, ...this.overlays, ...(this.island ? [this.island] : [])]
  }

  private makeActivity() {
    const window = new BrowserWindow({
      width: 440,
      height: 640,
      minWidth: 380,
      minHeight: 480,
      title: 'JevAuto',
      titleBarStyle: 'hiddenInset',
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: this.webPreferences('activity'),
    })
    this.guard(window)
    window.once('ready-to-show', () => (process.argv.includes('--background') ? window.showInactive() : window.show()))
    window.webContents.once('did-finish-load', () => {
      try {
        if (glass.addView(window.getNativeWindowHandle(), { cornerRadius: 16, tintColor: '#08121A44' }) >= 0 && glass.isGlassSupported())
          void window.webContents.executeJavaScript("document.body.classList.add('has-glass')")
      } catch (error) {
        console.error('Glass material:', error instanceof Error ? error.message : 'unavailable')
      }
    })
    this.load(window, { surface: 'activity' })
    return window
  }

  /** A transparent, non-activating panel on every Space, including full-screen ones (Spike B). */
  private panel(bounds: Rect, query: Record<string, string>, clickable = false) {
    const window = new BrowserWindow({
      ...bounds,
      type: 'panel',
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      focusable: false,
      resizable: false,
      movable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      enableLargerThanScreen: true,
      acceptFirstMouse: clickable, // Stop works on the first click, without activating JevAuto
      webPreferences: this.webPreferences(query.surface),
    })
    window.setIgnoreMouseEvents(true, { forward: clickable })
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    window.setHiddenInMissionControl(true)
    this.guard(window)
    window.once('ready-to-show', () => window.showInactive())
    this.load(window, query)
    return window
  }

  private webPreferences(surface: string) {
    return {
      preload: this.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--jevauto-surface=${surface}`],
    }
  }

  private guard(window: BrowserWindow) {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
  }

  private hitTest() {
    const island = this.island
    if (!island || island.isDestroyed()) return
    const r = this.islandHit
    let over = false
    if (r) {
      const b: Rectangle = island.getBounds()
      const p = screen.getCursorScreenPoint()
      over = p.x >= b.x + r.x && p.x < b.x + r.x + r.width && p.y >= b.y + r.y && p.y < b.y + r.y + r.height
    }
    if (over === !this.islandIgnoring) return // only tell the window server when it changes
    this.islandIgnoring = !over
    island.setIgnoreMouseEvents(this.islandIgnoring, { forward: true })
  }
}
