import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CursorGlyph } from './cursor/CursorGlyph'
import { REST, reduceIsland, type IslandView } from './island-view'
import { command, onUiEvent, reducedMotion } from './events'

const q = new URLSearchParams(location.search)
/** The physical notch this island grows out of (points); 0 wide on a display without one. */
const NOTCH = { width: Number(q.get('nw') ?? 0), height: Number(q.get('nh') ?? 32) }
const HAS_NOTCH = NOTCH.width > 0
const EAR = 104
const LINE = 40
const ACTIONS = 44

function sizeOf(view: IslandView) {
  if (view.mode === 'rest') return HAS_NOTCH ? { width: NOTCH.width, height: NOTCH.height } : { width: 140, height: 32 }
  const width = HAS_NOTCH ? Math.max(NOTCH.width + EAR * 2, view.approval ? 520 : 460) : view.approval ? 480 : 420
  return { width, height: (HAS_NOTCH ? NOTCH.height : 36) + LINE + (view.approval ? ACTIONS : 0) }
}

const LINGER: Partial<Record<IslandView['mode'], number>> = { done: 2600, stopped: 1600 }

/** The status island (spec §9): a solid shape that grows out of the notch while the agent works. */
export function Island() {
  const [view, setView] = useState<IslandView>(REST)
  const pill = useRef<HTMLDivElement>(null)

  useEffect(() => onUiEvent((e) => setView((v) => reduceIsland(v, e))), [])
  useEffect(() => {
    const ms = LINGER[view.mode]
    if (!ms) return
    const t = setTimeout(() => setView(REST), ms)
    return () => clearTimeout(t)
  }, [view.mode])

  // Main keeps the panel click-through except over the visible pill (Jarvis hit-test); tell it where the pill is.
  const report = () => {
    const r = pill.current?.getBoundingClientRect()
    void command({ type: 'island-hit', rect: view.mode === 'rest' || !r ? null : { x: r.x, y: r.y, width: r.width, height: r.height } })
  }
  useLayoutEffect(report, [view.mode, view.approval?.id])

  const size = sizeOf(view)
  const busy = view.mode === 'working' || view.mode === 'attention'
  return (
    <div className={`island-stage${HAS_NOTCH ? ' has-notch' : ''}`}>
      <motion.div
        ref={pill}
        className={`island island--${view.mode}`}
        initial={false}
        animate={{ width: size.width, height: size.height, opacity: view.mode === 'rest' ? 0 : 1 }}
        transition={reducedMotion() ? { duration: 0 } : { type: 'spring', visualDuration: 0.5, bounce: 0.25 }}
        onAnimationComplete={report}
      >
        <AnimatePresence>
          {view.mode !== 'rest' && (
            <motion.div
              className="island-content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { delay: 0.12, duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
            >
              <div className="island-row" style={{ height: HAS_NOTCH ? NOTCH.height : 36 }}>
                <div className="island-ear island-ear--left">
                  <span className="island-avatar">
                    <CursorGlyph id="island" size={15} tint={view.mode === 'attention' ? 'amber' : view.mode === 'error' ? 'coral' : 'cyan'} />
                  </span>
                  {!HAS_NOTCH && <span className="island-title">{view.title}</span>}
                </div>
                {HAS_NOTCH && <div style={{ width: NOTCH.width }} />}
                <div className="island-ear island-ear--right">
                  {view.step && busy && (
                    <span className="island-step">
                      {view.step.n}/{view.step.of}
                    </span>
                  )}
                  {view.mode === 'done' && <span className="island-glyph island-glyph--done">✓</span>}
                  {busy && (
                    <button type="button" className="island-stop" aria-label="Stop" onClick={() => void command({ type: 'stop' })}>
                      <span />
                    </button>
                  )}
                </div>
              </div>
              <div className="island-line" style={{ height: LINE }}>
                <span className="island-line-text" title={view.approval?.reason}>
                  {view.approval ? view.approval.title : view.mode === 'working' && view.detail ? view.detail : view.detail ? `${view.title} · ${view.detail}` : view.title}
                </span>
              </div>
              {view.approval && <IslandActions id={view.approval.id} offersRun={view.approval.offersRun} />}
              {view.step && busy && (
                <div className="island-progress">
                  <span style={{ transform: `scaleX(${view.step.n / view.step.of})` }} />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

function IslandActions({ id, offersRun }: { id: string; offersRun: boolean }) {
  const answer = (value: 'once' | 'run' | 'deny') => void command({ type: 'answer', id, answer: value })
  return (
    <div className="island-actions" style={{ height: ACTIONS }}>
      <button type="button" className="island-button" onClick={() => answer('deny')}>
        Deny
      </button>
      {offersRun && (
        <button type="button" className="island-button" onClick={() => answer('run')}>
          For this task
        </button>
      )}
      <button type="button" className="island-button island-button--allow" onClick={() => answer('once')}>
        Allow once
      </button>
    </div>
  )
}
