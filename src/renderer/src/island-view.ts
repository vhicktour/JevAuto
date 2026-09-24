import type { UiApproval, UiEvent } from '../../shared/ui-events'
import { narrate } from '../../shared/narrate'

export { narrate }

export type IslandMode = 'rest' | 'working' | 'attention' | 'error' | 'done' | 'stopped'
export type IslandView = { mode: IslandMode; title: string; detail?: string; step?: { n: number; of: number }; approval?: UiApproval }

export const REST: IslandView = { mode: 'rest', title: '' }

const MODES: Record<string, IslandMode> = { idle: 'rest', working: 'working', 'needs-you': 'attention', error: 'error', done: 'done', stopped: 'stopped' }

export function reduceIsland(view: IslandView, event: UiEvent): IslandView {
  if (event.type === 'status') {
    const { state, title, detail, step } = event.status
    const mode = MODES[state]
    if (mode === 'rest') return REST
    return { mode, title, ...(detail ? { detail } : mode === 'working' && view.mode === 'working' && view.detail ? { detail: view.detail } : {}), ...(step ? { step } : {}) }
  }
  if (event.type === 'approval') return { ...view, mode: 'attention', title: event.approval.title, detail: event.approval.reason, approval: event.approval }
  if (event.type === 'approval-closed' && view.approval?.id === event.id) {
    const { approval: _closed, ...rest } = view
    return rest
  }
  if (event.type === 'act' && view.mode === 'working') return { ...view, detail: narrate(event.act) }
  return view
}
