/** Pure checks the desktop suite grades with: every verdict comes from app state or files, never from the model's word alone. */

/** Whether `text` appears in an RTF document and is bold there: the nearest \b or \b0 before it, else a bold font face. */
export function rtfBold(rtf: string, text: string): { found: boolean; bold: boolean } {
  const at = rtf.indexOf(text)
  if (at < 0) return { found: false, bold: false }
  const before = rtf.slice(0, at)
  // \b and \b0 only; \blue255 or \bin are other control words.
  const marker = [...before.matchAll(/\\b(0?)(?![a-z])/g)].pop()
  if (marker) return { found: true, bold: marker[1] === '' }
  const font = [...before.matchAll(/\\f(\d+)(?![a-z\d])/g)].pop()
  const faces = new Map([...rtf.matchAll(/\\f(\d+)\\f[a-z]+\\fcharset\d+ ([^;]+);/g)].map((m) => [m[1], m[2]]))
  return { found: true, bold: !!font && /bold/i.test(faces.get(font[1]) ?? '') }
}

/** macOS keeps the appearance in two global defaults: AppleInterfaceStyle (Dark) and the automatic switch. */
export function appearanceOf(style: string | null, automatic: string | null): 'Light' | 'Dark' | 'Auto' {
  if (automatic?.trim() === '1') return 'Auto'
  return style?.trim() === 'Dark' ? 'Dark' : 'Light'
}

/** The answer names `expected`, and names it before any of the other options. */
export function answers(text: string, expected: string, others: string[]): boolean {
  const find = (word: string) => text.search(new RegExp(`\\b${word}\\b`, 'i'))
  const at = find(expected)
  return at >= 0 && others.every((o) => find(o) < 0 || find(o) > at)
}

export function mentionsNumber(text: string, n: number): boolean {
  const plain = String(n)
  const grouped = n.toLocaleString('en-US')
  return [plain, grouped].some((form) => new RegExp(`(^|[^\\d,.])${form.replace(/,/g, ',?')}(?![\\d])`).test(text))
}
