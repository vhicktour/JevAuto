import { useEffect, useRef, useState } from 'react'
import type { UiAct, UiApproval, UiDone, UiQuestion, UiStatus } from '../../shared/ui-events'
import { CursorGlyph } from './cursor/CursorGlyph'
import { GLYPH, narrate } from './island-view'
import { command, onUiEvent } from './events'
import { Settings } from './Settings'
import type { Speed } from '../../shared/motion'

/** A step the agent took, or something you told it while it worked. */
type Row = { key: string; act: UiAct; done?: UiDone } | { key: string; note: string }
type Access = { accessibility: boolean; screenRecording: boolean }

const STATE_LABEL: Record<UiStatus['state'], string> = { idle: 'Ready', working: 'Working', 'needs-you': 'Needs you', error: 'Error', done: 'Done', stopped: 'Stopped' }
const SPEED_LABEL: Record<Speed, string> = { instant: 'Instant', balanced: 'Balanced', cinematic: 'Cinematic', teach: 'Teach' }

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
  const [model, setModel] = useState('')
  const [speed, setSpeed] = useState<Speed>('balanced')
  const [auto, setAuto] = useState(false)
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [queue, setQueue] = useState<string[]>([])
  const list = useRef<HTMLOListElement>(null)
  const wasBusy = useRef(false)

  useEffect(() => {
    void command<string[]>({ type: 'status' }).then(setLog)
    void command<{ watch: boolean; model: string; speed: Speed; auto: boolean; models: { id: string; label: string }[] }>({ type: 'settings' }).then((s) => {
      setWatch(s.watch)
      setModel(s.model)
      setSpeed(s.speed)
      setAuto(s.auto)
      setModels(s.models)
    })
    return onUiEvent((e) => {
      if (e.type === 'status-line') setLog((l) => [...l.slice(-199), e.line])
      else if (e.type === 'permissions') setAccess({ accessibility: e.accessibility, screenRecording: e.screenRecording })
      else if (e.type === 'status') {
        const busyNow = ['working', 'needs-you'].includes(e.status.state)
        if (busyNow && !wasBusy.current) setRows([]) // a new run starts a new list
        wasBusy.current = busyNow
        setStatus(e.status)
        // A run that ended (or an agent that died) leaves nothing to answer.
        if (!['working', 'needs-you'].includes(e.status.state)) {
          setApproval(null)
          setQuestion(null)
        }
      }
      else if (e.type === 'act') setRows((r) => [...r.slice(-79), { key: e.act.id, act: e.act }])
      else if (e.type === 'done') setRows((r) => r.map((row) => ('act' in row && row.act.id === e.done.id ? { ...row, done: e.done } : row)))
      else if (e.type === 'queue') setQueue(e.tasks)
      else if (e.type === 'approval') setApproval(e.approval)
      else if (e.type === 'approval-closed') setApproval((a) => (a?.id === e.id ? null : a))
      else if (e.type === 'question') setQuestion(e.question)
      else if (e.type === 'question-closed') setQuestion((q) => (q?.id === e.id ? null : q))
      else if (e.type === 'settings') {
        setWatch(e.watch)
        setModel(e.model)
        setSpeed(e.speed)
        setAuto(e.auto)
      }
    })
  }, [])
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [rows.length])

  const busy = status.state === 'working' || status.state === 'needs-you'
  const typed = task.trim()
  const run = () => {
    if (!typed || busy) return
    void command({ type: 'task', text: typed })
    setTask('')
  }
  /** While a task runs: tell it something now (steer), or line up the next task (queue). */
  const steer = () => {
    if (!typed) return
    void command({ type: 'steer', text: typed })
    setRows((r) => [...r.slice(-79), { key: `note-${Date.now()}`, note: typed }])
    setTask('')
  }
  const queueNext = () => {
    if (!typed) return
    void command({ type: 'task', text: typed, when: 'next' })
    setTask('')
  }
  const submit = () => (busy ? steer() : run())
  return (
    <main className="activity">
      <header className="activity-header">
        <CursorGlyph id="brand" size={22} />
        <h1>JevAuto</h1>
        <span className={`state-pill state-pill--${status.state}`}>
          <i />
          {STATE_LABEL[status.state]}
        </span>
        {auto && (
          <button type="button" className="auto-badge" title="Full auto is on: JevAuto doesn’t stop to ask. Change it in Settings." onClick={() => setShowSettings(true)}>
            Full auto
          </button>
        )}
        <button
          type="button"
          className={`gear${showSettings ? ' is-on' : ''}`}
          aria-label={showSettings ? 'Close settings' : 'Settings'}
          aria-pressed={showSettings}
          onClick={() => {
            setShowSettings((v) => !v)
            if (showSettings) void command<{ models: { id: string; label: string }[] }>({ type: 'settings' }).then((s) => setModels(s.models))
          }}
        >
          ⚙
        </button>
      </header>
      {showSettings && <Settings access={access} />}

      {!showSettings && (<>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={
            busy
              ? 'Tell JevAuto more while it works (Steer), or line up the next task (Queue).'
              : 'What should JevAuto do? For example: in Notes, start a checklist with milk, eggs and bread.'
          }
          aria-label="Task"
          rows={2}
          maxLength={2000}
        />
        {busy ? (
          <div className="composer-row">
            <span className="composer-hint">{typed ? 'Steer tells this task · Queue runs it next' : 'Working… Stop is also on the island'}</span>
            {typed ? (
              <>
                <button type="button" className="button" onClick={queueNext}>
                  Queue
                </button>
                <button type="submit" className="button button--primary">
                  Steer
                </button>
              </>
            ) : (
              <button type="button" className="button button--stop" onClick={() => void command({ type: 'stop' })}>
                Stop
              </button>
            )}
          </div>
        ) : (
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
          <select
            className="pill-select"
            value={speed}
            aria-label="Cursor speed"
            title="Cursor speed. Teach moves slowly, draws the path and numbers each step."
            disabled={busy}
            onChange={(e) => void command({ type: 'speed', speed: e.target.value })}
          >
            {(Object.keys(SPEED_LABEL) as Speed[]).map((s) => (
              <option key={s} value={s}>
                {SPEED_LABEL[s]}
              </option>
            ))}
          </select>
          {models.length > 1 && (
            <select className="pill-select" value={model} aria-label="Model" disabled={busy} onChange={(e) => void command({ type: 'model', id: e.target.value })}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
          <span className="composer-hint">Return runs it · ⌃⌥Space from anywhere</span>
          <button type="submit" className="button button--primary" disabled={!typed}>
            Run
          </button>
        </div>
        )}
      </form>

      {queue.length > 0 && (
        <ol className="queue" aria-label="Queued tasks">
          {queue.map((q, i) => (
            <li key={`${i}-${q}`}>
              <span className="queue-when">{i === 0 ? 'Next' : 'Then'}</span>
              <span className="queue-text">{q}</span>
              <button type="button" className="queue-remove" aria-label={`Remove “${q}” from the queue`} onClick={() => void command({ type: 'unqueue', index: i })}>
                ×
              </button>
            </li>
          ))}
        </ol>
      )}

      {approval && <ApprovalCard key={approval.id} approval={approval} />}
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
            {rows.map((row) =>
              'note' in row ? (
                <li key={row.key} className="timeline-row is-note">
                  <span className="timeline-glyph">“</span>
                  <span className="timeline-text">You: {row.note}</span>
                  <span className="timeline-meta" />
                  <span className="timeline-state" />
                </li>
              ) : (
                <li key={row.key} className={`timeline-row${row.done ? (row.done.ok ? ' is-ok' : ' is-failed') : ' is-running'}`}>
                  <span className="timeline-glyph">{GLYPH[row.act.verb]}</span>
                  <span className="timeline-text">{narrate(row.act, true)}</span>
                  <span className="timeline-meta">{row.done ? `${(row.done.ms / 1000).toFixed(1)} s` : ''}</span>
                  <span className="timeline-state" />
                </li>
              ),
            )}
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
      </>)}
    </main>
  )
}

/** The Edit path (spec §9): a typing step shows its text, and what you allow is what gets typed. */
function ApprovalCard({ approval }: { approval: UiApproval }) {
  const [draft, setDraft] = useState(approval.text ?? '')
  const edited = approval.text !== undefined && draft !== approval.text
  const answer = (value: 'once' | 'run' | 'always' | 'deny') =>
    void command({ type: 'answer', id: approval.id, answer: value, ...(edited && value !== 'deny' ? { text: draft } : {}) })
  return (
    <section className="card card--attention" role="alertdialog" aria-label={approval.title}>
      <h2>Needs your OK</h2>
      <p className="attention-title">{approval.title}</p>
      <p className="attention-reason">{approval.reason}</p>
      {approval.text !== undefined && (
        <label className="attention-edit">
          <span>It will type this. Change it first if you like.</span>
          <textarea className="attention-input" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} maxLength={4000} spellCheck={false} />
        </label>
      )}
      <div className="attention-actions">
        <button type="button" className="button" onClick={() => answer('deny')}>
          Deny
        </button>
        {approval.offersRun && (
          <button type="button" className="button" onClick={() => answer('run')}>
            For this task
          </button>
        )}
        {approval.offersAlways && (
          <button type="button" className="button" onClick={() => answer('always')}>
            Always for {approval.app}
          </button>
        )}
        <button type="button" className="button button--amber" onClick={() => answer('once')}>
          {edited ? 'Type my version' : 'Allow once'}
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
