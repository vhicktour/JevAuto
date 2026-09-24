import type { Handler } from './agent'
import type { AgentMethod } from '../shared/protocol'

export const handlers: Partial<Record<AgentMethod, Handler>> = {
  ping: async () => ({ pong: true, pid: process.pid }),
}

export async function shutdown(): Promise<void> {}
