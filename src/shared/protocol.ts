import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const

export const AgentMethod = z.enum(['ping', 'permissions.check', 'cua.call', 'spike.a', 'spike.b.capture'])
export type AgentMethod = z.infer<typeof AgentMethod>

export const AgentInit = z.object({
  type: z.literal('init'),
  version: z.literal(PROTOCOL_VERSION),
  cuaSdkPath: z.string().min(1),
  cuaLibraryPath: z.string().min(1),
  nativeHelperPath: z.string().min(1),
  evidenceDir: z.string().min(1),
})
export type AgentInit = z.infer<typeof AgentInit>

export const HostToAgent = z.discriminatedUnion('type', [
  AgentInit,
  z.object({ type: z.literal('request'), id: z.string().min(1), method: AgentMethod, params: z.unknown() }),
  z.object({ type: z.literal('cancel'), id: z.string().min(1) }),
  z.object({ type: z.literal('shutdown') }),
])
export type HostToAgent = z.infer<typeof HostToAgent>

export const AgentToHost = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('result'), id: z.string(), value: z.unknown() }),
  z.object({ type: z.literal('failure'), id: z.string(), error: z.string() }),
  z.object({ type: z.literal('event'), name: z.string(), data: z.unknown() }),
  z.object({ type: z.literal('shutdown-complete') }),
])
export type AgentToHost = z.infer<typeof AgentToHost>
