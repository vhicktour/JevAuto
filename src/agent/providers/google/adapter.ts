import { GoogleGenAI } from '@google/genai'
import { CANVAS } from '../../frame/frame'
import type { Adapter, CallResult, Turn } from '../../loop/adapter'
import { TOOL_DEFS } from '../../loop/tools'
import { withRetry } from '../retry'
import { GEMINI_ACTIONS, parseGoogle } from './parse'

type Body = Record<string, unknown>
type Interaction = {
  id: string
  steps?: { type: string; id?: string; name?: string }[]
  usage?: { total_input_tokens?: number; raw_prompt_token?: number; total_cached_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number }
}
/** The slice of @google/genai the adapter uses, so tests can stand in for it. */
export type GeminiClient = { interactions: { create(body: Body, options?: { signal?: AbortSignal }): Promise<unknown>; delete(id: string): Promise<unknown> } }

/** Holding keys or the mouse button down across calls can't be done in the background; the model doesn't get them. */
export const GEMINI_EXCLUDED = ['key_down', 'key_up', 'mouse_down', 'mouse_up']

/**
 * Gemini's Interactions API with desktop computer use (spec §7): prompt-injection detection on (it is off by default),
 * coordinates on a 0–999 grid, state on `previous_interaction_id`, and tools and instructions sent with every turn.
 * Gemini stores interactions for 55 days unless told otherwise, so the adapter deletes its own when the run ends.
 */
export class GeminiAdapter implements Adapter {
  readonly provider = 'google' as const
  readonly canvas = CANVAS.google
  private readonly tools = [
    { type: 'computer_use', environment: 'desktop', enable_prompt_injection_detection: true, excluded_predefined_functions: GEMINI_EXCLUDED },
    ...TOOL_DEFS.map((t) => ({ type: 'function', ...t })),
  ]
  private previous?: string
  private created: string[] = []
  private names = new Map<string, string>()

  constructor(
    private readonly client: GeminiClient,
    readonly model: string,
    private readonly instructions: string,
    private readonly retryDelayMs = 1000,
  ) {}

  async start(input: { task: string; context: string; image?: string }, signal?: AbortSignal): Promise<Turn> {
    const content: Body[] = [{ type: 'text', text: `Task: ${input.task}\n\n${input.context}` }]
    if (input.image) content.push({ type: 'image', data: input.image, mime_type: 'image/png' })
    return this.send(content, signal)
  }

  async next(input: { results: CallResult[]; image?: string; notes: string[]; url?: string }, signal?: AbortSignal): Promise<Turn> {
    const url = input.url ?? 'about:blank' // Gemini wants the current address with every result; a Mac window has none
    const items: Body[] = input.results.map((r) => {
      const called = this.names.get(r.callId)
      // One of our own functions: its name and what it returned.
      if (r.kind === 'function' && !(called && GEMINI_ACTIONS.has(called))) return { type: 'function_result', call_id: r.callId, name: r.name, result: r.output }
      // A computer-use function (navigate included) must be answered with the screenshot, and it has to come first:
      // the API rejects [text, image] with "requires ... an image ... in the data.inline_data field" (probed live).
      if (!input.image) throw new Error('A computer call must be answered with a screenshot.')
      const note =
        r.kind === 'function'
          ? { url, result: JSON.parse(r.output) as unknown }
          : { url, ...(r.acknowledged?.length ? { safety_acknowledgement: true } : {}) }
      return {
        type: 'function_result',
        call_id: r.callId,
        name: called,
        result: [
          { type: 'image', data: input.image, mime_type: 'image/png' },
          { type: 'text', text: JSON.stringify(note) },
        ],
      }
    })
    if (input.notes.length) items.push({ type: 'text', text: input.notes.join('\n') })
    return this.send(items, signal)
  }

  async close(): Promise<void> {
    const ids = this.created.splice(0)
    await Promise.all(ids.map((id) => this.client.interactions.delete(id).catch(() => undefined)))
  }

  private async send(input: Body[], signal?: AbortSignal): Promise<Turn> {
    const body: Body = {
      model: this.model,
      system_instruction: this.instructions,
      tools: this.tools,
      ...(this.previous ? { previous_interaction_id: this.previous } : {}),
      input,
    }
    const interaction = (await withRetry(() => this.client.interactions.create(body, signal ? { signal } : undefined), signal, this.retryDelayMs)) as Interaction
    this.previous = interaction.id
    this.created.push(interaction.id)
    for (const s of interaction.steps ?? []) if (s.type === 'function_call' && s.id && s.name) this.names.set(s.id, s.name)
    const u = interaction.usage
    return {
      ...parseGoogle(interaction as Parameters<typeof parseGoogle>[0]),
      id: interaction.id,
      usage: {
        // The prompt Gemini bills includes the tool definitions, which total_input_tokens leaves out; thinking bills as output.
        inputTokens: u?.raw_prompt_token ?? u?.total_input_tokens ?? 0,
        cachedTokens: u?.total_cached_tokens ?? 0,
        cacheWriteTokens: 0,
        outputTokens: (u?.total_output_tokens ?? 0) + (u?.total_thought_tokens ?? 0),
      },
    }
  }
}

export function geminiAdapter(model: string, instructions: string, apiKey?: string): GeminiAdapter {
  // The SDK's interaction types trail the computer-use tool shape, so the adapter takes the narrow client it uses.
  return new GeminiAdapter(new GoogleGenAI({ apiKey: apiKey ?? process.env.GEMINI_API_KEY }) as unknown as GeminiClient, model, instructions)
}
