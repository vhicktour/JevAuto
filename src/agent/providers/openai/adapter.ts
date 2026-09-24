import OpenAI from 'openai'
import { CANVAS } from '../../frame/frame'
import type { Adapter, CallResult, Turn } from '../../loop/adapter'
import { TOOL_DEFS } from '../../loop/tools'
import { parseOpenAI } from './parse'
import { shouldRetry } from '../errors'

type Body = Record<string, unknown>
type Response = { id: string; output: unknown[]; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } } }
/** The slice of the OpenAI SDK the adapter uses, so tests can stand in for it. */
export type OpenAIClient = { responses: { create(body: Body, options?: { signal?: AbortSignal }): Promise<unknown> } }

const png = (base64: string) => `data:image/png;base64,${base64}`

/**
 * Responses API with the GA `computer` tool (spec §7). State rides on `previous_response_id`; instructions are not
 * carried between responses, so the same instructions and tools go with every request.
 */
export class OpenAIAdapter implements Adapter {
  readonly provider = 'openai' as const
  readonly canvas = CANVAS.openai
  private readonly tools = [{ type: 'computer' }, ...TOOL_DEFS.map((t) => ({ type: 'function', ...t, strict: true }))]
  private previous?: string

  constructor(
    private readonly client: OpenAIClient,
    readonly model: string,
    private readonly instructions: string,
    /** The first wait before asking again; it doubles each time (tests shorten it). */
    private readonly retryDelayMs = 1000,
  ) {}

  async start(input: { task: string; context: string; image?: string }, signal?: AbortSignal): Promise<Turn> {
    const content: Body[] = [{ type: 'input_text', text: `Task: ${input.task}\n\n${input.context}` }]
    if (input.image) content.push({ type: 'input_image', image_url: png(input.image), detail: 'original' })
    return this.send([{ role: 'user', content }], signal)
  }

  async next(input: { results: CallResult[]; image?: string; notes: string[] }, signal?: AbortSignal): Promise<Turn> {
    const items: Body[] = input.results.map((r) => {
      if (r.kind === 'function') return { type: 'function_call_output', call_id: r.callId, output: r.output }
      if (!input.image) throw new Error('A computer call must be answered with a screenshot.')
      return {
        type: 'computer_call_output',
        call_id: r.callId,
        output: { type: 'computer_screenshot', image_url: png(input.image), detail: 'original' },
        ...(r.acknowledged?.length ? { acknowledged_safety_checks: r.acknowledged } : {}),
      }
    })
    if (input.notes.length) items.push({ role: 'user', content: [{ type: 'input_text', text: input.notes.join('\n') }] })
    return this.send(items, signal)
  }

  /** Up to three tries, only for failures that can pass on their own (never an empty balance or a bad key). */
  private async create(body: Body, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.client.responses.create(body, signal ? { signal } : undefined)
      } catch (error) {
        if (attempt >= 3 || signal?.aborted || !shouldRetry(error)) throw error
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, this.retryDelayMs * 2 ** (attempt - 1))
          signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true })
        })
      }
    }
  }

  private async send(input: Body[], signal?: AbortSignal): Promise<Turn> {
    const body: Body = {
      model: this.model,
      instructions: this.instructions,
      tools: this.tools,
      ...(this.previous ? { previous_response_id: this.previous } : {}),
      input,
    }
    const response = (await this.create(body, signal)) as Response
    this.previous = response.id
    const u = response.usage
    return {
      ...parseOpenAI(response as Parameters<typeof parseOpenAI>[0]),
      id: response.id,
      usage: {
        inputTokens: u?.input_tokens ?? 0,
        cachedTokens: u?.input_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: u?.input_tokens_details?.cache_write_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
      },
    }
  }
}

/**
 * The SDK waits up to ten minutes by default; one request once took 303 s. A turn is only acted on once it has fully
 * arrived, so cutting a hung request off and asking again is safe. The adapter retries, not the SDK, so an empty
 * balance fails at once instead of three times.
 */
export const OPENAI_CLIENT_OPTIONS = { timeout: 90_000, maxRetries: 0 } as const

/** An adapter on the real SDK. Without `apiKey` the SDK reads OPENAI_API_KEY (the terminal runner's .env.local). */
export function openAIAdapter(model: string, instructions: string, apiKey?: string): OpenAIAdapter {
  // The SDK's request types lag the computer tool (Spike C), so the adapter takes the narrow client shape it uses.
  return new OpenAIAdapter(new OpenAI({ ...OPENAI_CLIENT_OPTIONS, ...(apiKey ? { apiKey } : {}) }) as unknown as OpenAIClient, model, instructions)
}
