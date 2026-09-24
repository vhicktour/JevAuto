/** Spike B's capture probes: a magenta square on every display, and a placeholder pill at the notch. */
export function ProbeOverlay() {
  return (
    <div className="fixed inset-0 grid place-items-center">
      <div style={{ width: 200, height: 200, background: 'var(--color-debug)' }} aria-label="Phase 0 capture probe" />
    </div>
  )
}

export function ProbeIsland() {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-b-3xl text-xs" style={{ background: 'var(--color-ink)', color: 'var(--color-pearl)' }}>
      JevAuto · island placement test
    </div>
  )
}
