import type { EventEmitter } from 'node:events'

export type UpdateState = { status: 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error'; version?: string; error?: string }

/** The part of electron-updater's autoUpdater JevAuto uses (injected, so this runs in tests without Electron). */
export type Updater = EventEmitter & {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

const CHECK_EVERY_MS = 6 * 60 * 60_000

/**
 * Spec §12 Phase 5: signed releases update themselves from the GitHub releases feed (the ZIP and latest-mac.yml that
 * electron-builder publishes). An update downloads in the background and installs only when you choose Restart, never
 * during a task. The bundle id and Team ID never change, so macOS keeps JevAuto's permissions. The dev bundle
 * ("JevAuto Dev") and unpackaged runs never check.
 */
export class Updates {
  private state: UpdateState = { status: 'off' }
  private timer?: NodeJS.Timeout

  constructor(
    /** `updater` is called only for a release build (electron-updater creates its updater on first access). */
    private readonly d: { packaged: boolean; name: string; updater: () => Updater; onChange: (s: UpdateState) => void; log: (line: string) => void },
  ) {}

  get current(): UpdateState {
    return this.state
  }

  start() {
    const { packaged, name } = this.d
    if (!packaged || /\bdev\b/i.test(name)) return
    const updater = this.d.updater()
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.on('checking-for-update', () => this.set({ status: 'checking' }))
    updater.on('update-not-available', () => this.set({ status: 'idle' }))
    updater.on('update-available', (info: { version: string }) => this.set({ status: 'downloading', version: info.version }))
    updater.on('update-downloaded', (info: { version: string }) => this.set({ status: 'ready', version: info.version }))
    updater.on('error', (error: Error) => {
      this.set({ status: 'error', error: error.message.slice(0, 200) })
      this.d.log(`Update check failed: ${error.message.slice(0, 300)}`)
    })
    const check = () => void updater.checkForUpdates().catch(() => undefined) // failures arrive as 'error' events
    check()
    this.timer = setInterval(check, CHECK_EVERY_MS)
    this.timer.unref()
  }

  /** Restart into the downloaded update. False when none is ready. */
  install(): boolean {
    if (this.state.status !== 'ready') return false
    this.d.updater().quitAndInstall()
    return true
  }

  stop() {
    clearInterval(this.timer)
  }

  private set(s: UpdateState) {
    this.state = s
    this.d.onChange(s)
  }
}
