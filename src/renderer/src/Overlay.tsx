import { useEffect, useRef, useState } from 'react'
import type { UiAct, UiStatus } from '../../shared/ui-events'
import { CursorGlyph, type Tint } from './cursor/CursorGlyph'
import { CURSOR, planTravel, travelAt, type Point } from './cursor/motion'
import { onUiEvent, reducedMotion } from './events'

type Box = { x: number; y: number; width: number; height: number }

/** This overlay's display, in screen points; main passes it in the query (ox, oy, ow, oh). */
function displayBox(): Box {
  const q = new URLSearchParams(location.search)
  const n = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d)
  return { x: n('ox', 0), y: n('oy', 0), width: n('ow', innerWidth), height: n('oh', innerHeight) }
}

const CHIP: Record<UiAct['verb'], string> = {
  click: 'Click',
  type: 'Type',
  drag: 'Drag',
  key: 'Press',
  set: 'Set',
  menu: 'Menu',
  launch: 'Open',
  scroll: 'Scroll',
  other: 'Act',
}

const chipText = (act: UiAct) => {
  if (!act.label) return CHIP[act.verb]
  return `${CHIP[act.verb]} ${act.label.startsWith('“') ? act.label : `“${act.label}”`}`
}

/**
 * One transparent, click-through panel per display (spec §9). The cursor travels on an arc to each visible target,
 * dwells, presses with a ripple and outlines what it acted on. It is drawn only when the target can be seen; the island
 * narrates the rest. Position is written straight to the DOM from requestAnimationFrame (transform only).
 */
export function Overlay() {
  const box = useRef(displayBox()).current
  const cursor = useRef<HTMLDivElement>(null)
  const eyes = useRef<SVGGElement | null>(null)
  const at = useRef<Point | null>(null)
  const frame = useRef(0)
  const timers = useRef<number[]>([])
  const [shown, setShown] = useState(false)
  const [tint, setTint] = useState<Tint>('cyan')
  const [target, setTarget] = useState<{ act: UiAct; rect?: Box } | null>(null)
  const [press, setPress] = useState<{ key: number; at: Point } | null>(null)

  useEffect(() => {
    const home: Point = { x: box.width / 2, y: 16 } // it comes out of, and goes back into, the island
    const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms))
    const clearLater = () => {
      timers.current.forEach(clearTimeout)
      timers.current = []
    }
    const local = (p: Point): Point => ({ x: p.x - box.x, y: p.y - box.y })
    const here = (p: Point) => p.x >= box.x && p.y >= box.y && p.x < box.x + box.width && p.y < box.y + box.height
    const place = (p: Point, heading?: number) => {
      at.current = p
      if (cursor.current) cursor.current.style.transform = `translate3d(${p.x - 3}px, ${p.y - 2}px, 0)`
      if (heading !== undefined && eyes.current) eyes.current.style.transform = `translate(${Math.cos(heading)}px, ${Math.sin(heading)}px)`
    }
    const travel = (to: Point, then?: () => void) => {
      cancelAnimationFrame(frame.current)
      if (!at.current) place(home)
      if (reducedMotion()) {
        place(to)
        then?.()
        return
      }
      const tr = planTravel(at.current!, to)
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
    const hide = () => {
      cancelAnimationFrame(frame.current)
      setShown(false)
      setTarget(null)
      at.current = null
    }
    const act = (a: UiAct) => {
      clearLater()
      if (!a.visible || !a.point || !here(a.point)) return hide() // another display has it, or the target is hidden
      setTint('cyan')
      setShown(true)
      setTarget(null)
      const to = local(a.point)
      travel(to, () =>
        later(() => {
          const rect = a.rect ? { ...local(a.rect), width: a.rect.width, height: a.rect.height } : undefined
          setTarget({ act: a, rect })
          if (a.verb === 'click' || a.verb === 'drag') setPress({ key: performance.now(), at: to })
          if (a.verb === 'drag' && a.to && here(a.to)) travel(local(a.to))
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
          setTarget(null)
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
      {target?.rect && (
        <div key={target.act.id} className="target-outline" style={{ left: target.rect.x - 4, top: target.rect.y - 4, width: target.rect.width + 8, height: target.rect.height + 8 }} />
      )}
      {press && <div key={press.key} className="press-ripple" style={{ left: press.at.x, top: press.at.y }} />}
      <div ref={cursor} className={`agent-cursor${shown ? ' is-shown' : ''}`}>
        <div className="agent-cursor-float">
          <div key={press?.key ?? 0} className={`agent-cursor-press${press ? ' is-pressing' : ''}`}>
            <CursorGlyph id="overlay" tint={tint} eyesRef={eyes} />
          </div>
        </div>
        {target && (
          <div key={target.act.id} className={`cursor-chip cursor-chip--${tint}`}>
            {chipText(target.act)}
          </div>
        )}
      </div>
    </div>
  )
}
