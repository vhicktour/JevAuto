import { HostToAgent, type AgentInit, type AgentMethod, type AgentToHost } from '../shared/protocol'

export interface ParentPortLike {
  postMessage(message: AgentToHost): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
}
export type HandlerContext = { init: AgentInit; signal: AbortSignal; emit(name: string, data: unknown): void }
export type Handler = (params: unknown, ctx: HandlerContext) => Promise<unknown>

export function createAgent(
  port: ParentPortLike,
  handlers: Partial<Record<AgentMethod, Handler>>,
  hooks: { onShutdown?: () => Promise<void> } = {},
) {
  let init: AgentInit | undefined
  const running = new Map<string, AbortController>()
  port.on('message', async ({ data }) => {
    const parsed = HostToAgent.safeParse(data)
    if (!parsed.success) return
    const message = parsed.data
    if (message.type === 'init') {
      init = message
      port.postMessage({ type: 'ready' })
      return
    }
    if (message.type === 'cancel') {
      running.get(message.id)?.abort()
      return
    }
    if (message.type === 'shutdown') {
      for (const controller of running.values()) controller.abort()
      await hooks.onShutdown?.()
      port.postMessage({ type: 'shutdown-complete' })
      return
    }
    if (!init) {
      port.postMessage({ type: 'failure', id: message.id, error: 'The agent has not been initialised.' })
      return
    }
    const handler = handlers[message.method]
    if (!handler) {
      port.postMessage({ type: 'failure', id: message.id, error: `No handler for ${message.method}.` })
      return
    }
    const controller = new AbortController()
    running.set(message.id, controller)
    try {
      const value = await handler(message.params, {
        init,
        signal: controller.signal,
        emit: (name, eventData) => port.postMessage({ type: 'event', name, data: eventData }),
      })
      port.postMessage({ type: 'result', id: message.id, value })
    } catch (error) {
      port.postMessage({ type: 'failure', id: message.id, error: error instanceof Error ? error.message : String(error) })
    } finally {
      running.delete(message.id)
    }
  })
}
