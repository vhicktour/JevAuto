import { HostToAgent, type AgentInit, type AgentMethod, type AgentToHost, type Reply } from '../shared/protocol'

export interface ParentPortLike {
  postMessage(message: AgentToHost): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
}
export type HandlerContext = {
  init: AgentInit
  signal: AbortSignal
  emit(name: string, data: unknown): void
  /** Waits for your reply to something the handler asked (an approval, a question); undefined on timeout or cancel. */
  waitReply(id: string, timeoutMs: number): Promise<Reply | undefined>
  /** What you told the running task since the last call, oldest first; each is returned once. */
  takeSteers(): string[]
}
export type Handler = (params: unknown, ctx: HandlerContext) => Promise<unknown>

export function createAgent(
  port: ParentPortLike,
  handlers: Partial<Record<AgentMethod, Handler>>,
  hooks: { onShutdown?: () => Promise<void> } = {},
) {
  let init: AgentInit | undefined
  const running = new Map<string, AbortController>()
  const waiting = new Map<string, (reply: Reply) => void>()
  const steers: string[] = []
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
    if (message.type === 'reply') {
      const { type: _type, id, ...reply } = message
      waiting.get(id)?.(reply)
      return
    }
    if (message.type === 'steer') {
      if (steers.length < 20) steers.push(message.text)
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
      const signal = controller.signal
      const value = await handler(message.params, {
        init,
        signal,
        emit: (name, eventData) => port.postMessage({ type: 'event', name, data: eventData }),
        takeSteers: () => steers.splice(0),
        waitReply: (id, timeoutMs) =>
          new Promise<Reply | undefined>((resolve) => {
            const done = (reply?: Reply) => {
              waiting.delete(id)
              clearTimeout(timer)
              signal.removeEventListener('abort', cancel)
              resolve(reply)
            }
            const cancel = () => done()
            const timer = setTimeout(cancel, timeoutMs)
            signal.addEventListener('abort', cancel, { once: true })
            waiting.set(id, done)
          }),
      })
      port.postMessage({ type: 'result', id: message.id, value })
    } catch (error) {
      port.postMessage({ type: 'failure', id: message.id, error: error instanceof Error ? error.message : String(error) })
    } finally {
      running.delete(message.id)
    }
  })
}
