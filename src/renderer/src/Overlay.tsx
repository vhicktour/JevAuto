import { useEffect, useRef, useState } from 'react'
import type { UiAct, UiStatus } from '../../shared/ui-events'
import { CursorGlyph, type Tint } from './cursor/CursorGlyph'
import { keycaps, gestureLabel } from './cursor/gesture'
import { CURSOR, planDrag, planTravel, travelAt, type Point, type Travel } from './cursor/motion'
import { onUiEvent, reducedMotion } from './events'

type Box = { x: number; y: number; width: number; height: number }
type Ripple = { key: number; at: Point }
type Chip = { key: string; act: UiAct; keys?: string[] }

/** This overlay's display, in screen points; main passes it in the query (ox, oy, ow, oh). */
function displayBox(): Box {
  const q = new URLSearchParams(location.search)
  const n = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d)
  return { x: n('ox', 0), y: n('oy', 0), width: n('ow', innerWidth), height: n('oh', innerHeight) }
}

/** Shown text for the typing chip: long text is cut, the rest is typed out a character at a time. */
const TYPED_MAX = 48

/**
 * One transparent, click-through panel per display (spec §9). The cursor travels on an arc to each visible target and
 * acts the gesture out: a press ripple (two for a double-click), press-hold-glide-release for a drag, the text typed
 * out beside it, keycaps for a shortcut, chevrons for a scroll. In Watch mode the agent waits for it to arrive, so
 * each action lands as the cursor presses. It is drawn only when the target can be seen
 * (occlusion rule); the island narrates the rest. Position is written straight to the DOM from requestAnimationFrame.
 */
export function Overlay() {
  const box = useRef(displayBox()).current
  const cursor = useRef<HTMLDivElement>(null)
  const eyes = useRef<SVGGElement | null>(null)
  const typed = useRef<HTMLSpanElement>(null)
  const at = useRef<Point | null>(null)
  const frame = useRef(0)
  const timers = useRef<number[]>([])
  const [shown, setShown] = useState(false)
  const [tint, setTint] = useState<Tint>('cyan')
  const [outline, setOutline] = useState<{ key: string; rect: Box } | null>(null)
  const [chip, setChip] = useState<Chip | null>(null)
  const [ripples, setRipples] = useState<Ripple[]>([])
  const [holding, setHolding] = useState(false)
  const [press, setPress] = useState(0)

  useEffect(() => {
    const home: Point = { x: box.width / 2, y: 16 } // it comes out of, and goes back into, the island
    const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms))
    const every = (fn: () => void, ms: number) => timers.current.push(window.setInterval(fn, ms))
    const clearLater = () => {
      timers.current.forEach((t) => (clearTimeout(t), clearInterval(t)))
      timers.current = []
    }
    const local = (p: Point): Point => ({ x: p.x - box.x, y: p.y - box.y })
    const here = (p: Point) => p.x >= box.x && p.y >= box.y && p.x < box.x + box.width && p.y < box.y + box.height
    const place = (p: Point, heading?: number) => {
      at.current = p
      if (cursor.current) cursor.current.style.transform = `translate3d(${p.x - 3}px, ${p.y - 2}px, 0)`
      if (heading !== undefined && eyes.current) eyes.current.style.transform = `translate(${Math.cos(heading)}px, ${Math.sin(heading)}px)`
    }
    const move = (tr: Travel, then?: () => void) => {
      cancelAnimationFrame(frame.current)
      if (reducedMotion() || tr.durationMs === 0) {
        place(tr.to)
        then?.()
        return
      }
      const start = performance.now()
      const step = (now: number) => {
        const s = travelAt(tr, now - start)
        place(s.point, s.done ? undefined : s.heading)
        if (s.done) {
          if (eyes.current) eyes.current.style.transform = 'translate(0px, 0px)'
          then?.()
        } else frame.current = requestAnimationFrame(step)
      }
      frame.current = requestAnimationFrame(step)
    }
    const travel = (to: Point, then?: () => void) => {
      if (!at.current) place(home)
      move(planTravel(at.current!, to), then)
    }
    const ripple = (p: Point, count: number) => {
      for (let i = 0; i < count; i++)
        later(() => {
          setPress(performance.now())
          setRipples((r) => [...r.slice(-3), { key: performance.now() + i, at: p }])
        }, i * 150)
    }
    /** Types the text out in the chip; the chip mounts in the same render, so writes start on the first tick. */
    const typeOut = (text: string) => {
      const shownText = text.length > TYPED_MAX ? `${text.slice(0, TYPED_MAX - 1)}…` : text
      let i = reducedMotion() ? shownText.length - 1 : 0
      const tick = Math.max(18, Math.min(45, 1400 / Math.max(1, shownText.length)))
      every(() => {
        if (!typed.current || i >= shownText.length) return
        i += 1
        typed.current.textContent = shownText.slice(0, i)
      }, tick)
    }
    /** Press, hold and glide in step with Cua's 500 ms drag, then release. No trail: the hand shows the drag. */
    const drag = (from: Point, to: Point) => {
      setHolding(true)
      ripple(from, 1)
      move(planDrag(from, to), () => {
        setHolding(false)
        ripple(to, 1)
      })
    }
    const hide = () => {
      cancelAnimationFrame(frame.current)
      setShown(false)
      setOutline(null)
      setChip(null)
      setHolding(false)
      at.current = null
    }
    const act = (a: UiAct) => {
      // A key press doesn't move the hand: show the keycaps where it is, if it is on this display.
      if (a.verb === 'key') {
        if (at.current) setChip({ key: a.id, act: a, keys: keycaps(a.label ?? '') })
        return
      }
      clearLater()
      if (!a.visible || !a.point || !here(a.point)) return hide() // another display has it, or the target is hidden
      setTint('cyan')
      setShown(true)
      setOutline(null)
      setChip(null)
      setHolding(false)
      const to = local(a.point)
      travel(to, () =>
        later(() => {
          if (a.rect) setOutline({ key: a.id, rect: { ...local(a.rect), width: a.rect.width, height: a.rect.height } })
          setChip({ key: a.id, act: a })
          if (a.verb === 'click') ripple(to, a.count ?? 1)
          else if (a.verb === 'drag' && a.to && here(a.to)) drag(to, local(a.to))
          else if (a.verb === 'type') typeOut(a.text ?? '')
        }, CURSOR.dwellMs),
      )
    }
    const status = (s: UiStatus) => {
      if (s.state === 'needs-you') setTint('amber')
      else if (s.state === 'error') setTint('coral')
      else if (s.state === 'working') setTint('cyan')
      if (s.state === 'done' || s.state === 'stopped' || s.state === 'idle') {
        clearLater()
        later(() => {
          setOutline(null)
          setChip(null)
          if (at.current) travel(home, () => later(hide, 180))
        }, s.state === 'stopped' ? 0 : 900)
      }
    }
    const off = onUiEvent((e) => {
      if (e.type === 'act') act(e.act)
      else if (e.type === 'done' && !e.done.ok) {
        setTint('coral')
        later(() => setTint('cyan'), 900)
      } else if (e.type === 'status') status(e.status)
    })
    return () => {
      off()
      clearLater()
      cancelAnimationFrame(frame.current)
    }
  }, [box])

  return (
    <div className="overlay-stage">
      {outline && (
        <div key={outline.key} className="target-outline" style={{ left: outline.rect.x - 4, top: outline.rect.y - 4, width: outline.rect.width + 8, height: outline.rect.height + 8 }} />
      )}
      {ripples.map((r) => (
        <div key={r.key} className="press-ripple" style={{ left: r.at.x, top: r.at.y }} />
      ))}
      <div ref={cursor} className={`agent-cursor${shown ? ' is-shown' : ''}${holding ? ' is-holding' : ''}`}>
        <div className="agent-cursor-float">
          <div key={press} className={`agent-cursor-press${press ? ' is-pressing' : ''}`}>
            <CursorGlyph id="overlay" tint={tint} eyesRef={eyes} />
          </div>
        </div>
        {chip && (
          <div key={chip.key} className={`cursor-chip cursor-chip--${tint}`}>
            {chip.keys ? (
              chip.keys.map((k, i) => <kbd key={i}>{k}</kbd>)
            ) : chip.act.verb === 'type' ? (
              <>
                <span className="cursor-chip-verb">Type</span>
                <span ref={typed} className="cursor-chip-typed" />
                <i className="cursor-chip-caret" />
              </>
            ) : (
              <>
                {gestureLabel(chip.act)}
                {chip.act.verb === 'scroll' && <i className={`cursor-chip-scroll cursor-chip-scroll--${chip.act.direction ?? 'down'}`} />}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
