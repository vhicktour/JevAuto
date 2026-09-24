import { useEffect, useRef, useState } from 'react'
import type { UiAct, UiDone, UiStatus } from '../../shared/ui-events'
import { CursorGlyph } from './cursor/CursorGlyph'
import { narrate } from './island-view'
import { command, onUiEvent } from './events'

type Row = { act: UiAct; done?: UiDone }
type Access = { accessibility: boolean; screenRecording: boolean }

const GLYPH: Record<UiAct['verb'], string> = { click: '◉', type: '⌨', drag: '⇢', key: '⌥', set: '✎', menu: '☰', launch: '↗', scroll: '⇅', other: '•' }
const STATE_LABEL: Record<UiStatus['state'], string> = { idle: 'Ready', working: 'Working', 'needs-you': 'Needs you', error: 'Error', done: 'Done', stopped: 'Stopped' }

/** The main window: what the agent can reach, what it is doing, and the controls to run or stop it. */
export function Activity() {
  const [status, setStatus] = useState<UiStatus>({ state: 'idle', title: 'Ready' })
  const [access, setAccess] = useState<Access | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [log, setLog] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => {
    void command<string[]>({ type: 'status' }).then(setLog)
    return onUiEvent((e) => {
      if (e.type === 'status-line') setLog((l) => [...l.slice(-199), e.line])
      else if (e.type === 'permissions') setAccess({ accessibility: e.accessibility, screenRecording: e.screenRecording })
      else if (e.type === 'status') setStatus(e.status)
      else if (e.type === 'act') setRows((r) => [...r.slice(-79), { act: e.act }])
      else if (e.type === 'done') setRows((r) => r.map((row) => (row.act.id === e.done.id ? { ...row, done: e.done } : row)))
    })
  }, [])
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [rows.length])

  const busy = status.state === 'working' || status.state === 'needs-you'
  return (
    <main className="activity">
      <header className="activity-header">
        <CursorGlyph id="brand" size={22} />
        <h1>JevAuto</h1>
        <span className={`state-pill state-pill--${status.state}`}>
          <i />
          {STATE_LABEL[status.state]}
        </span>
      </header>

      <section className="card">
        <h2>Mac access</h2>
        <ul className="access">
          <AccessRow label="Accessibility" hint="Click and type in apps" ok={access?.accessibility} />
          <AccessRow label="Screen Recording" hint="See the window it works in" ok={access?.screenRecording} />
        </ul>
      </section>

      <section className="card card--grow">
        <div className="card-title">
          <h2>Activity</h2>
          {status.step && busy && (
            <span className="card-meta">
              Step {status.step.n} of {status.step.of}
            </span>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="empty">Nothing yet. Run the demo to watch the agent work.</p>
        ) : (
          <ol ref={list} className="timeline">
            {rows.map(({ act, done }) => (
              <li key={act.id} className={`timeline-row${done ? (done.ok ? ' is-ok' : ' is-failed') : ' is-running'}`}>
                <span className="timeline-glyph">{GLYPH[act.verb]}</span>
                <span className="timeline-text">{narrate(act)}</span>
                <span className="timeline-meta">{done ? `${(done.ms / 1000).toFixed(1)} s` : ''}</span>
                <span className="timeline-state" />
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="activity-footer">
        <button type="button" className="button button--primary" disabled={busy} onClick={() => void command({ type: 'run', spike: 'demo' })}>
          Run demo
        </button>
        <button type="button" className="button button--stop" disabled={!busy} onClick={() => void command({ type: 'stop' })}>
          Stop
        </button>
        <button type="button" className="button button--quiet" onClick={() => setShowLog((s) => !s)}>
          {showLog ? 'Hide log' : 'Log'}
        </button>
      </footer>
      {showLog && (
        <pre className="log" aria-label="Log">
          {log.join('\n')}
        </pre>
      )}
    </main>
  )
}

function AccessRow({ label, hint, ok }: { label: string; hint: string; ok: boolean | undefined }) {
  return (
    <li className={`access-row${ok === undefined ? '' : ok ? ' is-ok' : ' is-missing'}`}>
      <span className="access-dot" />
      <span className="access-label">
        {label}
        <small>{hint}</small>
      </span>
      <span className="access-state">{ok === undefined ? 'Checking…' : ok ? 'Allowed' : 'Not allowed'}</span>
    </li>
  )
}
