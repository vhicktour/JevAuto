import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { runTask, groupCalls, type Approval, type Answer, type RunDeps } from '../src/agent/loop/run'
import type { Adapter, CallResult, Turn } from '../src/agent/loop/adapter'
import type { Mac } from '../src/agent/mac/visible'
import type { CuaResult } from '../src/agent/mac/cua'
import type { IrAction, SafetySignal } from '../src/agent/providers/ir'
import type { Focus } from '../src/shared/native'

// ---- a small fake Mac: windows, apps, element snapshots, screenshots, and a record of every call ----

type Win = { window_id: number; pid: number; app_name: string; title: string; bounds: { x: number; y: number; width: number; height: number }; z_index: number; colour: number }
type Call = { name: string; args: Record<string, unknown> }

const pngCache = new Map<string, string>()
async function png(width: number, height: number, colour: number) {
  const key = `${width}x${height}:${colour}`
  if (!pngCache.has(key))
    pngCache.set(key, (await sharp({ create: { width, height, channels: 3, background: { r: colour, g: 255 - colour, b: 90 } } }).png().toBuffer()).toString('base64'))
  return pngCache.get(key)!
}
const ok = (structured: unknown = {}, images: CuaResult['images'] = []): CuaResult => ({ text: 'ok', imageCount: images.length, images, structured, isError: false, durationMs: 1 })
const fail = (code: string, text = code): CuaResult => ({ text, imageCount: 0, images: [], structured: { code, effect: 'refused' }, isError: true, durationMs: 1 })

class World implements Mac {
  calls: Call[] = []
  windows: Win[] = [{ window_id: 7, pid: 42, app_name: 'Mail', title: 'New Message', bounds: { x: 100, y: 50, width: 640, height: 400 }, z_index: 10, colour: 10 }]
  apps = [
    { pid: 42, bundle_id: 'com.apple.mail', name: 'Mail', running: true },
    { pid: 0, bundle_id: 'com.apple.TextEdit', name: 'TextEdit', running: false },
    { pid: 0, bundle_id: 'com.apple.Safari', name: 'Safari', running: false },
  ]
  elements: Record<number, unknown[]> = {
    7: [
      { element_index: 0, role: 'AXWindow', label: 'New Message', frame: { x: 100, y: 50, w: 640, h: 400 } },
      { element_index: 1, role: 'AXButton', label: 'Send', frame: { x: 110, y: 60, w: 40, h: 20 } },
      { element_index: 2, role: 'AXButton', label: 'Bold', frame: { x: 160, y: 60, w: 40, h: 20 } },
      { element_index: 3, role: 'AXTextArea', value: '', frame: { x: 100, y: 100, w: 640, h: 350 } },
    ],
  }
  failures = new Map<string, CuaResult>()
  after?: (call: Call, world: World) => void
  private snapshots = 0

  async call(name: string, args: Record<string, unknown>): Promise<CuaResult> {
    const call = { name, args }
    this.calls.push(call)
    const failure = this.failures.get(name)
    if (failure) return failure
    let result: CuaResult
    if (name === 'list_apps') result = ok({ apps: this.apps })
    else if (name === 'list_windows') result = ok({ windows: this.windows.filter((w) => args.pid === undefined || w.pid === args.pid).map((w) => ({ ...w, layer: 0, is_on_screen: true })) })
    else if (name === 'get_window_state') {
      const w = this.windows.find((x) => x.window_id === args.window_id)
      if (!w) return fail('window_id_not_found')
      const snapshot = `s${++this.snapshots}`
      const state = { snapshot_id: snapshot, window_id: w.window_id, app_name: w.app_name, window_title: w.title, window_bounds: w.bounds, screenshot_width: w.bounds.width * 2, screenshot_height: w.bounds.height * 2, elements: this.elements[w.window_id] ?? [] }
      result = args.include_screenshot === false ? ok(state) : ok(state, [{ mimeType: 'image/png', dataBase64: await png(w.bounds.width * 2, w.bounds.height * 2, w.colour) }])
    } else if (name === 'launch_app') {
      const app = this.apps.find((a) => a.bundle_id === args.bundle_id)!
      app.pid = 77
      app.running = true
      this.windows.push({ window_id: 70, pid: 77, app_name: app.name, title: 'Untitled', bounds: { x: 0, y: 0, width: 500, height: 300 }, z_index: 20, colour: 200 })
      result = ok({ pid: 77, bundle_id: app.bundle_id, name: app.name, windows: [] })
    } else {
      // An acting call changes what the window shows, unless a test says otherwise.
      const w = this.windows.find((x) => x.window_id === args.window_id)
      if (w) w.colour = (w.colour + 60) % 250
      result = ok({ effect: 'unverifiable' })
    }
    this.after?.(call, this)
    return result
  }
  async close() {}
  acted = () => this.calls.filter((c) => ['click', 'type_text', 'press_key', 'hotkey', 'scroll', 'drag'].includes(c.name))
}

// ---- a scripted model ----

type Step = { actions?: IrAction[]; text?: string[]; refusal?: boolean; safety?: SafetySignal[] }
class Script implements Adapter {
  readonly provider = 'openai' as const
  readonly model = 'gpt-6-sol'
  readonly canvas = { width: 1280, height: 800 }
  starts: { task: string; context: string; image?: string }[] = []
  nexts: { results: CallResult[]; image?: string; notes: string[] }[] = []
  private n = 0
  constructor(private readonly steps: Step[]) {}
  async start(input: { task: string; context: string; image?: string }) {
    this.starts.push(input)
    return this.take()
  }
  async next(input: { results: CallResult[]; image?: string; notes: string[] }) {
    this.nexts.push(input)
    return this.take()
  }
  private take(): Turn {
    const s = this.steps[this.n++] ?? { text: ['Finished.'] }
    return { id: `r${this.n}`, actions: s.actions ?? [], text: s.text ?? [], refusal: s.refusal ?? false, safety: s.safety ?? [], usage: { inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 10 } }
  }
}

const click = (callId: string, x: number, y: number): IrAction => ({ kind: 'click', callId, x, y, space: 'pixels', button: 'left' })
const done = (callId: string, summary = 'All done.'): IrAction => ({ kind: 'tool', callId, name: 'done', input: { status: 'success', summary } })
// Mail's window is 640×400 pt at 2×: a 1280×800 capture, so canvas pixels equal capture pixels and points are half.
const SEND = click('c1', 2 * (130 - 100), 2 * (70 - 50))
const BOLD = (callId: string) => click(callId, 2 * (180 - 100), 2 * (70 - 50))
const TEXT_AREA_FOCUS: Focus = { ok: true, role: 'AXTextArea', frame: { x: 100, y: 100, width: 640, height: 350 }, webArea: false, secure: false }

function deps(world: World, script: Script, extra: Partial<RunDeps> = {}) {
  const approvals: Approval[] = []
  const events: string[] = []
  const d: RunDeps = {
    task: 'Write the email',
    adapter: script,
    mac: world,
    focus: async () => TEXT_AREA_FOCUS,
    approve: async (a): Promise<Answer> => (approvals.push(a), 'once'),
    ask: async () => 'Tuesday',
    log: { write: (event) => void events.push(event) },
    signal: new AbortController().signal,
    ...extra,
  }
  return { d, approvals, events }
}

test('groupCalls keeps call order and puts a batch under one call', () => {
  const calls = groupCalls([click('c1', 1, 1), { kind: 'type', callId: 'c1', text: 'x' }, done('f1'), click('c2', 2, 2)])
  assert.deepEqual(calls.map((c) => [c.callId, c.kind, c.actions.length]), [['c1', 'computer', 2], ['f1', 'function', 1], ['c2', 'computer', 1]])
})

test('the first request shows the frontmost window and names the others', async () => {
  const world = new World()
  world.windows.push({ window_id: 8, pid: 43, app_name: 'Notes', title: 'Groceries', bounds: { x: 0, y: 0, width: 300, height: 300 }, z_index: 5, colour: 50 })
  const script = new Script([{ actions: [done('f1')] }])
  const result = await runTask(deps(world, script).d)
  assert.equal(result.status, 'success')
  const { context, image } = script.starts[0]
  assert.match(context, /Mail — “New Message” \(window 7\)/)
  assert.match(context, /Notes — “Groceries” \(window 8\)/)
  const meta = await sharp(Buffer.from(image!, 'base64')).metadata()
  assert.deepEqual([meta.width, meta.height], [1280, 800])
})

test('a refusal discards the turn: nothing it contained runs', async () => {
  const world = new World()
  const result = await runTask(deps(world, new Script([{ actions: [BOLD('c1')], refusal: true, text: ['I cannot help with that.'] }])).d)
  assert.equal(result.status, 'refused')
  assert.equal(world.acted().length, 0)
})

test('a failure halts the rest of the turn, and every call still gets exactly one answer', async () => {
  const world = new World()
  world.failures.set('hotkey', fail('same_pid_keyboard_ambiguity_x', 'hotkey refused'))
  const script = new Script([
    {
      actions: [
        BOLD('c1'),
        { kind: 'keys', callId: 'c1', keys: ['CMD', 'B'] },
        { kind: 'type', callId: 'c1', text: 'never typed' },
        { kind: 'tool', callId: 'f1', name: 'list_windows', input: {} },
      ],
    },
    { actions: [done('f2')] },
  ])
  await runTask(deps(world, script).d)
  assert.deepEqual(world.acted().map((c) => c.name), ['click', 'hotkey'])
  const { results, notes } = script.nexts[0]
  assert.deepEqual(results.map((r) => [r.callId, r.kind]), [['c1', 'computer'], ['f1', 'function']])
  assert.match((results[1] as { output: string }).output, /Not executed/)
  assert.match(notes.join(' '), /hotkey refused/)
  assert.match(notes.join(' '), /Not run: type “never typed”/)
})

test('a consequential click waits for approval; declining halts the turn and tells the model', async () => {
  const world = new World()
  const script = new Script([{ actions: [SEND, BOLD('c1')] }, { actions: [done('f1')] }])
  const { d, approvals } = deps(world, script, { approve: async (a) => (approvals.push(a), 'deny') })
  await runTask(d)
  assert.equal(approvals.length, 1)
  assert.match(approvals[0].reason, /Send/)
  assert.equal(world.acted().length, 0)
  assert.match(script.nexts[0].notes.join(' '), /declined/)
})

test('an approved click is re-checked against a fresh snapshot before it runs', async () => {
  const world = new World()
  const script = new Script([{ actions: [SEND] }, { actions: [done('f1')] }])
  const { d, approvals } = deps(world, script, {
    approve: async (a) => {
      approvals.push(a)
      // While you read the prompt, the button moves away.
      world.elements[7] = world.elements[7].filter((e) => (e as { label?: string }).label !== 'Send')
      return 'once'
    },
  })
  await runTask(d)
  assert.equal(world.acted().length, 0)
  assert.match(script.nexts[0].notes.join(' '), /changed while waiting/)
})

test('a provider safety check is acknowledged only after you allow it; declining ends the run', async () => {
  const check = [{ id: 's1', code: 'malicious_instructions', message: 'The page asks for a login.' }]
  const allowWorld = new World()
  const allowed = new Script([{ actions: [BOLD('c1')], safety: [{ provider: 'openai', callId: 'c1', detail: check }] }, { actions: [done('f1')] }])
  await runTask(deps(allowWorld, allowed).d)
  assert.deepEqual((allowed.nexts[0].results[0] as { acknowledged?: unknown[] }).acknowledged, check)
  assert.equal(allowWorld.acted().length, 1)

  const denyWorld = new World()
  const denied = new Script([{ actions: [BOLD('c1')], safety: [{ provider: 'openai', callId: 'c1', detail: check }] }])
  const result = await runTask(deps(denyWorld, denied, { approve: async () => 'deny' }).d)
  assert.equal(result.status, 'stopped')
  assert.equal(denyWorld.acted().length, 0)
})

test('typing goes to the focused element by index; a password field is refused', async () => {
  const world = new World()
  const script = new Script([{ actions: [{ kind: 'type', callId: 'c1', text: 'Hello' }] }, { actions: [done('f1')] }])
  await runTask(deps(world, script).d)
  const typed = world.calls.find((c) => c.name === 'type_text')!
  assert.equal(typed.args.element_index, 3)
  assert.equal(typeof typed.args.snapshot_id, 'string')

  const secureWorld = new World()
  const secure = new Script([{ actions: [{ kind: 'type', callId: 'c1', text: 'hunter2' }] }, { actions: [done('f1')] }])
  await runTask(deps(secureWorld, secure, { focus: async () => ({ ok: true, role: 'AXTextField', subrole: 'AXSecureTextField', webArea: false, secure: true }) }).d)
  assert.equal(secureWorld.acted().length, 0)
  assert.match(secure.nexts[0].notes.join(' '), /password/)
})

test('keys refused for another open window are retried in front only with your OK', async () => {
  const world = new World()
  let foreground = 0
  world.after = (call, w) => {
    if (call.name === 'press_key' && call.args.delivery_mode !== 'foreground') w.failures.set('press_key', fail('same_pid_keyboard_ambiguity'))
    if (call.name === 'press_key' && call.args.delivery_mode === 'foreground') foreground++
  }
  const script = new Script([{ actions: [{ kind: 'keys', callId: 'c1', keys: ['TAB'] }] }, { actions: [done('f1')] }])
  const { d, approvals } = deps(world, script, {
    approve: async (a) => {
      approvals.push(a)
      world.failures.delete('press_key')
      return 'once'
    },
  })
  // The first press is refused by the fake before `after` runs, so arm the refusal up front.
  world.failures.set('press_key', fail('same_pid_keyboard_ambiguity'))
  await runTask(d)
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].kind, 'foreground')
  assert.equal(foreground, 1)
})

test('switching the target mid-turn halts the pointer actions that were aimed at the old window', async () => {
  const world = new World()
  world.windows.push({ window_id: 8, pid: 43, app_name: 'Notes', title: 'Groceries', bounds: { x: 0, y: 0, width: 300, height: 300 }, z_index: 5, colour: 50 })
  world.elements[8] = []
  world.apps.push({ pid: 43, bundle_id: 'com.apple.Notes', name: 'Notes', running: true })
  const script = new Script([{ actions: [{ kind: 'tool', callId: 'f1', name: 'switch_target', input: { window_id: 8 } }, BOLD('c1')] }, { actions: [done('f2')] }])
  await runTask(deps(world, script).d)
  assert.equal(world.acted().length, 0)
  assert.match(script.nexts[0].notes.join(' '), /target window changed/)
  assert.ok(world.calls.some((c) => c.name === 'get_window_state' && c.args.window_id === 8))
})

test('a new window from the same app becomes the target, and the model is told', async () => {
  const world = new World()
  world.after = (call, w) => {
    if (call.name === 'click' && !w.windows.some((x) => x.window_id === 9))
      w.windows.push({ window_id: 9, pid: 42, app_name: 'Mail', title: 'Save', bounds: { x: 200, y: 100, width: 300, height: 200 }, z_index: 11, colour: 99 })
  }
  const script = new Script([{ actions: [BOLD('c1')] }, { actions: [done('f1')] }])
  await runTask(deps(world, script).d)
  assert.match(script.nexts[0].notes.join(' '), /Mail — “Save” \(window 9\)/)
  const last = world.calls.filter((c) => c.name === 'get_window_state').pop()!
  assert.equal(last.args.window_id, 9)
})

test('open_app launches an app in the background and targets its window; excluded apps are refused', async () => {
  const world = new World()
  world.windows = []
  const script = new Script([
    { actions: [{ kind: 'tool', callId: 'f1', name: 'open_app', input: { name: 'Safari' } }] },
    { actions: [{ kind: 'tool', callId: 'f2', name: 'open_app', input: { name: 'textedit' } }] },
    { actions: [done('f3')] },
  ])
  await runTask(deps(world, script).d)
  assert.match(script.starts[0].context, /No window is targeted/)
  assert.match((script.nexts[0].results[0] as { output: string }).output, /off limits/)
  assert.ok(world.calls.some((c) => c.name === 'launch_app' && c.args.bundle_id === 'com.apple.TextEdit'))
  assert.ok(!world.calls.some((c) => c.name === 'launch_app' && c.args.bundle_id === 'com.apple.Safari'))
  assert.match((script.nexts[1].results[0] as { output: string }).output, /TextEdit/)
})

test('the action budget stops the run unless you extend it', async () => {
  const world = new World()
  const script = new Script(Array.from({ length: 10 }, (_, i) => ({ actions: [BOLD(`c${i}`)] })))
  const { d, approvals } = deps(world, script, { budget: { maxActions: 2, maxMs: 60_000, maxUsd: 5 }, approve: async (a) => (approvals.push(a), 'deny') })
  const result = await runTask(d)
  assert.equal(result.status, 'budget')
  assert.equal(world.acted().length, 2)
  assert.equal(approvals.at(-1)?.kind, 'budget')
})

test('three rounds of actions with no visible change end the run as a stall', async () => {
  const world = new World()
  world.after = (call, w) => {
    if (call.name === 'click') w.windows[0].colour = 10 // the click does nothing
  }
  const script = new Script(Array.from({ length: 10 }, (_, i) => ({ actions: [BOLD(`c${i}`)] })))
  const result = await runTask(deps(world, script).d)
  assert.equal(result.status, 'stall')
  assert.equal(world.acted().length, 3)
  assert.match(script.nexts[0].notes.join(' '), /looks the same/)
})

test('Stop mid-batch runs nothing further and reports stopped', async () => {
  const world = new World()
  const controller = new AbortController()
  world.after = (call) => {
    if (call.name === 'click') controller.abort()
  }
  const script = new Script([{ actions: [BOLD('c1'), BOLD('c1'), BOLD('c1')] }])
  const { d, events } = deps(world, script, { signal: controller.signal })
  const result = await runTask(d)
  assert.equal(result.status, 'stopped')
  assert.equal(world.acted().length, 1)
  assert.equal(events.at(-1), 'run.end')
})

test('done ends the run with the model’s status and summary; ask_user relays your answer', async () => {
  const world = new World()
  const script = new Script([
    { actions: [{ kind: 'tool', callId: 'f1', name: 'ask_user', input: { question: 'Which day?' } }] },
    { actions: [{ kind: 'tool', callId: 'f2', name: 'done', input: { status: 'blocked', summary: 'Needs a login.' } }] },
  ])
  const result = await runTask(deps(world, script).d)
  assert.deepEqual([result.status, result.summary], ['blocked', 'Needs a login.'])
  assert.match((script.nexts[0].results[0] as { output: string }).output, /Tuesday/)
})

test('a click on the letterbox padding is refused before anything runs', async () => {
  const world = new World()
  world.windows[0].bounds = { x: 100, y: 50, width: 200, height: 400 } // 400×800 capture: the right of the canvas is padding
  const script = new Script([{ actions: [click('c1', 1000, 100)] }, { actions: [done('f1')] }])
  await runTask(deps(world, script).d)
  assert.equal(world.acted().length, 0)
  assert.match(script.nexts[0].notes.join(' '), /outside the window/)
})
