import Anthropic from '@anthropic-ai/sdk'
import { CANVAS } from '../../frame/frame'
import type { Adapter, CallResult, Turn } from '../../loop/adapter'
import { TOOL_DEFS } from '../../loop/tools'
import { withRetry } from '../retry'
import { parseAnthropic } from './parse'

type Block = Record<string, unknown>
type Message = { role: 'user' | 'assistant'; content: Block[] }
type Response = {
  id: string
  content: Block[]
  stop_reason?: string | null
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number }
}
/** The slice of @anthropic-ai/sdk the adapter uses, so tests can stand in for it. */
export type AnthropicClient = { beta: { messages: { create(body: Block, options?: { signal?: AbortSignal }): Promise<unknown> } } }

/** Members that can't work in the background (holding keys or the button, hovering) or that JevAuto doesn't serve yet (zoom). */
export const CLAUDE_DISABLED = ['zoom', 'mouse_move', 'left_mouse_down', 'left_mouse_up', 'hold_key', 'cursor_position']
/** The toolset's own halt text for calls after a failure in the same turn; it must be exactly this (spec §7). */
export const HALT = 'Not executed: an earlier computer action in this turn failed.'
/** Models that show their between-step notes as thinking "updates" (spec §7). */
const UPDATES = new Set(['claude-opus-5-5', 'claude-fable-5-1'])

const image = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })
const isError = (output: string) => {
  try {
    return typeof (JSON.parse(output) as { error?: unknown })?.error === 'string'
  } catch {
    return false
  }
}

/**
 * Claude's Messages API with `computer_toolset_20260801` (spec §7). The conversation is append-only: each assistant
 * turn goes back exactly as it came, thinking blocks included, and tools and instructions never change during a run.
 * Old screenshots are cleared server-side by context editing, which leaves thinking intact; one cache breakpoint
 * moves to the newest block each turn so the rest of the history reads from cache.
 */
export class AnthropicAdapter implements Adapter {
  readonly provider = 'anthropic' as const
  readonly canvas = CANVAS.anthropic
  private readonly tools = [
    { type: 'computer_toolset_20260801', configs: Object.fromEntries(CLAUDE_DISABLED.map((m) => [m, { enabled: false }])) },
    ...TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, strict: true })),
  ]
  private messages: Message[] = []
  private members = new Map<string, string>()

  constructor(
    private readonly client: AnthropicClient,
    readonly model: string,
    private readonly instructions: string,
    private readonly retryDelayMs = 1000,
  ) {}

  async start(input: { task: string; context: string; image?: string }, signal?: AbortSignal): Promise<Turn> {
    const content: Block[] = [{ type: 'text', text: `Task: ${input.task}\n\n${input.context}` }]
    if (input.image) content.push(image(input.image))
    this.messages.push({ role: 'user', content })
    return this.send(signal)
  }

  async next(input: { results: CallResult[]; image?: string; notes: string[] }, signal?: AbortSignal): Promise<Turn> {
    // The newest screenshot rides on the last call that ran (or on a screenshot call), so Claude sees where things stand.
    const lastOk = input.results.map((r, i) => (r.kind === 'computer' && (r.status ?? 'ok') === 'ok' ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
    const content: Block[] = input.results.map((r, i) => {
      if (r.kind === 'function') return { type: 'tool_result', tool_use_id: r.callId, ...(isError(r.output) ? { is_error: true } : {}), content: r.output }
      const base = { type: 'tool_result', tool_use_id: r.callId, toolset_name: 'computer' }
      if (r.status === 'not-run') return { ...base, is_error: true, content: HALT }
      if (r.status === 'failed') return { ...base, is_error: true, content: `Error: ${r.message ?? 'the action failed'}` }
      if (this.members.get(r.callId) === 'screenshot' && input.image) return { ...base, content: [image(input.image)] }
      if (i === lastOk && input.image) return { ...base, content: [{ type: 'text', text: 'OK' }, image(input.image)] }
      return { ...base, content: 'OK' }
    })
    for (const note of input.notes) content.push({ type: 'text', text: note })
    this.messages.push({ role: 'user', content })
    return this.send(signal)
  }

  private async send(signal?: AbortSignal): Promise<Turn> {
    const updates = UPDATES.has(this.model)
    const body: Block = {
      model: this.model,
      max_tokens: 32_000,
      system: [{ type: 'text', text: this.instructions }],
      tools: this.tools,
      messages: withBreakpoint(this.messages),
      thinking: { type: 'adaptive', ...(updates ? { display: 'updates' } : {}) },
      output_config: { effort: 'high' },
      betas: ['context-management-2025-06-27', ...(updates ? ['thinking-display-updates-2026-08-18'] : [])],
      context_management: { edits: [{ type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 40_000 }, keep: { type: 'tool_uses', value: 12 }, clear_tool_inputs: false }] },
    }
    const response = (await withRetry(() => this.client.beta.messages.create(body, signal ? { signal } : undefined), signal, this.retryDelayMs)) as Response
    // A reply cut off at max_tokens may end in a half-written call; nothing from it runs (spec §7 rule 1).
    if (response.stop_reason === 'max_tokens') throw new Error('Claude’s reply was cut off before it finished, so nothing in it was run.')
    this.messages.push({ role: 'assistant', content: response.content })
    for (const b of response.content) if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') this.members.set(b.id, b.name)
    const u = response.usage
    const cached = u?.cache_read_input_tokens ?? 0
    const written = u?.cache_creation_input_tokens ?? 0
    return {
      ...parseAnthropic(response),
      id: response.id,
      usage: { inputTokens: (u?.input_tokens ?? 0) + cached + written, cachedTokens: cached, cacheWriteTokens: written, outputTokens: u?.output_tokens ?? 0 },
    }
  }
}

/** A copy of the history with a single cache breakpoint on its newest block (the API allows four; old ones move). */
function withBreakpoint(messages: Message[]): Message[] {
  const copy = messages.map((m) => ({ ...m, content: m.content.map((b) => ('cache_control' in b ? (({ cache_control: _dropped, ...rest }) => rest)(b) : b)) }))
  const last = copy.at(-1)
  if (last?.role === 'user' && last.content.length) last.content[last.content.length - 1] = { ...last.content.at(-1)!, cache_control: { type: 'ephemeral' } }
  return copy
}

/** Organisation-level keys must name their workspace; SDK 0.128.0 has no option for it, so it goes in a header. */
export function anthropicAdapter(model: string, instructions: string, apiKey: string, workspace?: string): AnthropicAdapter {
  const client = new Anthropic({ apiKey, timeout: 90_000, maxRetries: 0, ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}) })
  // The SDK's beta types trail the toolset and context-editing shapes, so the adapter takes the narrow client it uses.
  return new AnthropicAdapter(client as unknown as AnthropicClient, model, instructions)
}
