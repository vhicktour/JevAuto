import type { UiAct, UiEvent } from '../../shared/ui-events'

export type IslandMode = 'rest' | 'working' | 'attention' | 'error' | 'done' | 'stopped'
export type IslandView = { mode: IslandMode; title: string; detail?: string; step?: { n: number; of: number } }

export const REST: IslandView = { mode: 'rest', title: '' }

const VERB: Record<UiAct['verb'], string> = {
  click: 'Clicking',
  type: 'Typing',
  drag: 'Dragging',
  key: 'Pressing',
  set: 'Setting',
  menu: 'Choosing',
  launch: 'Opening',
  scroll: 'Scrolling',
  other: 'Working',
}

const quoted = (label: string) => (label.startsWith('“') ? label : `“${label}”`)

/** One line of plain narration. A hidden target is never pointed at, only named (occlusion rule). */
export function narrate(act: UiAct): string {
  if (!act.visible && act.app && act.verb !== 'key') return `Working in ${act.app}`
  const bare = act.verb === 'key' || act.verb === 'launch' // key names and app names read better unquoted
  const what = act.label ? (bare ? ` ${act.label}` : ` ${quoted(act.label)}`) : ''
  const where = act.app && act.verb !== 'key' ? ` in ${act.app}` : ''
  return `${VERB[act.verb]}${what}${where}`
}

const MODES: Record<string, IslandMode> = { idle: 'rest', working: 'working', 'needs-you': 'attention', error: 'error', done: 'done', stopped: 'stopped' }

export function reduceIsland(view: IslandView, event: UiEvent): IslandView {
  if (event.type === 'status') {
    const { state, title, detail, step } = event.status
    const mode = MODES[state]
    if (mode === 'rest') return REST
    return { mode, title, ...(detail ? { detail } : mode === 'working' && view.mode === 'working' && view.detail ? { detail: view.detail } : {}), ...(step ? { step } : {}) }
  }
  if (event.type === 'act' && view.mode === 'working') return { ...view, detail: narrate(event.act) }
  return view
}
