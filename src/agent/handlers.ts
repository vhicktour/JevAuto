import { z } from 'zod'
import type { Handler } from './agent'
import type { AgentMethod } from '../shared/protocol'
import { loadStagedCua, MacDriver } from './mac/cua'

let mac: MacDriver | undefined
export async function macDriver(init: { cuaSdkPath: string; cuaLibraryPath: string }): Promise<MacDriver> {
  if (!mac) mac = MacDriver.open(await loadStagedCua(init.cuaSdkPath, init.cuaLibraryPath))
  return mac
}

const CuaCall = z.object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) })

export const handlers: Partial<Record<AgentMethod, Handler>> = {
  ping: async () => ({ pong: true, pid: process.pid }),
  'cua.call': async (params, ctx) => {
    const { name, args } = CuaCall.parse(params)
    const result = await (await macDriver(ctx.init)).call(name, args, ctx.signal)
    return { ...result, images: [] } // screenshots stay in the agent
  },
}

export async function shutdown(): Promise<void> {
  await mac?.close()
  mac = undefined
}
