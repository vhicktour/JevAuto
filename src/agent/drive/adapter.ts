import type { Adapter, CallResult, Turn, View } from '../loop/adapter'
import type { IrAction } from '../providers/ir'
import type { DriveCall, DriveResult } from '../../shared/drive'

/** The canvas Claude Code sees: the same size JevAuto's Claude and OpenAI runs use. */
const CANVAS = { width: 1280, height: 800 }
const NO_USAGE = { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
// Tools that act on the window Claude last saw; the others choose or open a window.
const ACTING = new Set<DriveCall['tool']>(['click', 'type', 'keys', 'scroll', 'drag', 'wait', 'do'])
const SHOWS = new Set<DriveCall['tool']>(['look', 'open_app', 'open_url'])

type Pending = { call: DriveCall; reply: (result: DriveResult) => void }

/**
 * Claude Code as the brain (spec §12, "after v1: MCP exposure"). Each MCP call becomes one turn of JevAuto's own loop:
 * the loop gates and runs it, looks again, and the answer goes back to Claude with the new screenshot. So the gate,
 * approvals, Full auto, the cursor, the island and Stop apply exactly as they do to JevAuto's models, and no model is
 * called here.
 */
export class DriveAdapter implements Adapter {
  readonly provider = 'claude-code' as const
  readonly model = 'claude-code'
  readonly canvas = CANVAS
  private queue: Pending[] = []
  private running?: Pending
  private wake?: () => void
  private ended = false
  private n = 0
  /** The loop's target right now, and the window of the last screenshot Claude was sent. */
  private target?: number
  private seen?: number

  /** From the MCP side: run one call and wait for its result. */
  submit(call: DriveCall): Promise<DriveResult> {
    if (this.ended) return Promise.resolve({ ok: false, text: 'This JevAuto session has ended. Call again to start a new one.' })
    // Coordinates and keystrokes are only safe on the window Claude has actually seen.
    if (ACTING.has(call.tool) && (this.seen === undefined || this.seen !== this.target))
      return Promise.resolve({
        ok: false,
        text:
          this.seen === undefined
            ? 'Look first: call look to see the window before acting in it.'
            : 'The window changed since your last screenshot. Call look to see the current one before acting.',
      })
    return new Promise((reply) => {
      this.queue.push({ call, reply })
      this.wake?.()
    })
  }

  /** Claude Code went away (or the session idled out): the loop finishes after the call it is running. */
  end() {
    this.ended = true
    this.wake?.()
  }

  async start(input: { view?: View }, signal?: AbortSignal): Promise<Turn> {
    this.target = input.view?.windowId
    return this.nextTurn(signal)
  }

  async next(input: { results: CallResult[]; image?: string; notes: string[]; url?: string; view?: View }, signal?: AbortSignal): Promise<Turn> {
    this.target = input.view?.windowId
    const done = this.running
    this.running = undefined
    if (done) {
      // Looking or opening something shows the window; actions show it unless Claude asked not to.
      const withImage = SHOWS.has(done.call.tool) || ('screenshot' in done.call && done.call.screenshot !== false)
      if (withImage && input.image && input.view) this.seen = input.view.windowId
      done.reply(answer(done.call, input, withImage))
    }
    return this.nextTurn(signal)
  }

  /** The run is over (ended, stopped, failed): whatever still waits gets told. */
  async close(): Promise<void> {
    this.ended = true
    for (const p of [this.running, ...this.queue]) p?.reply({ ok: false, text: 'JevAuto stopped this session (Stop, a quit or a restart). Call again to start a new one.' })
    this.running = undefined
    this.queue = []
  }

  private async nextTurn(signal?: AbortSignal): Promise<Turn> {
    while (!this.queue.length && !this.ended) {
      await new Promise<void>((resolve) => {
        this.wake = resolve
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      signal?.throwIfAborted()
    }
    this.wake = undefined
    const id = `t${++this.n}`
    if (!this.queue.length) return turn(id, [{ kind: 'tool', callId: 'end', name: 'done', input: { status: 'success', summary: 'Claude Code stopped driving.' } }])
    this.running = this.queue.shift()!
    return turn(id, actionsFor(this.running.call, `c${this.n}`, this.target))
  }
}

const turn = (id: string, actions: IrAction[]): Turn => ({ id, actions, refusal: false, text: [], safety: [], usage: NO_USAGE })

/** One MCP call as the loop's actions. Coordinates are canvas pixels, which is what Claude's screenshots are. */
export function actionsFor(call: DriveCall, callId: string, target: number | undefined): IrAction[] {
  switch (call.tool) {
    case 'look':
      return [
        ...(call.window !== undefined && call.window !== target ? [{ kind: 'tool' as const, callId: `${callId}w`, name: 'switch_target', input: { window_id: call.window } }] : []),
        { kind: 'screenshot', callId },
      ]
    case 'windows':
      return [{ kind: 'tool', callId, name: 'list_windows', input: {} }]
    case 'open_app':
      return [{ kind: 'tool', callId, name: 'open_app', input: { name: call.name } }]
    case 'open_url':
      return [{ kind: 'tool', callId, name: 'open_url', input: { url: call.url } }]
    case 'click':
      return [{ kind: 'click', callId, x: call.x, y: call.y, space: 'pixels', button: call.button, ...(call.count > 1 ? { count: call.count } : {}), ...(call.modifiers.length ? { keys: call.modifiers } : {}) }]
    case 'type':
      return [{ kind: 'type', callId, text: call.text }]
    case 'keys':
      return [{ kind: 'keys', callId, keys: call.keys }]
    case 'scroll': {
      const sign = call.direction === 'up' || call.direction === 'left' ? -1 : 1
      const vertical = call.direction === 'up' || call.direction === 'down'
      return [{ kind: 'scroll', callId, x: call.x, y: call.y, space: 'pixels', dx: vertical ? 0 : sign, dy: vertical ? sign : 0, notches: call.amount }]
    }
    case 'drag':
      return [{ kind: 'drag', callId, path: [call.from, call.to], space: 'pixels' }]
    case 'wait':
      return Array.from({ length: call.seconds }, () => ({ kind: 'wait' as const, callId }))
    case 'do':
      // Each step is its own call, so a failure halts the steps after it and the answer says which did not run.
      return call.steps.flatMap((step, i) => actionsFor({ ...step, screenshot: false } as DriveCall, `${callId}.${i + 1}`, target))
    case 'learn':
      return [{ kind: 'tool', callId, name: 'remember', input: { app: call.app, tip: call.tip } }]
  }
}

/** What Claude reads back: the window, how the call went, JevAuto's notes, and the controls it can see. */
function answer(call: DriveCall, input: { results: CallResult[]; image?: string; notes: string[]; view?: View }, withImage: boolean): DriveResult {
  const lines: string[] = []
  let ok = true
  for (const r of input.results) {
    if (r.kind === 'function') {
      lines.push(r.output)
      if (/"error"/.test(r.output)) ok = false
    } else if (r.status === 'failed' || r.status === 'not-run') {
      ok = false
      lines.push(`Not done: ${r.message ?? 'JevAuto could not run this step.'}`)
    }
  }
  lines.push(...input.notes)
  const v = input.view
  if (v) {
    lines.unshift(`Window ${v.windowId}: ${v.app}${v.title ? ` — “${v.title}”` : ''}${v.url ? ` · ${v.url}` : ''}`)
    if (withImage && v.controls.length)
      lines.push(`Controls (centres in screenshot pixels):\n${v.controls.map((c) => `- ${c.role.replace(/^AX/, '')} “${c.label}” at (${c.x}, ${c.y})`).join('\n')}`)
  } else lines.unshift('No window is targeted. Use windows, open_app or open_url.')
  return { ok, text: lines.join('\n'), ...(withImage && input.image ? { image: input.image } : {}) }
}
