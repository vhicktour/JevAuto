import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { MacDriver } from '../mac/cua'
import { windowsOf, windowStateOf, findElement, type WindowInfo, type ElementInfo } from '../mac/results'
import { readFrontmost, readMouse } from '../../shared/native'
import { createReport, writeReport, percentile } from '../../shared/report'
import type { AgentInit } from '../../shared/protocol'
import type { Rect, Point } from '../frame/frame'

export function parseTargetTitle(title: string | undefined) {
  const m = /clicks=(\d+) \| buttons=(\d+) \| text=(\d+)/.exec(title ?? '')
  return m ? { clicks: Number(m[1]), buttons: Number(m[2]), text: Number(m[3]) } : null
}

export function pngSize(base64: string): { width: number; height: number } | null {
  const header = Buffer.from(base64.slice(0, 44), 'base64')
  if (header.length < 24 || header.toString('ascii', 1, 4) !== 'PNG') return null
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}

export function localPixel(frame: Rect, bounds: Rect, pixelsPerPoint: number): Point {
  return {
    x: Math.round((frame.x + frame.width / 2 - bounds.x) * pixelsPerPoint),
    y: Math.round((frame.y + frame.height / 2 - bounds.y) * pixelsPerPoint),
  }
}

/** Electron lists untitled offscreen windows before the real one, so find the fixture by its title. */
export function targetTitle(windows: WindowInfo[]): string | undefined {
  return windows.find((w) => (w.title ?? '').startsWith('JevAuto Target'))?.title
}

/** The middle of a window's three traffic lights (close, minimize, zoom); Cua reports no subrole to tell them apart. */
export function minimizeButton(elements: ElementInfo[]): ElementInfo | undefined {
  const lights = elements
    .filter((e) => e.role === 'AXButton' && e.depth === 1 && e.frame && e.frame.width <= 24 && e.frame.height <= 24)
    .sort((a, b) => a.frame!.x - b.frame!.x)
  return lights.length === 3 ? lights[1] : undefined
}

export const SpikeAParams = z.object({ only: z.enum(['all', 'offspace']).default('all') })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Keystrokes and pixel clicks reach Chromium as events; give the page a moment before reading its state back. */
const settle = () => sleep(400)
type Trial = { category: string; ok: boolean; ms: number; effect: unknown }

export async function runSpikeA(mac: MacDriver, init: AgentInit, params: z.infer<typeof SpikeAParams>, signal: AbortSignal) {
  const report = createReport('a', params.only)
  const trials: Trial[] = []
  const latency: Record<string, number[]> = {}
  const call = async (name: string, args: Record<string, unknown>, s?: AbortSignal) => {
    const r = await mac.call(name, args, s ?? signal)
    ;(latency[name] ??= []).push(r.durationMs)
    return r
  }
  const state = async (pid: number, windowId: number, screenshot = false) => {
    let r = await call('get_window_state', { pid, window_id: windowId, include_accessibility_tree: true, include_screenshot: screenshot })
    let parsed = windowStateOf(r.structured)
    if (!parsed.elements.length) {
      await sleep(1000) // cold Electron apps can miss web content on the first read (Cua #3782)
      r = await call('get_window_state', { pid, window_id: windowId, include_accessibility_tree: true, include_screenshot: screenshot })
      parsed = windowStateOf(r.structured)
    }
    return { raw: r, ...parsed }
  }
  const areaValue = async (pid: number, windowId: number) => {
    const ta = findElement((await state(pid, windowId)).elements, 'AXTextArea')
    return typeof ta?.value === 'string' ? ta.value : ''
  }
  const targetWindow = async (): Promise<WindowInfo | undefined> =>
    windowsOf((await call('list_windows', { on_screen_only: false })).structured).find((w) => (w.title ?? '').startsWith('JevAuto Target'))
  const targetState = async (pid: number) => parseTargetTitle(targetTitle(windowsOf((await call('list_windows', { pid })).structured)))

  const frontBefore = await readFrontmost(init.nativeHelperPath)
  const target = await targetWindow()
  if (!target) {
    report.add({ name: 'fixture running', pass: false, details: 'Start `pnpm fixture:electron` first.' })
    return { file: await writeReport(init.evidenceDir, report.finish()), summary: {} }
  }

  // A cold Electron window exposes only its chrome until AX has walked the page once (Cua #3782).
  for (let i = 0; i < 10 && !findElement((await state(target.pid, target.window_id)).elements, 'AXButton', 'Add one'); i++) await sleep(500)

  if (params.only === 'offspace') {
    // An element click is the Electron action that works in the background (see the 'all' run), so the Space is the only variable.
    const onCurrentSpace = (target as { on_current_space?: boolean | null }).on_current_space ?? null
    const s = await state(target.pid, target.window_id, true)
    const add = findElement(s.elements, 'AXButton', 'Add one')
    const before = await targetState(target.pid)
    const clicked = add ? await call('click', { pid: target.pid, window_id: target.window_id, element_index: add.element_index, snapshot_id: s.snapshotId }) : undefined
    await settle()
    const afterClick = await targetState(target.pid)
    const ok = (afterClick?.clicks ?? 0) === (before?.clicks ?? 0) + 1
    report.add({
      name: 'act on a window on another Space',
      pass: onCurrentSpace === false && ok,
      details: {
        onCurrentSpace,
        elementCount: s.elements.length,
        hasScreenshot: s.raw.imageCount > 0,
        cuaReason: String((s.raw.structured as { degraded_reason?: string })?.degraded_reason ?? '').slice(0, 240) || null,
        clickError: clicked?.isError ? clicked.text.slice(0, 200) : null,
      },
    })
    // Observed: pixel-form typing (keystrokes) into the off-Space window.
    const notes = findElement(s.elements, 'AXTextArea', 'Notes')
    const shot = s.raw.images[0] ? pngSize(s.raw.images[0].dataBase64) : null
    let typedOk: boolean | null = null
    if (notes?.frame && target.bounds && shot) {
      const q = localPixel(notes.frame, target.bounds, shot.width / target.bounds.width)
      await call('type_text', { pid: target.pid, window_id: target.window_id, x: q.x, y: q.y, text: 'off' })
      await settle()
      typedOk = ((await targetState(target.pid))?.text ?? 0) === (afterClick?.text ?? 0) + 3
    }
    report.add({ name: 'pixel-form typing into the off-Space window', pass: null, details: { landed: typedOk } })
    return { file: await writeReport(init.evidenceDir, report.finish()), summary: { offspace: onCurrentSpace === false && ok } }
  }

  // Setup: two TextEdit documents in the sandbox, opened in the background.
  const sandbox = join(homedir(), 'JevAutoSandbox')
  await mkdir(sandbox, { recursive: true })
  const doc1 = join(sandbox, 'spike-a-1.txt')
  const doc2 = join(sandbox, 'spike-a-2.txt')
  await writeFile(doc1, 'first document\n')
  await writeFile(doc2, 'second document\n')
  const launched = await call('launch_app', { bundle_id: 'com.apple.TextEdit', urls: [pathToFileURL(doc1).href, pathToFileURL(doc2).href] })
  const pid = z.object({ pid: z.number() }).passthrough().parse(launched.structured).pid
  let w1: WindowInfo | undefined
  let w2: WindowInfo | undefined
  for (let i = 0; i < 25 && !(w1 && w2); i++) {
    await sleep(200)
    const ws = windowsOf((await call('list_windows', { pid })).structured)
    w1 = ws.find((w) => (w.title ?? '').includes('spike-a-1'))
    w2 = ws.find((w) => (w.title ?? '').includes('spike-a-2'))
  }
  report.add({ name: 'TextEdit opened both documents in the background', pass: Boolean(w1 && w2), details: { launchState: launched.structured } })
  if (!w1 || !w2) return { file: await writeReport(init.evidenceDir, report.finish()), summary: {} }

  // 50 verified background trials, 10 per category (exit: at least 45 confirmed).
  for (let i = 0; i < 10; i++) {
    for (const [category, win, token] of [['textedit type doc1', w1, `a${i}`], ['textedit type doc2', w2, `b${i}`]] as const) {
      const s = await state(pid, win.window_id)
      const ta = findElement(s.elements, 'AXTextArea')
      const started = performance.now()
      const r = ta ? await call('type_text', { pid, window_id: win.window_id, element_index: ta.element_index, snapshot_id: s.snapshotId, text: ` ${token}` }) : undefined
      trials.push({ category, ok: (await areaValue(pid, win.window_id)).includes(token), ms: performance.now() - started, effect: r?.action })
    }
    const s = await state(target.pid, target.window_id, true)
    const add = findElement(s.elements, 'AXButton', 'Add one')
    const notes = findElement(s.elements, 'AXTextArea', 'Notes')
    const before = await targetState(target.pid)

    let started = performance.now()
    const clicked = add ? await call('click', { pid: target.pid, window_id: target.window_id, element_index: add.element_index, snapshot_id: s.snapshotId }) : undefined
    await settle()
    const afterClick = await targetState(target.pid)
    trials.push({ category: 'electron click by element', ok: (afterClick?.clicks ?? 0) === (before?.clicks ?? 0) + 1, ms: performance.now() - started, effect: clicked?.action })

    started = performance.now()
    const typed = notes ? await call('type_text', { pid: target.pid, window_id: target.window_id, element_index: notes.element_index, snapshot_id: s.snapshotId, text: 'x' }) : undefined
    await settle()
    const afterType = await targetState(target.pid)
    trials.push({ category: 'electron type by element', ok: (afterType?.text ?? 0) === (afterClick?.text ?? 0) + 1, ms: performance.now() - started, effect: typed?.action })

    // Pixel path: element frame (screen points) → window-local screenshot pixels, checked against the real window.
    const shot = s.raw.images[0]
    const size = shot ? pngSize(shot.dataBase64) : null
    started = performance.now()
    let pixelOk = false
    if (add?.frame && target.bounds && size) {
      const p = localPixel(add.frame, target.bounds, size.width / target.bounds.width)
      await call('click', { pid: target.pid, window_id: target.window_id, x: p.x, y: p.y })
      await settle()
      pixelOk = ((await targetState(target.pid))?.clicks ?? 0) === (afterType?.clicks ?? 0) + 1
    }
    trials.push({ category: 'electron click by pixel', ok: pixelOk, ms: performance.now() - started, effect: null })

    // Outside the 50: Cua's documented path for web content, click the field by pixel then type, in one call.
    started = performance.now()
    let pixelTypeOk = false
    if (notes?.frame && target.bounds && size) {
      const beforeType = await targetState(target.pid)
      const q = localPixel(notes.frame, target.bounds, size.width / target.bounds.width)
      await call('type_text', { pid: target.pid, window_id: target.window_id, x: q.x, y: q.y, text: 'z' })
      await settle()
      pixelTypeOk = ((await targetState(target.pid))?.text ?? 0) === (beforeType?.text ?? 0) + 1
    }
    trials.push({ category: 'electron type by pixel (observed)', ok: pixelTypeOk, ms: performance.now() - started, effect: null })
  }
  const counted = trials.filter((t) => !t.category.endsWith('(observed)'))
  const confirmed = counted.filter((t) => t.ok).length
  report.add({ name: 'at least 45 of 50 background trials confirmed by read-back', pass: confirmed >= 45, details: { confirmed, of: counted.length, byCategory: Object.fromEntries([...new Set(trials.map((t) => t.category))].map((c) => [c, trials.filter((t) => t.category === c && t.ok).length])) } })

  // Two-window key routing: keys are process-scoped (SLEventPostToPid), so record where a bare key lands.
  const v1 = await areaValue(pid, w1.window_id)
  const v2 = await areaValue(pid, w2.window_id)
  const bare = await call('press_key', { pid, window_id: w1.window_id, key: 'q' })
  await sleep(500) // posted key events arrive asynchronously
  const landed = { doc1: (await areaValue(pid, w1.window_id)).length - v1.length, doc2: (await areaValue(pid, w2.window_id)).length - v2.length }
  // The product would focus the field first; any get_window_state on this app invalidates the snapshot, so take it last.
  const u1 = await areaValue(pid, w1.window_id)
  const u2 = await areaValue(pid, w2.window_id)
  const focused = await state(pid, w1.window_id)
  const field = findElement(focused.elements, 'AXTextArea')
  const keyed = field ? await call('press_key', { pid, window_id: w1.window_id, key: 'k', element_index: field.element_index, snapshot_id: focused.snapshotId }) : undefined
  await sleep(500)
  const landedFocused = { doc1: (await areaValue(pid, w1.window_id)).length - u1.length, doc2: (await areaValue(pid, w2.window_id)).length - u2.length }
  // Spec §4: a key must never land in a sibling window. Where it does land (or why Cua refused it) is recorded.
  report.add({ name: 'a key aimed at doc1 never lands in doc2', pass: landed.doc2 === 0 && landedFocused.doc2 === 0 })
  report.add({
    name: 'where a key aimed at doc1 of two lands',
    pass: null,
    details: {
      bare: { ...landed, refused: bare.isError ? bare.text.slice(0, 240) : null },
      focusedField: { ...landedFocused, refused: keyed?.isError ? keyed.text.slice(0, 240) : null },
    },
  })

  // Menu path.
  const menu = await call('invoke_menu', { pid, window_id: w1.window_id, path: ['Edit', 'Select All'] })
  await call('press_key', { pid, window_id: w1.window_id, key: 'delete' })
  report.add({ name: 'menu path Edit › Select All then delete empties doc1', pass: !menu.isError && (await areaValue(pid, w1.window_id)).trim() === '', details: { menuError: menu.isError ? menu.text : null } })

  // Sheet: Page Setup opens a sheet on the window; cancel it by element.
  const pageSetup = await call('invoke_menu', { pid, window_id: w1.window_id, path: ['File', 'Page Setup…'] })
  await sleep(800)
  const withSheet = await state(pid, w1.window_id)
  const sheet = withSheet.elements.find((e: ElementInfo) => e.role === 'AXSheet')
  const cancel = findElement(withSheet.elements, 'AXButton', 'Cancel')
  if (cancel) await call('click', { pid, window_id: w1.window_id, element_index: cancel.element_index, snapshot_id: withSheet.snapshotId })
  await sleep(500)
  const afterSheet = await state(pid, w1.window_id)
  report.add({ name: 'sheet opens and closes by element', pass: Boolean(sheet && cancel) && !afterSheet.elements.some((e) => e.role === 'AXSheet'), details: { sheetOpened: Boolean(sheet), pageSetupMenuError: pageSetup.isError ? pageSetup.text.slice(0, 240) : null } })

  // Minimised window: keyboard commit needs focus, set_value does not (Cua limits). invoke_menu needs the app
  // frontmost, so minimise with the window's own button, pressed through AX in the background.
  const beforeMin = await state(pid, w2.window_id)
  const minButton = minimizeButton(beforeMin.elements)
  if (minButton) await call('click', { pid, window_id: w2.window_id, element_index: minButton.element_index, snapshot_id: beforeMin.snapshotId })
  await sleep(1000)
  const minimised = windowsOf((await call('list_windows', { pid })).structured).find((w) => w.window_id === w2.window_id)?.is_on_screen === false
  const min = await state(pid, w2.window_id)
  const minArea = findElement(min.elements, 'AXTextArea')
  if (minArea) await call('set_value', { pid, window_id: w2.window_id, element_index: minArea.element_index, snapshot_id: min.snapshotId, value: 'minimised write' })
  report.add({ name: 'set_value works on a minimised window', pass: minimised && (await areaValue(pid, w2.window_id)) === 'minimised write', details: { minimised, minButtonFound: Boolean(minButton), elementCount: min.elements.length } })

  // Stop during a 500-character type: abort at 300 ms; typing must go quiet. An element write is one atomic AX
  // insert, so use type_text's pixel form (click the field, then synthesise keystrokes: ~23 s for 500 at 30 ms).
  const s = await state(target.pid, target.window_id, true)
  const notes = findElement(s.elements, 'AXTextArea', 'Notes')
  if (notes) await call('set_value', { pid: target.pid, window_id: target.window_id, element_index: notes.element_index, snapshot_id: s.snapshotId, value: '' })
  const stopShot = s.raw.images[0] ? pngSize(s.raw.images[0].dataBase64) : null
  const notesPx = notes?.frame && target.bounds && stopShot ? localPixel(notes.frame, target.bounds, stopShot.width / target.bounds.width) : null
  const stopper = new AbortController()
  const typing = notesPx
    ? mac.call('type_text', { pid: target.pid, window_id: target.window_id, x: notesPx.x, y: notesPx.y, text: 'x'.repeat(500), delay_ms: 30 }, stopper.signal)
    : Promise.resolve(undefined)
  await sleep(300)
  const abortedAt = performance.now()
  stopper.abort()
  let stopLatencyMs = -1
  await typing.then(() => {}, () => {}).finally(() => { stopLatencyMs = Math.round(performance.now() - abortedAt) })
  const samples: number[] = []
  for (const wait of [0, 500, 1000]) {
    await sleep(wait)
    samples.push((await targetState(target.pid))?.text ?? -1)
  }
  report.add({
    name: 'Stop quiets a long type within 300 ms',
    pass: stopLatencyMs >= 0 && stopLatencyMs <= 300 && samples[0] === samples[2] && samples[2] < 500,
    details: { stopLatencyMs, lengths: samples },
  })

  // Held button released on Stop: abort a 3 s drag at 500 ms, then check the page and global state.
  const shot = s.raw.images[0] ?? (await state(target.pid, target.window_id, true)).raw.images[0]
  const size = shot ? pngSize(shot.dataBase64) : null
  const pad = s.elements.find((e) => (e.label ?? '').includes('Drag pad'))
  if (pad?.frame && target.bounds && size) {
    const scale = size.width / target.bounds.width
    const from = localPixel({ ...pad.frame, width: 10 }, target.bounds, scale)
    const to = localPixel({ ...pad.frame, x: pad.frame.x + pad.frame.width - 10, width: 10 }, target.bounds, scale)
    const dragStop = new AbortController()
    const drag = mac.call('drag', { pid: target.pid, window_id: target.window_id, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, duration_ms: 3000, steps: 60 }, dragStop.signal)
    await sleep(500)
    dragStop.abort()
    await drag.then(() => {}, () => {})
    await sleep(300)
    const page = await targetState(target.pid)
    const mouse = await readMouse(init.nativeHelperPath)
    report.add({ name: 'aborted drag leaves no button held', pass: page?.buttons === 0 && mouse.pressedButtons === 0, details: { pageButtons: page?.buttons, globalButtons: mouse.pressedButtons } })
  } else report.add({ name: 'aborted drag leaves no button held', pass: false, details: 'Drag pad element or screenshot missing' })

  const frontAfter = await readFrontmost(init.nativeHelperPath)
  report.add({ name: 'background work never changed the frontmost app', pass: frontBefore.bundleId === frontAfter.bundleId, details: { before: frontBefore.bundleId, after: frontAfter.bundleId } })
  report.add({
    name: 'latency per tool (ms)',
    pass: null,
    details: Object.fromEntries(Object.entries(latency).map(([k, v]) => [k, { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95) }])),
  })
  await call('kill_app', { pid })
  const summary = { confirmed, trials: counted.length }
  return { file: await writeReport(init.evidenceDir, report.finish(summary)), summary }
}
