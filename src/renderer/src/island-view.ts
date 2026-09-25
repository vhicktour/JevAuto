import type { UiAct, UiApproval, UiEvent, UiView } from '../../shared/ui-events'
import { narrate } from '../../shared/narrate'

export { narrate }

/** One symbol per kind of step, for the timelines in the island and the activity window. */
export const GLYPH: Record<UiAct['verb'], string> = { click: '◉', type: '⌨', drag: '⇢', key: '⌥', set: '✎', menu: '☰', launch: '↗', scroll: '⇅', other: '•' }

export type IslandMode = 'rest' | 'working' | 'attention' | 'error' | 'done' | 'stopped'
export type IslandStep = { id: string; verb: UiAct['verb']; text: string; ok?: boolean }
export type IslandView = {
  mode: IslandMode
  title: string
  detail?: string
  step?: { n: number; of: number }
  approval?: UiApproval
  /** The latest picture of the target, and whether the cursor can't be shown on it (then the island shows the picture). */
  preview?: UiView
  hidden?: boolean
  /** The run's last few steps, named in full, with how each went. */
  steps?: IslandStep[]
}

export const REST: IslandView = { mode: 'rest', title: '' }

const MODES: Record<string, IslandMode> = { idle: 'rest', working: 'working', 'needs-you': 'attention', error: 'error', done: 'done', stopped: 'stopped' }
const LIVE = new Set<IslandMode>(['working', 'attention'])
const TIMELINE = 6

export function reduceIsland(view: IslandView, event: UiEvent): IslandView {
  if (event.type === 'status') {
    const { state, title, detail, step } = event.status
    const mode = MODES[state]
    if (mode === 'rest') return REST
    // Working again after an approval or a question is the same run; working after the run ended is a new one.
    const kept =
      mode === 'working' && !LIVE.has(view.mode)
        ? { steps: [] }
        : { ...(view.steps ? { steps: view.steps } : {}), ...(view.preview ? { preview: view.preview } : {}), ...(view.hidden !== undefined ? { hidden: view.hidden } : {}) }
    return {
      mode,
      title,
      ...(detail ? { detail } : mode === 'working' && view.mode === 'working' && view.detail ? { detail: view.detail } : {}),
      ...(step ? { step } : {}),
      ...kept,
    }
  }
  if (event.type === 'view') return view.mode === 'rest' ? view : { ...view, preview: event.view }
  if (event.type === 'approval') return { ...view, mode: 'attention', title: event.approval.title, detail: event.approval.reason, approval: event.approval }
  if (event.type === 'approval-closed' && view.approval?.id === event.id) {
    const { approval: _closed, ...rest } = view
    return rest
  }
  if (event.type === 'act' && LIVE.has(view.mode)) {
    const a = event.act
    // A key press has no point on screen either way, so it leaves the picture as it was.
    const hidden = a.verb === 'key' ? view.hidden : !a.visible
    return {
      ...view,
      ...(view.mode === 'working' ? { detail: narrate(a) } : {}),
      steps: [...(view.steps ?? []), { id: a.id, verb: a.verb, text: narrate(a, true) }].slice(-TIMELINE),
      ...(hidden !== undefined ? { hidden } : {}),
    }
  }
  if (event.type === 'done' && view.steps?.some((s) => s.id === event.done.id))
    return { ...view, steps: view.steps.map((s) => (s.id === event.done.id ? { ...s, ok: event.done.ok } : s)) }
  return view
}
