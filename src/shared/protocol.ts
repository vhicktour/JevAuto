import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const

export const AgentMethod = z.enum(['ping', 'permissions.check', 'cua.call', 'agent.run', 'spike.a', 'spike.b.capture', 'spike.demo', 'spike.stop.type'])
export type AgentMethod = z.infer<typeof AgentMethod>

export const AgentInit = z.object({
  type: z.literal('init'),
  version: z.literal(PROTOCOL_VERSION),
  cuaSdkPath: z.string().min(1),
  cuaLibraryPath: z.string().min(1),
  nativeHelperPath: z.string().min(1),
  evidenceDir: z.string().min(1),
  runsDir: z.string().min(1),
  /** Provider keys travel only in this message: never in the environment, argv, logs or a renderer (spec §8). */
  keys: z
    .object({ openai: z.string(), anthropic: z.string(), anthropicWorkspace: z.string(), google: z.string(), typesafe: z.string() })
    .partial()
    .optional(),
})
export type AgentInit = z.infer<typeof AgentInit>

/** Your answer to an approval (`answer`) or to a question the agent asked (`text`, null when skipped). */
export const Reply = z.object({ answer: z.enum(['once', 'run', 'deny']).optional(), text: z.string().max(4000).nullable().optional() })
export type Reply = z.infer<typeof Reply>

export const HostToAgent = z.discriminatedUnion('type', [
  AgentInit,
  z.object({ type: z.literal('request'), id: z.string().min(1), method: AgentMethod, params: z.unknown() }),
  z.object({ type: z.literal('cancel'), id: z.string().min(1) }),
  z.object({ type: z.literal('reply'), id: z.string().min(1) }).extend(Reply.shape),
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
