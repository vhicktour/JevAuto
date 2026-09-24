import { UiEvent } from '../../shared/ui-events'

/** Subscribe to main's events; anything that doesn't match the schema is dropped (renderer trust boundary). */
export function onUiEvent(listener: (event: UiEvent) => void): () => void {
  return window.jevauto.subscribe((raw) => {
    const parsed = UiEvent.safeParse(raw)
    if (parsed.success) listener(parsed.data)
  })
}

export const command = <T = unknown>(c: { type: string; [key: string]: unknown }) => window.jevauto.command<T>(c)

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
