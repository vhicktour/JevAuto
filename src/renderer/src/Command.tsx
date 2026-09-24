import { useEffect, useRef, useState } from 'react'
import { CursorGlyph } from './cursor/CursorGlyph'
import { command } from './events'

/** The ⌃⌥Space bar: type a task, press Return, and the bar gets out of the way. */
export function CommandBar() {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const focus = () => {
      input.current?.focus()
      input.current?.select()
    }
    focus()
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [])

  const submit = () => {
    const task = text.trim()
    if (!task) return
    void command({ type: 'task', text: task })
    setText('')
  }

  return (
    <form
      className="command-bar"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <CursorGlyph id="command" size={20} />
      <input
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') void command({ type: 'command-bar', open: false })
        }}
        placeholder="What should JevAuto do?"
        aria-label="Task"
        spellCheck={false}
        maxLength={2000}
      />
      <kbd>↩</kbd>
    </form>
  )
}
