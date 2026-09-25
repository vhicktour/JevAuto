import { useEffect, useRef, useState } from 'react'
import { CursorGlyph } from './cursor/CursorGlyph'
import { command, onUiEvent } from './events'

/**
 * The ⌃⌥Space bar: type a task, press Return, and the bar gets out of the way. While a task runs, Return tells that
 * task something (steer) and ⌘Return lines up the next task (queue).
 */
export function CommandBar() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => onUiEvent((e) => e.type === 'status' && setBusy(e.status.state === 'working' || e.status.state === 'needs-you')), [])

  useEffect(() => {
    const focus = () => {
      input.current?.focus()
      input.current?.select()
    }
    focus()
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [])

  const submit = (queue: boolean) => {
    const task = text.trim()
    if (!task) return
    void command(busy ? (queue ? { type: 'task', text: task, when: 'next' } : { type: 'steer', text: task }) : { type: 'task', text: task })
    if (busy) void command({ type: 'command-bar', open: false })
    setText('')
  }

  return (
    <form
      className="command-bar"
      onSubmit={(e) => {
        e.preventDefault()
        submit(false)
      }}
    >
      <CursorGlyph id="command" size={20} />
      <input
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') void command({ type: 'command-bar', open: false })
          else if (e.key === 'Enter' && e.metaKey) {
            e.preventDefault()
            submit(true)
          }
        }}
        placeholder={busy ? 'Tell the running task something (↩), or queue the next task (⌘↩)' : 'What should JevAuto do?'}
        aria-label="Task"
        spellCheck={false}
        maxLength={2000}
      />
      <kbd>↩</kbd>
    </form>
  )
}
