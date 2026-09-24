import type { UiAct } from '../../../shared/ui-events'

const CAPS: Record<string, string> = {
  cmd: '⌘', command: '⌘', shift: '⇧', option: '⌥', alt: '⌥', ctrl: '⌃', control: '⌃', fn: 'fn',
  return: '↩', enter: '↩', tab: '⇥', escape: '⎋', esc: '⎋', delete: '⌫', forwarddelete: '⌦', space: 'Space',
  up: '↑', down: '↓', left: '←', right: '→', pageup: '⇞', pagedown: '⇟', home: '↖', end: '↘',
}

/** A key chord as the symbols printed on a Mac keyboard: "cmd+shift+d" → ⌘ ⇧ D. */
export function keycaps(chord: string): string[] {
  return chord
    .split('+')
    .filter(Boolean)
    .map((k) => CAPS[k.toLowerCase()] ?? (/^f\d{1,2}$/i.test(k) ? k.toUpperCase() : k.length === 1 ? k.toUpperCase() : k))
}

const ARROWS = { up: '↑', down: '↓', left: '←', right: '→' } as const
const quoted = (label: string) => (label.startsWith('“') ? label : `“${label}”`)

/** The cursor chip: what the hand is doing, in two or three words. */
export function gestureLabel(act: UiAct): string {
  const on = act.label ? ` ${quoted(act.label)}` : ''
  switch (act.verb) {
    case 'click': {
      const held = act.held?.length ? `${keycaps(act.held.join('+')).join('')} ` : ''
      const kind = act.button === 'right' ? 'Right-click' : (act.count ?? 1) === 2 ? 'Double-click' : (act.count ?? 1) === 3 ? 'Triple-click' : 'Click'
      return `${held}${kind}${on}`
    }
    case 'drag':
      return `Drag${on}`
    case 'scroll':
      return `Scroll${act.direction ? ` ${ARROWS[act.direction]}` : ''}`
    case 'type':
      return 'Type'
    case 'key':
      return 'Press'
    case 'set':
      return `Set${on}`
    case 'menu':
      return `Menu${on}`
    case 'launch':
      return `Open${act.label ? ` ${act.label}` : ''}`
    case 'other':
      return 'Act'
  }
}
