import { useEffect, useState } from 'react'
import { command, onUiEvent } from './events'

type Update = { status: 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error'; version?: string; error?: string }
type View = { auto: boolean; excluded: string[]; trusted: { id: string; app: string }[]; keys: Record<string, boolean>; version: string; update: Update }

const UPDATE_LINE: Record<Update['status'], (u: Update) => string> = {
  off: () => 'Updates arrive with signed releases (off in this build).',
  idle: () => 'Up to date.',
  checking: () => 'Checking for updates…',
  downloading: (u) => `Downloading JevAuto ${u.version}…`,
  ready: (u) => `JevAuto ${u.version} is ready.`,
  error: () => 'Could not check for updates. JevAuto tries again later.',
}
const KEYS: { name: string; label: string; hint: string }[] = [
  { name: 'openai', label: 'OpenAI', hint: 'GPT-6 models' },
  { name: 'google', label: 'Gemini', hint: 'Gemini models' },
  { name: 'anthropic', label: 'Anthropic', hint: 'Claude models' },
  { name: 'anthropicWorkspace', label: 'Anthropic workspace', hint: 'Needed with an organisation key' },
  { name: 'typesafe', label: 'TypeSafe', hint: 'Jev' },
]

/** Keys (stored in your Keychain, never shown again), the apps JevAuto must never touch, access and diagnostics. */
export function Settings({ access }: { access: { accessibility: boolean; screenRecording: boolean } | null }) {
  const [view, setView] = useState<View | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [excluded, setExcluded] = useState('')
  const [note, setNote] = useState('')

  const load = (v: View) => {
    setView(v)
    setExcluded(v.excluded.join('\n'))
  }
  useEffect(() => void command<View>({ type: 'settings' }).then(load), [])
  useEffect(() => onUiEvent((e) => e.type === 'update' && setView((v) => (v ? { ...v, update: e.update } : v))), [])
  const flash = (text: string) => {
    setNote(text)
    setTimeout(() => setNote(''), 2200)
  }
  const saveKey = async (name: string, value: string) => {
    load(await command<View>({ type: 'set-key', name, value }))
    setDrafts((d) => ({ ...d, [name]: '' }))
    flash(value ? 'Key saved. The agent restarted with it.' : 'Key cleared.')
  }

  if (!view) return null
  return (
    <div className="settings">
      <section className="card">
        <h2>Model keys</h2>
        <p className="settings-hint">Stored encrypted with your Mac’s Keychain. JevAuto never shows a key again.</p>
        {KEYS.map((k) => (
          <form
            key={k.name}
            className="key-row"
            onSubmit={(e) => {
              e.preventDefault()
              if (drafts[k.name]?.trim()) void saveKey(k.name, drafts[k.name])
            }}
          >
            <span className="key-label">
              {k.label}
              <small>{k.hint}</small>
            </span>
            <span className={`key-state${view.keys[k.name] ? ' is-set' : ''}`}>{view.keys[k.name] ? 'Set' : 'Not set'}</span>
            <input
              type="password"
              value={drafts[k.name] ?? ''}
              onChange={(e) => setDrafts((d) => ({ ...d, [k.name]: e.target.value }))}
              placeholder={view.keys[k.name] ? 'Replace…' : 'Paste key'}
              aria-label={`${k.label} key`}
              autoComplete="off"
              spellCheck={false}
            />
            {view.keys[k.name] && (
              <button type="button" className="button button--quiet" onClick={() => void saveKey(k.name, '')}>
                Clear
              </button>
            )}
          </form>
        ))}
      </section>

      <section className="card">
        <h2>Never touch these apps</h2>
        <p className="settings-hint">One app name or bundle id per line. JevAuto refuses to act in them.</p>
        <textarea className="settings-text" rows={3} value={excluded} onChange={(e) => setExcluded(e.target.value)} aria-label="Excluded apps" spellCheck={false} />
        <div className="settings-actions">
          <button
            type="button"
            className="button"
            onClick={async () => {
              load(await command<View>({ type: 'set-excluded', apps: excluded.split('\n').map((l) => l.trim()).filter(Boolean) }))
              flash('Saved.')
            }}
          >
            Save list
          </button>
        </div>
      </section>

      <section className={`card${view.auto ? ' card--auto' : ''}`}>
        <div className="card-title">
          <h2>Full auto</h2>
          <button
            type="button"
            className={`watch-toggle auto-toggle${view.auto ? ' is-on' : ''}`}
            aria-pressed={view.auto}
            onClick={async () => load(await command<View>({ type: 'auto', on: !view.auto }))}
          >
            <i />
            {view.auto ? 'On' : 'Off'}
          </button>
        </div>
        <p className="settings-hint">
          JevAuto stops asking: it sends, submits, buys and deletes when the task calls for it, brings apps forward on its own, and stops at a larger budget (150 actions, 20
          minutes, $3) instead of asking to go on.
        </p>
        <p className="settings-hint">
          Still refused: password fields, password managers, security prompts, JevAuto itself and the apps below. The model provider’s own safety checks still ask you. A web page
          can try to steer the agent, so use Full auto for tasks you are happy to let it finish alone.
        </p>
      </section>

      <section className="card">
        <h2>Allowed to come forward</h2>
        <p className="settings-hint">Apps you answered “Always” for. JevAuto brings them to the front for shortcuts without asking.</p>
        {view.trusted.length === 0 ? (
          <p className="settings-hint">None yet.</p>
        ) : (
          <ul className="trusted">
            {view.trusted.map((t) => (
              <li key={t.id}>
                <span>{t.app}</span>
                <button type="button" className="button button--quiet" onClick={async () => load(await command<View>({ type: 'untrust', id: t.id }))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Mac access</h2>
        <div className="settings-actions settings-actions--start">
          <button type="button" className="button" onClick={() => void command({ type: 'open-privacy', pane: 'accessibility' })}>
            {access?.accessibility ? 'Accessibility ✓' : 'Allow Accessibility…'}
          </button>
          <button type="button" className="button" onClick={() => void command({ type: 'open-privacy', pane: 'screen' })}>
            {access?.screenRecording ? 'Screen Recording ✓' : 'Allow Screen Recording…'}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>About</h2>
        <p className="settings-hint">
          JevAuto {view.version} · {UPDATE_LINE[view.update.status](view.update)}
        </p>
        {view.update.status === 'ready' && (
          <div className="settings-actions settings-actions--start">
            <button
              type="button"
              className="button button--primary"
              onClick={async () => {
                const ok = await command({ type: 'install-update' }).then(
                  () => true,
                  () => false,
                )
                if (!ok) flash('Finish or stop the task first.')
              }}
            >
              Restart to update
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Diagnostics</h2>
        <div className="settings-actions settings-actions--start">
          <button
            type="button"
            className="button"
            onClick={async () => {
              await command({ type: 'diagnostics' })
              flash('Copied. No keys, screenshots or task text are included.')
            }}
          >
            Copy diagnostics
          </button>
        </div>
      </section>
      {note && <p className="settings-note">{note}</p>}
    </div>
  )
}
