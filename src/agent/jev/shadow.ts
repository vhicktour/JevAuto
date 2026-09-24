import { jevClient } from './client'
import { buildJevRequest, type SnapshotResult } from './questions'

export type ShadowPage = { url: string; title: string; text: string; controls: { index: number; role: string; label: string }[] }
export type ShadowGuess = { operation: string; target?: { index: number; label: string }; confidence: number; ms: number }
type Answer = { choice?: string; confidence?: number }
type Ask = (request: ReturnType<typeof buildJevRequest>) => Promise<{ answers: Record<string, Answer | undefined> }>

const CLICKABLE = new Set(['AXButton', 'AXLink', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton', 'AXMenuItem'])

/**
 * Jev in shadow mode on web pages (spec §5, §6): given the goal and the page's text and controls, which would it
 * click? The guess is only logged beside the frontier model's choice, to calibrate a fast path later; it never acts.
 * Only text goes to TypeSafe: no screenshots, no password fields (the page scan never reads them).
 */
export class JevShadow {
  constructor(private readonly ask: Ask) {}

  async guess(goal: string, page: ShadowPage): Promise<ShadowGuess | undefined> {
    const clickable = page.controls.filter((c) => CLICKABLE.has(c.role) && c.label.trim())
    if (!clickable.length) return undefined
    const snap: SnapshotResult = {
      url: page.url,
      title: page.title,
      text: page.text,
      actions: clickable.map((c) => ({ id: `e${c.index}`, kind: 'click' as const, node: c.index, role: c.role, label: c.label })),
    }
    const started = performance.now()
    try {
      const { answers } = await this.ask(buildJevRequest(goal, snap))
      const operation = answers.operation?.choice ?? 'UNKNOWN'
      const hit = clickable.find((c) => String(c.index) === answers.click_target?.choice)
      return {
        operation,
        ...(operation === 'CLICK' && hit ? { target: { index: hit.index, label: hit.label } } : {}),
        confidence: answers.click_target?.confidence ?? answers.operation?.confidence ?? 0,
        ms: Math.round(performance.now() - started),
      }
    } catch {
      return undefined // the shadow never gets in the way of the run
    }
  }
}

export function jevShadow(apiKey: string): JevShadow {
  const client = jevClient(apiKey)
  return new JevShadow((request) => client.systemOne(request) as unknown as ReturnType<Ask>)
}
