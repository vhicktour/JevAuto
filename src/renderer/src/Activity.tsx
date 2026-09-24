import { useEffect, useRef, useState } from 'react'
import type { UiAct, UiApproval, UiDone, UiQuestion, UiStatus } from '../../shared/ui-events'
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
  const [task, setTask] = useState('')
  const [approval, setApproval] = useState<UiApproval | null>(null)
  const [question, setQuestion] = useState<UiQuestion | null>(null)
  const [watch, setWatch] = useState(true)
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => {
    void command<string[]>({ type: 'status' }).then(setLog)
    void command<{ watch: boolean }>({ type: 'settings' }).then((s) => setWatch(s.watch))
    return onUiEvent((e) => {
      if (e.type === 'status-line') setLog((l) => [...l.slice(-199), e.line])
      else if (e.type === 'permissions') setAccess({ accessibility: e.accessibility, screenRecording: e.screenRecording })
      else if (e.type === 'status') {
        setStatus(e.status)
        // A run that ended (or an agent that died) leaves nothing to answer.
        if (!['working', 'needs-you'].includes(e.status.state)) {
          setApproval(null)
          setQuestion(null)
        }
      }
      else if (e.type === 'act') setRows((r) => [...r.slice(-79), { act: e.act }])
      else if (e.type === 'done') setRows((r) => r.map((row) => (row.act.id === e.done.id ? { ...row, done: e.done } : row)))
      else if (e.type === 'approval') setApproval(e.approval)
      else if (e.type === 'approval-closed') setApproval((a) => (a?.id === e.id ? null : a))
      else if (e.type === 'question') setQuestion(e.question)
      else if (e.type === 'question-closed') setQuestion((q) => (q?.id === e.id ? null : q))
      else if (e.type === 'settings') setWatch(e.watch)
    })
  }, [])
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [rows.length])

  const busy = status.state === 'working' || status.state === 'needs-you'
  const run = () => {
    const text = task.trim()
    if (!text || busy) return
    setRows([])
    void command({ type: 'task', text })
    setTask('')
  }
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

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          run()
        }}
      >
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              run()
            }
          }}
          placeholder="What should JevAuto do? For example: in Notes, start a checklist with milk, eggs and bread."
          aria-label="Task"
          rows={2}
          maxLength={2000}
          disabled={busy}
        />
        <div className="composer-row">
          <button
            type="button"
            className={`watch-toggle${watch ? ' is-on' : ''}`}
            aria-pressed={watch}
            title={watch ? 'Watch: each app comes to the front so you can see the cursor work' : 'Background: JevAuto works behind your windows'}
            onClick={() => void command({ type: 'watch', on: !watch })}
          >
            <i />
            {watch ? 'Watch' : 'Background'}
          </button>
          <span className="composer-hint">Return runs it · ⌃⌥Space from anywhere</span>
          {busy ? (
            <button type="button" className="button button--stop" onClick={() => void command({ type: 'stop' })}>
              Stop
            </button>
          ) : (
            <button type="submit" className="button button--primary" disabled={!task.trim()}>
              Run
            </button>
          )}
        </div>
      </form>

      {approval && <ApprovalCard approval={approval} />}
      {question && <QuestionCard key={question.id} question={question} />}

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
          <p className="empty">Nothing yet. Type a task above, or run the demo.</p>
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

function ApprovalCard({ approval }: { approval: UiApproval }) {
  const answer = (value: 'once' | 'run' | 'deny') => void command({ type: 'answer', id: approval.id, answer: value })
  return (
    <section className="card card--attention" role="alertdialog" aria-label={approval.title}>
      <h2>Needs your OK</h2>
      <p className="attention-title">{approval.title}</p>
      <p className="attention-reason">{approval.reason}</p>
      <div className="attention-actions">
        <button type="button" className="button" onClick={() => answer('deny')}>
          Deny
        </button>
        {approval.offersRun && (
          <button type="button" className="button" onClick={() => answer('run')}>
            Allow for this task
          </button>
        )}
        <button type="button" className="button button--amber" onClick={() => answer('once')}>
          Allow once
        </button>
      </div>
    </section>
  )
}

function QuestionCard({ question }: { question: UiQuestion }) {
  const [text, setText] = useState('')
  const send = (value: string | null) => void command({ type: 'reply', id: question.id, text: value })
  return (
    <form
      className="card card--attention"
      onSubmit={(e) => {
        e.preventDefault()
        send(text.trim() || null)
      }}
    >
      <h2>JevAuto asks</h2>
      <p className="attention-title">{question.question}</p>
      <input className="attention-input" value={text} onChange={(e) => setText(e.target.value)} aria-label="Your answer" autoFocus maxLength={4000} />
      <div className="attention-actions">
        <button type="button" className="button" onClick={() => send(null)}>
          Skip
        </button>
        <button type="submit" className="button button--amber">
          Send
        </button>
      </div>
    </form>
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
