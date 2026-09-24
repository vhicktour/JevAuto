import type { BrowserWindow } from 'electron'
import { readDisplays, islandRect, overlayRect } from '../shared/native'
import { openOverlays } from './overlay'
import { createReport, writeReport, percentile } from '../shared/report'
import { lastInputAt, parseTargetTitle, targetTitle } from '../agent/spikes/spike-a'
import { windowsOf } from '../agent/mac/results'
import { launchContext } from '../shared/launch'
import { requestPermissions } from './cua-host'
import type { Supervisor } from './supervisor'
import type { UiEvent } from '../shared/ui-events'

export type SpikeName = 'skeleton' | 'a' | 'b' | 'demo' | 'stop'
export type SpikeDeps = {
  supervisor: Supervisor
  paths: { cuaSdkPath: string; cuaLibraryPath: string; nativeHelperPath: string }
  evidenceDir: string
  argv: string[]
  emit: (line: string) => void
  /** Sends a UI event to every surface (island, overlays, activity window). */
  broadcast: (event: UiEvent) => void
  /** Aborted by Stop. */
  signal: AbortSignal
  /** Stop's backstop: kill the agent after 250 ms. */
  halt: () => void
  preload: string
  load: (w: BrowserWindow, query: Record<string, string>) => void
}

export const argValue = (argv: string[], name: string) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

export function spikeFromArgv(argv: string[]): SpikeName {
  const v = argValue(argv, 'spike')
  return v === 'a' || v === 'b' || v === 'demo' || v === 'stop' ? v : 'skeleton'
}

type AgentPermissions = { accessibility: boolean; screenRecording: boolean; source: unknown; captureOk: boolean; captureError: string | null }

export async function runSkeleton(deps: SpikeDeps): Promise<boolean> {
  const ctx = launchContext(process.env)
  const label = argValue(deps.argv, 'launch') ?? (ctx.fromTerminal ? 'terminal' : 'finder')
  const report = createReport('skeleton', label)
  report.add({ name: 'launched through LaunchServices', pass: !ctx.fromTerminal, details: ctx })
  if (ctx.hint) deps.emit(ctx.hint)
  const main = await requestPermissions(deps.paths)
  report.add({ name: 'main sees Accessibility', pass: main.accessibility })
  report.add({ name: 'main sees Screen Recording', pass: main.screenRecording })
  const agent = await deps.supervisor.request<AgentPermissions>('permissions.check', {}, { timeoutMs: 60_000, signal: deps.signal })
  report.add({ name: 'agent (in-process Cua) sees both grants', pass: agent.accessibility && agent.screenRecording, details: agent })
  report.add({ name: 'agent desktop capture works', pass: agent.captureOk, details: { captureError: agent.captureError } })
  const granted = main.accessibility && main.screenRecording && agent.accessibility && agent.screenRecording
  deps.broadcast({ type: 'permissions', accessibility: main.accessibility && agent.accessibility, screenRecording: main.screenRecording && agent.screenRecording })
  if (!granted)
    deps.emit('Grant Accessibility and Screen Recording to “JevAuto Dev” in System Settings, then quit (⌘Q) and relaunch with the same command.')
  const file = await writeReport(deps.evidenceDir, report.finish({ granted }))
  deps.emit(`skeleton report: ${file}`)
  return granted
}

export async function runSpike(name: SpikeName, deps: SpikeDeps): Promise<void> {
  const granted = await runSkeleton(deps)
  if (name === 'skeleton' || !granted) return
  const { signal } = deps
  if (name === 'stop') return runStopTest(deps)
  if (name === 'demo') {
    // The agent narrates and counts its own steps (ui.status); the island and cursor follow.
    const result = await deps.supervisor.request<{ file: string; summary: unknown }>('spike.demo', {}, { timeoutMs: 5 * 60_000, signal })
    deps.emit(`demo report: ${result.file} ${JSON.stringify(result.summary)}`)
    return
  }
  deps.broadcast({ type: 'status', status: { state: 'working', title: name === 'a' ? 'Spike A' : 'Spike B' } })
  if (name === 'a') {
    const only = argValue(deps.argv, 'only') === 'offspace' ? 'offspace' : 'all'
    deps.emit(`Spike A (${only}) running; keep your hands off the fixture window.`)
    const result = await deps.supervisor.request<{ file: string; summary: unknown }>('spike.a', { only }, { timeoutMs: 15 * 60_000, signal })
    deps.emit(`spike A report: ${result.file} ${JSON.stringify(result.summary)}`)
  }
  if (name === 'b') {
    const report = createReport('b', argValue(deps.argv, 'only') ?? 'all')
    const displays = await readDisplays(deps.paths.nativeHelperPath)
    const { overlays, island, home } = openOverlays(displays, deps.preload, deps.load)
    await new Promise((r) => setTimeout(r, 1500))
    displays.forEach((d, i) => {
      const got = overlays[i].getBounds()
      const want = overlayRect(d)
      const same = Math.abs(got.x - want.x) <= 1 && Math.abs(got.y - want.y) <= 1 && Math.abs(got.width - want.width) <= 1 && Math.abs(got.height - want.height) <= 1
      report.add({ name: `overlay covers ${d.name} exactly`, pass: same, details: { got, want, scale: d.scale } })
    })
    const wantIsland = islandRect(home, { width: 360, height: 44 })
    const gotIsland = island.getBounds()
    report.add({ name: 'island sits on the notch at the top edge', pass: gotIsland.x === wantIsland.x && gotIsland.y === wantIsland.y, details: { got: gotIsland, want: wantIsland, notch: home.notch ?? null } })
    const centre = { x: home.frame.x + home.frame.width / 2, y: home.frame.y + home.frame.height / 2 }
    if (argValue(deps.argv, 'only') === 'fullscreen') {
      // Launched with --background while the full-screen fixture's Space is current: nothing may switch it away.
      const desktop = await deps.supervisor.request<{ magenta: number; fixtureOnCurrentSpace: boolean | null }>('spike.b.capture', { mode: 'desktop' }, { timeoutMs: 60_000, signal })
      report.add({ name: 'overlay is visible over a full-screen Space', pass: desktop.fixtureOnCurrentSpace === true && desktop.magenta > 0, details: desktop })
    } else {
      const windowShot = await deps.supervisor.request<{ magenta: number }>('spike.b.capture', { mode: 'window', centre }, { timeoutMs: 60_000, signal })
      report.add({ name: 'window capture excludes the overlay', pass: windowShot.magenta === 0, details: windowShot })
      const desktop = await deps.supervisor.request<{ magenta: number }>('spike.b.capture', { mode: 'desktop' }, { timeoutMs: 60_000, signal })
      report.add({ name: 'display capture includes the overlay (expected on macOS 15+)', pass: null, details: desktop })
      deps.emit('Spike B will click once through the overlay with the real cursor.')
      const click = await deps.supervisor.request<{ clicksBefore: number; clicksAfter: number; clickError: string | null }>('spike.b.capture', { mode: 'click-through' }, { timeoutMs: 60_000, signal })
      report.add({ name: 'a real click passes through the overlay', pass: click.clicksAfter === click.clicksBefore + 1, details: click })
    }
    deps.emit(`spike B report: ${await writeReport(deps.evidenceDir, report.finish())}`)
    setTimeout(() => [...overlays, island].forEach((w) => w.destroy()), 20_000)
  }
  deps.broadcast({ type: 'status', status: { state: 'done', title: name === 'a' ? 'Spike A done' : 'Spike B done' } })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The fixture's title as a fresh agent sees it; retried while the supervisor brings the agent back after a kill. */
async function readFixture(deps: SpikeDeps): Promise<string | undefined> {
  for (let i = 0; i < 12; i++) {
    try {
      const r = await deps.supervisor.request<{ structured: unknown }>('cua.call', { name: 'list_windows', args: { on_screen_only: false } }, { timeoutMs: 3_000 })
      return targetTitle(windowsOf(r.structured))
    } catch {
      await sleep(500)
    }
  }
  return undefined
}

/**
 * Stop, measured (spec §8, Spike A's open failure): start 500 keystrokes into the fixture, press Stop's backstop, and
 * read from the fixture when the last keystroke actually arrived. Exit: quiet within 300 ms at p95 of 5 trials.
 */
async function runStopTest(deps: SpikeDeps) {
  const report = createReport('stop')
  const quiet: number[] = []
  for (let trial = 1; trial <= 5; trial++) {
    const started = await deps.supervisor.request<{ ok: boolean; error?: string }>('spike.stop.type', {}, { timeoutMs: 30_000, signal: deps.signal })
    if (!started.ok) {
      report.add({ name: 'fixture typing started', pass: false, details: started.error })
      break
    }
    const pressedAt = Date.now()
    deps.halt()
    await sleep(2_500) // the agent is killed and restarted
    const title = await readFixture(deps)
    const last = lastInputAt(title)
    const typed = parseTargetTitle(title)?.text ?? null
    const ms = last === null ? -1 : last - pressedAt
    quiet.push(ms)
    report.add({ name: `trial ${trial}: input went quiet ${ms} ms after Stop`, pass: ms >= 0 && ms <= 300 && typed !== null && typed < 500, details: { quietMs: ms, typed } })
  }
  const p95 = percentile(quiet, 95)
  report.add({ name: 'Stop quiets typing within 300 ms (p95 of 5 trials)', pass: quiet.length === 5 && quiet.every((q) => q >= 0) && p95 <= 300, details: { quiet, p95 } })
  deps.emit(`stop report: ${await writeReport(deps.evidenceDir, report.finish({ p95 }))}`)
}
