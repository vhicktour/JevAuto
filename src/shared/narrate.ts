import type { UiAct } from './ui-events'

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
