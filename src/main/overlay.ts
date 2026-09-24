import { BrowserWindow } from 'electron'
import { islandRect, overlayRect, type NativeDisplay } from '../shared/native'

type Loader = (window: BrowserWindow, query: Record<string, string>) => void
type Probe = 'probe-overlay' | 'probe-island'
const ISLAND = { width: 360, height: 44 }

function panel(bounds: { x: number; y: number; width: number; height: number }, preload: string, surface: Probe, load: Loader) {
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
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: [`--jevauto-surface=${surface}`] },
  })
  window.setIgnoreMouseEvents(true) // fully click-through; no forward needed (critic m3)
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  window.setHiddenInMissionControl(true)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.showInactive())
  load(window, { surface })
  return window
}

export function openOverlays(displays: NativeDisplay[], preload: string, load: Loader) {
  const overlays = displays.map((d) => panel(overlayRect(d), preload, 'probe-overlay', load))
  const home = displays.find((d) => d.notch) ?? displays[0]
  const island = panel(islandRect(home, ISLAND), preload, 'probe-island', load)
  return { overlays, island, home }
}
