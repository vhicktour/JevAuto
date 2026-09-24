import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { observe, sameFrame, ObserveError, type Observation } from '../src/agent/loop/observe'
import { planAction, planType, elementAt, runPlan, focusedElement } from '../src/agent/loop/execute'
import type { Mac } from '../src/agent/mac/visible'
import type { CuaResult } from '../src/agent/mac/cua'
import type { IrAction } from '../src/agent/providers/ir'

const ok = (structured: unknown = {}, images: CuaResult['images'] = []): CuaResult => ({ text: 'ok', imageCount: images.length, images, structured, isError: false, durationMs: 1 })

async function pngOf(width: number, height: number, colour = { r: 200, g: 40, b: 40 }) {
  return (await sharp({ create: { width, height, channels: 3, background: colour } }).png().toBuffer()).toString('base64')
}

const ELEMENTS = [
  { element_index: 0, role: 'AXWindow', label: 'Doc', frame: { x: 100, y: 50, w: 800, h: 500 } },
  { element_index: 1, role: 'AXGroup', frame: { x: 100, y: 80, w: 800, h: 470 } },
  { element_index: 2, role: 'AXButton', label: 'Send', frame: { x: 120, y: 90, w: 60, h: 20 } },
  { element_index: 3, role: 'AXTextArea', value: 'hi', frame: { x: 100, y: 120, w: 800, h: 430 } },
]

function fakeMac(png: string, calls: { name: string; args: Record<string, unknown> }[] = []): Mac {
  return {
    call: async (name, args) => {
      calls.push({ name, args })
      if (name === 'get_window_state')
        return ok(
          { snapshot_id: 's1', window_id: 7, app_name: 'Mail', window_title: 'New Message', window_bounds: { x: 100, y: 50, width: 800, height: 500 }, screenshot_width: 1600, screenshot_height: 1000, elements: ELEMENTS },
          [{ mimeType: 'image/png', dataBase64: png }],
        )
      return ok({ effect: 'unverifiable' })
    },
    close: async () => {},
  }
}

async function observation(): Promise<Observation> {
  return observe(fakeMac(await pngOf(1600, 1000)), { pid: 42, windowId: 7, app: 'Mail' }, { width: 1280, height: 800 })
}

test('observe letterboxes the window capture onto the run canvas and keeps the Frame', async () => {
  const obs = await observation()
  const meta = await sharp(Buffer.from(obs.image, 'base64')).metadata()
  assert.deepEqual([meta.width, meta.height], [1280, 800])
  assert.deepEqual(obs.frame.capture, { width: 1600, height: 1000 })
  assert.deepEqual(obs.frame.letterbox.content, { width: 1280, height: 800 })
  assert.equal(obs.frame.pixelsPerPoint, 2)
  assert.equal(obs.snapshotId, 's1')
  assert.equal(obs.elements.length, 4)
  assert.equal(obs.title, 'New Message')
})

test('observe reports a closed window as an ObserveError with Cua\'s code', async () => {
  const mac: Mac = {
    call: async () => ({ text: 'window_id_not_found', imageCount: 0, images: [], structured: { code: 'window_id_not_found' }, isError: true, durationMs: 1 }),
    close: async () => {},
  }
  await assert.rejects(observe(mac, { pid: 1, windowId: 2, app: 'X' }, { width: 1280, height: 800 }), (e: unknown) => e instanceof ObserveError && e.code === 'window_id_not_found')
})

test('sameFrame ignores noise but sees a real change', async () => {
  const a = await observation()
  const b = await observe(fakeMac(await pngOf(1600, 1000)), a.target, { width: 1280, height: 800 })
  const c = await observe(fakeMac(await pngOf(1600, 1000, { r: 20, g: 200, b: 20 })), a.target, { width: 1280, height: 800 })
  assert.equal(sameFrame(a.thumb, b.thumb), true)
  assert.equal(sameFrame(a.thumb, c.thumb), false)
})

type NoCallId = IrAction extends infer A ? (A extends unknown ? Omit<A, 'callId'> : never) : never
const act = (a: NoCallId) => ({ callId: 'c1', ...a }) as IrAction

test('a click maps canvas pixels to Cua window pixels, with button, count and held modifiers', async () => {
  const obs = await observation()
  assert.deepEqual(planAction(act({ kind: 'click', x: 640, y: 400, space: 'pixels', button: 'left' }), obs), {
    kind: 'cua',
    calls: [{ tool: 'click', args: { pid: 42, window_id: 7, x: 800, y: 500 } }],
    point: { x: 500, y: 300 },
  })
  assert.deepEqual(planAction(act({ kind: 'click', x: 640, y: 400, space: 'pixels', button: 'right', count: 2, keys: ['CMD', 'SHIFT'] }), obs), {
    kind: 'cua',
    calls: [{ tool: 'click', args: { pid: 42, window_id: 7, x: 800, y: 500, button: 'right', count: 2, modifier: ['cmd', 'shift'] } }],
    point: { x: 500, y: 300 },
  })
})

test('points in the letterbox padding and non-modifier held keys are refused, never clamped', async () => {
  const small = await observe(
    {
      call: async (name) =>
        name === 'get_window_state'
          ? ok({ snapshot_id: 's', window_bounds: { x: 0, y: 0, width: 200, height: 400 }, screenshot_width: 400, screenshot_height: 800, elements: [] }, [{ mimeType: 'image/png', dataBase64: await pngOf(400, 800) }])
          : ok(),
      close: async () => {},
    },
    { pid: 1, windowId: 2, app: 'Calculator' },
    { width: 1280, height: 800 },
  )
  const outside = planAction(act({ kind: 'click', x: 900, y: 100, space: 'pixels', button: 'left' }), small)
  assert.equal(outside.kind, 'error')
  assert.match((outside as { message: string }).message, /outside the window/)
  const held = planAction(act({ kind: 'click', x: 10, y: 10, space: 'pixels', button: 'left', keys: ['A'] }), small)
  assert.equal(held.kind, 'error')
})

test('keys, drags, scrolls, waits, moves and screenshots plan to the right Cua calls', async () => {
  const obs = await observation()
  assert.deepEqual(planAction(act({ kind: 'keys', keys: ['CMD', 'S'] }), obs), { kind: 'cua', calls: [{ tool: 'hotkey', args: { pid: 42, window_id: 7, keys: ['cmd', 's'] } }] })
  assert.deepEqual(planAction(act({ kind: 'keys', keys: ['ENTER'] }), obs), { kind: 'cua', calls: [{ tool: 'press_key', args: { pid: 42, window_id: 7, key: 'return' } }] })
  assert.equal(planAction(act({ kind: 'keys', keys: ['SHIFT'] }), obs).kind, 'error')
  assert.deepEqual(planAction(act({ kind: 'drag', path: [{ x: 0, y: 0 }, { x: 64, y: 40 }, { x: 640, y: 400 }], space: 'pixels' }), obs), {
    kind: 'cua',
    calls: [{ tool: 'drag', args: { pid: 42, window_id: 7, from_x: 0, from_y: 0, to_x: 800, to_y: 500 } }],
    point: { x: 100, y: 50 },
  })
  const scroll = planAction(act({ kind: 'scroll', x: 640, y: 400, space: 'pixels', dx: 0, dy: 480 }), obs)
  assert.equal(scroll.kind, 'cua')
  const call = (scroll as { calls: { tool: string; args: Record<string, unknown> }[] }).calls[0]
  assert.deepEqual([call.tool, call.args.direction, call.args.x, call.args.y], ['scroll', 'down', 800, 500])
  assert.ok(Number(call.args.amount) >= 1 && Number(call.args.amount) <= 50)
  assert.equal(planAction(act({ kind: 'scroll', x: 640, y: 400, space: 'pixels', dx: 0, dy: 0 }), obs).kind, 'noop')
  assert.deepEqual(planAction(act({ kind: 'wait' }), obs), { kind: 'wait', ms: 1000 })
  assert.equal(planAction(act({ kind: 'move', x: 1, y: 1, space: 'pixels' }), obs).kind, 'noop')
  assert.equal(planAction(act({ kind: 'screenshot' }), obs).kind, 'noop')
  assert.equal(planAction(act({ kind: 'other', name: 'triple_click', input: {} }), obs).kind, 'error')
})

test('elementAt picks the smallest element under a screen point, never the window', async () => {
  const obs = await observation()
  assert.equal(elementAt({ x: 130, y: 95 }, obs.elements)?.label, 'Send')
  assert.equal(elementAt({ x: 500, y: 300 }, obs.elements)?.role, 'AXTextArea')
  assert.equal(elementAt({ x: 105, y: 60 }, obs.elements), undefined)
})

test('typing goes to the focused element by index when AX can place it, else to the pid', async () => {
  const obs = await observation()
  const area = focusedElement({ ok: true, role: 'AXTextArea', frame: { x: 100, y: 120, width: 800, height: 430 }, webArea: false, secure: false }, obs.elements)
  assert.equal(area?.element_index, 3)
  assert.deepEqual(planType('hello', obs, area), {
    kind: 'cua',
    calls: [{ tool: 'type_text', args: { pid: 42, window_id: 7, element_index: 3, snapshot_id: 's1', text: 'hello' } }],
  })
  assert.equal(focusedElement({ ok: true, role: 'AXTextField', frame: { x: 1, y: 1, width: 5, height: 5 }, webArea: false, secure: false }, obs.elements), undefined)
  assert.deepEqual(planType('hello', obs, undefined), { kind: 'cua', calls: [{ tool: 'type_text', args: { pid: 42, window_id: 7, text: 'hello' } }] })
})

test('runPlan stops at the first Cua error and reports its code', async () => {
  const seen: string[] = []
  const mac: Mac = {
    call: async (name) => {
      seen.push(name)
      return name === 'scroll'
        ? { text: 'refused', imageCount: 0, images: [], structured: { code: 'same_pid_keyboard_ambiguity', effect: 'refused' }, isError: true, durationMs: 1 }
        : ok({ effect: 'confirmed' })
    },
    close: async () => {},
  }
  const result = await runPlan({ kind: 'cua', calls: [{ tool: 'scroll', args: {} }, { tool: 'click', args: {} }] }, mac, new AbortController().signal)
  assert.deepEqual(seen, ['scroll'])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'same_pid_keyboard_ambiguity')
  const fine = await runPlan({ kind: 'cua', calls: [{ tool: 'click', args: {} }] }, mac, new AbortController().signal)
  assert.deepEqual([fine.ok, fine.effect], [true, 'confirmed'])
})
