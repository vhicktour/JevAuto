import { useEffect, useState } from 'react'

export function Harness() {
  const [lines, setLines] = useState<string[]>([])
  useEffect(() => {
    void window.jevauto.command<string[]>({ type: 'status' }).then(setLines)
    return window.jevauto.subscribe((event) => {
      const e = event as { type?: string; line?: string }
      if (e.type === 'status' && e.line) setLines((prev) => [...prev, e.line!])
    })
  }, [])
  return (
    <main className="p-8 pt-12 font-mono text-sm">
      <h1 className="mb-4 text-lg" style={{ fontFamily: 'var(--font-display)' }}>JevAuto Phase 0</h1>
      <ol className="space-y-1">{lines.map((l, i) => <li key={i}>{l}</li>)}</ol>
    </main>
  )
}
