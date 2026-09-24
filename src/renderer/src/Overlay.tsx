export function Overlay() {
  return (
    <div className="fixed inset-0 grid place-items-center">
      <div style={{ width: 200, height: 200, background: 'var(--color-debug)' }} aria-label="Phase 0 capture probe" />
    </div>
  )
}
