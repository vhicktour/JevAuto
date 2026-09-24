import type { ElementInfo } from '../mac/results'
import type { IrAction } from '../providers/ir'

const short = (s: string, n = 40) => {
  const t = s.replace(/\r\n|\r|\n/g, '↵')
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const at = (p: { x: number; y: number }) => `(${Math.round(p.x)}, ${Math.round(p.y)})`

/** A few plain words for an action, used in notes to the model, approvals and the run log. */
export function describeAction(a: IrAction, element?: ElementInfo): string {
  const label = element?.label?.trim()
  switch (a.kind) {
    case 'click': {
      const verb = a.button === 'right' ? 'right-click' : (a.count ?? 1) > 1 ? 'double-click' : 'click'
      const held = a.keys?.length ? `${a.keys.join('+').toLowerCase()}+` : ''
      return label ? `${held}${verb} “${short(label)}”` : `${held}${verb} at ${at(a)}`
    }
    case 'type':
      return `type “${short(a.text)}”`
    case 'keys':
      return `press ${a.keys.join('+').toLowerCase()}`
    case 'scroll':
      return `scroll ${a.dy > 0 ? 'down' : a.dy < 0 ? 'up' : a.dx > 0 ? 'right' : 'left'}`
    case 'drag':
      return `drag from ${at(a.path[0])} to ${at(a.path[a.path.length - 1])}`
    case 'move':
      return `move to ${at(a)}`
    case 'wait':
    case 'screenshot':
      return a.kind
    case 'tool':
    case 'other':
      return a.name
  }
}
