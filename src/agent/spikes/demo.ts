import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { Mac } from '../mac/visible'
import { windowsOf, windowStateOf, type ElementInfo, type WindowInfo } from '../mac/results'
import { createReport, writeReport } from '../../shared/report'
import type { AgentInit } from '../../shared/protocol'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const KEYS = ['7', 'Multiply', '6', 'Equals'] as const
const TEXT = 'Hello from JevAuto. I can see what I am doing now.'
/** Open Calculator, clear it, four keys, read the answer, open TextEdit, type, read it back. */
const STEPS = 1 + 1 + KEYS.length + 1 + 1 + 1 + 1

type Emit = (name: string, data: unknown) => void

/**
 * A short, visible run for people to watch: Calculator works out 7 × 6 key by key, then TextEdit gets a sentence.
 * Both apps come to the front on purpose, because the cursor is only drawn over what you can see (occlusion rule).
 * Every result is read back from the app, never assumed.
 */
export async function runDemo(mac: Mac, emit: Emit, init: AgentInit, signal: AbortSignal) {
  const report = createReport('demo')
  let n = 0
  const step = (detail: string) => {
    signal.throwIfAborted()
    emit('ui.status', { state: 'working', title: 'Demo', detail, step: { n: ++n, of: STEPS } })
  }
  const started = performance.now()

  step('Opening Calculator')
  const calc = await openApp(mac, 'com.apple.calculator', 'Calculator', [], signal)
  step('Clearing Calculator')
  // The key reads “Clear” while there is input and “All Clear” once there is none: press until it is all clear.
  for (let i = 0; i < 3; i++) {
    const s = await state(mac, calc, signal)
    const key = clearKey(s.elements)
    if (!key) throw new Error('Calculator has no clear key')
    await mac.call('click', { pid: calc.pid, window_id: calc.window_id, element_index: key.element_index, snapshot_id: s.snapshotId }, signal)
    await sleep(260)
    if (key.label === 'All Clear') break
  }
  for (const key of KEYS) {
    step(`Pressing ${key}`)
    const s = await state(mac, calc, signal)
    const button = s.elements.find((e) => e.role === 'AXButton' && e.label === key)
    if (!button) throw new Error(`Calculator has no “${key}” button`)
    await mac.call('click', { pid: calc.pid, window_id: calc.window_id, element_index: button.element_index, snapshot_id: s.snapshotId }, signal)
    await sleep(260) // long enough to watch; the action itself never waits on the animation
  }
  step('Reading the answer')
  const answer = await calculatorDisplay(mac, calc, signal)
  report.add({ name: 'Calculator shows 42', pass: answer === '42', details: { answer } })

  step('Opening TextEdit')
  const sandbox = join(homedir(), 'JevAutoSandbox')
  await mkdir(sandbox, { recursive: true })
  const doc = join(sandbox, 'demo.txt')
  await writeFile(doc, '')
  const text = await openApp(mac, 'com.apple.TextEdit', 'TextEdit', [pathToFileURL(doc).href], signal)
  step('Typing a sentence')
  // TextEdit keeps an open document between runs, so start from an empty page.
  const blank = await state(mac, text, signal)
  const field = blank.elements.find((e) => e.role === 'AXTextArea')
  if (!field) throw new Error('TextEdit shows no text area')
  await mac.call('set_value', { pid: text.pid, window_id: text.window_id, element_index: field.element_index, snapshot_id: blank.snapshotId, value: '' }, signal)
  const s = await state(mac, text, signal)
  const area = s.elements.find((e) => e.role === 'AXTextArea')
  if (!area) throw new Error('TextEdit shows no text area')
  await mac.call('type_text', { pid: text.pid, window_id: text.window_id, element_index: area.element_index, snapshot_id: s.snapshotId, text: TEXT }, signal)
  step('Checking the text')
  const typed = await areaValue(mac, text, signal)
  report.add({ name: 'TextEdit holds exactly the sentence', pass: typed === TEXT, details: { length: typed.length } })

  const ok = answer === '42' && typed === TEXT
  const ms = Math.round(performance.now() - started)
  emit('ui.status', ok ? { state: 'done', title: 'Done', detail: `7 × 6 = ${answer} · typed in TextEdit · ${(ms / 1000).toFixed(1)} s` } : { state: 'error', title: 'Demo check failed', detail: `Calculator showed ${answer || 'nothing'}` })
  const summary = { ok, ms, answer }
  return { file: await writeReport(init.evidenceDir, report.finish(summary)), summary }
}

/** Calculator's top-left key: “All Clear” when empty, “Clear” after input. */
export function clearKey(elements: ElementInfo[]): ElementInfo | undefined {
  return elements.find((e) => e.role === 'AXButton' && (e.label === 'All Clear' || e.label === 'Clear'))
}

async function openApp(mac: Mac, bundleId: string, name: string, urls: string[], signal: AbortSignal): Promise<WindowInfo> {
  const launched = await mac.call('launch_app', { bundle_id: bundleId, name, ...(urls.length ? { urls } : {}) }, signal)
  const pid = z.object({ pid: z.number() }).passthrough().parse(launched.structured).pid
  let window: WindowInfo | undefined
  for (let i = 0; i < 40 && !window; i++) {
    window = windowsOf((await mac.call('list_windows', { pid }, signal)).structured).find(
      (w) => w.is_on_screen !== false && (w.bounds?.width ?? 0) > 100 && Boolean(w.title),
    )
    if (!window) await sleep(150)
  }
  if (!window) throw new Error(`${name} opened no window`)
  await mac.call('bring_to_front', { pid, window_id: window.window_id }, signal)
  await sleep(350)
  return window
}

async function state(mac: Mac, w: WindowInfo, signal: AbortSignal) {
  const r = await mac.call('get_window_state', { pid: w.pid, window_id: w.window_id, include_screenshot: false }, signal)
  return { raw: r, ...windowStateOf(r.structured) }
}

async function areaValue(mac: Mac, w: WindowInfo, signal: AbortSignal): Promise<string> {
  const area: ElementInfo | undefined = (await state(mac, w, signal)).elements.find((e) => e.role === 'AXTextArea')
  return typeof area?.value === 'string' ? area.value : ''
}

/** Calculator's display is a static text in the tree, not an actionable element, so read it from the markdown. */
async function calculatorDisplay(mac: Mac, w: WindowInfo, signal: AbortSignal): Promise<string> {
  const { raw } = await state(mac, w, signal)
  const markdown = String((raw.structured as { tree_markdown?: string })?.tree_markdown ?? '')
  const match = /AXStaticText[^\n]*?"(-?[\d,.]+)"/.exec(markdown)
  return match ? match[1].replace(/,/g, '') : ''
}
