import { AgentToHost, type AgentInit, type AgentMethod, type Reply } from '../shared/protocol'

export interface AgentChild {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}

export class AgentExitedError extends Error {
  constructor(code: number) {
    super(`The agent exited (code ${code}).`)
    this.name = 'AgentExitedError'
  }
}

export type SupervisorOptions = {
  maxRestarts: number
  windowMs: number
  backoffMs: number
  readyTimeoutMs: number
  now?: () => number
  onEvent?: (name: string, data: unknown) => void
  onGiveUp?: (reason: string) => void
}

type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }

export class Supervisor {
  private child?: AgentChild
  private pending = new Map<string, Pending>()
  private restarts: number[] = []
  private nextId = 1
  private stopping = false
  private killed?: AgentChild
  private onShutdownComplete?: () => void

  constructor(
    private readonly spawn: () => AgentChild,
    private readonly init: AgentInit,
    private readonly options: SupervisorOptions,
  ) {}

  start(): Promise<void> {
    const child = this.spawn()
    this.child = child
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The agent did not become ready in time.')), this.options.readyTimeoutMs)
      child.on('message', (raw) => {
        const parsed = AgentToHost.safeParse(raw)
        if (!parsed.success) return
        const message = parsed.data
        if (message.type === 'ready') {
          clearTimeout(timer)
          resolve()
        } else if (message.type === 'result' || message.type === 'failure') this.settle(message)
        else if (message.type === 'event') this.options.onEvent?.(message.name, message.data)
        else if (message.type === 'shutdown-complete') this.onShutdownComplete?.()
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new AgentExitedError(code))
        this.handleExit(child, code)
      })
    })
    child.postMessage(this.init)
    return ready
  }

  request<T = unknown>(method: AgentMethod, params: unknown, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const child = this.child
    if (!child) return Promise.reject(new Error('The agent is not running.'))
    const id = String(this.nextId++)
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve: resolve as (v: unknown) => void, reject }
      if (o.timeoutMs !== undefined)
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`The agent did not answer ${method} within ${o.timeoutMs} ms.`))
        }, o.timeoutMs)
      o.signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return
        clearTimeout(entry.timer)
        child.postMessage({ type: 'cancel', id })
        reject(new Error(`${method} was cancelled.`))
      }, { once: true })
      this.pending.set(id, entry)
      child.postMessage({ type: 'request', id, method, params })
    })
  }

  /** Your answer to an approval or question the agent is waiting on. */
  reply(id: string, reply: Reply): void {
    this.child?.postMessage({ type: 'reply', id, ...reply })
  }

  /** Something you tell the running task. */
  steer(text: string): void {
    this.child?.postMessage({ type: 'steer', text })
  }

  /** Stop's backstop (spec §8): the in-process driver dies with the agent. A deliberate kill restarts at once and never counts as a crash. */
  kill(): void {
    if (!this.child) return
    this.killed = this.child
    this.child.kill()
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (!child) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 5_000)
      this.onShutdownComplete = () => {
        clearTimeout(timer)
        resolve()
      }
      child.postMessage({ type: 'shutdown' })
    })
  }

  private settle(message: { type: 'result'; id: string; value: unknown } | { type: 'failure'; id: string; error: string }) {
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.type === 'result') entry.resolve(message.value)
    else entry.reject(new Error(message.error))
  }

  private handleExit(child: AgentChild, code: number) {
    if (child !== this.child) return // a late event from an older child
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new AgentExitedError(code))
    }
    this.pending.clear()
    this.child = undefined
    if (this.stopping) return
    if (this.killed === child) {
      this.killed = undefined
      void this.start().catch(() => {})
      return
    }
    const now = (this.options.now ?? Date.now)()
    this.restarts = this.restarts.filter((t) => now - t < this.options.windowMs)
    if (this.restarts.length >= this.options.maxRestarts) {
      this.options.onGiveUp?.(`The agent restarted ${this.restarts.length} times in ${this.options.windowMs} ms and was stopped.`)
      return
    }
    this.restarts.push(now)
    setTimeout(() => void this.start().catch(() => {}), this.options.backoffMs * 2 ** (this.restarts.length - 1))
  }
}
