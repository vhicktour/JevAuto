/** A key chord in Cua's terms: `press_key` for one key, `hotkey` when modifiers are held. */
export type CuaKeys = { tool: 'press_key'; key: string } | { tool: 'hotkey'; keys: string[] }

const MODIFIERS: Record<string, string> = {
  cmd: 'cmd', command: 'cmd', meta: 'cmd', super: 'cmd', win: 'cmd',
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'option', option: 'option', opt: 'option',
  shift: 'shift',
  fn: 'fn',
}

// Models trained on Linux and Windows use xdotool and DOM names; Cua uses macOS ones. On a Mac, Delete is backspace.
const KEYS: Record<string, string> = {
  enter: 'return', return: 'return', kp_enter: 'return', numpadenter: 'return',
  esc: 'escape', escape: 'escape',
  tab: 'tab',
  space: 'space', spacebar: 'space', ' ': 'space',
  backspace: 'delete', back_space: 'delete', delete: 'delete', del: 'delete',
  up: 'up', arrowup: 'up', arrow_up: 'up',
  down: 'down', arrowdown: 'down', arrow_down: 'down',
  left: 'left', arrowleft: 'left', arrow_left: 'left',
  right: 'right', arrowright: 'right', arrow_right: 'right',
  pageup: 'pageup', page_up: 'pageup', pgup: 'pageup',
  pagedown: 'pagedown', page_down: 'pagedown', pgdn: 'pagedown',
  home: 'home', end: 'end',
}

/** Cua's name for a modifier key, or undefined when `raw` is not one. */
export function modifierName(raw: string): string | undefined {
  return MODIFIERS[raw.toLowerCase()]
}

function keyName(raw: string): string | undefined {
  const k = raw.toLowerCase()
  if (KEYS[k]) return KEYS[k]
  if (/^f([1-9]|1[0-9]|20)$/.test(k)) return k
  if ([...raw].length === 1) return k // a letter, digit or punctuation mark
  return undefined
}

/** Maps a provider's key chord to one Cua call, or an error the model can read and act on. */
export function toCuaKeys(keys: string[]): CuaKeys | { error: string } {
  if (!keys.length) return { error: 'No key was given.' }
  const modifiers: string[] = []
  const others: string[] = []
  for (const raw of keys) {
    const modifier = modifierName(raw)
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier)
      continue
    }
    const key = keyName(raw)
    if (!key) return { error: `Unknown key "${raw}". Use names like return, tab, escape, up, pageup, f5, or a single character.` }
    others.push(key)
  }
  if (!others.length) return { error: 'A modifier on its own does nothing. Add the key to press, for example ["CMD", "S"].' }
  if (others.length > 1) return { error: 'Press one key per keypress (modifiers are fine). Use the type action for text.' }
  return modifiers.length ? { tool: 'hotkey', keys: [...modifiers, others[0]] } : { tool: 'press_key', key: others[0] }
}
