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
  'permissions.check': async (_params, ctx) => {
    const mac = await macDriver(ctx.init)
    const permissions = await mac.call('check_permissions', { prompt: false })
    // A real capture attempt is what makes macOS list JevAuto under Screen Recording (critic M13).
    const capture = await mac.call('get_desktop_state', {})
    const s = (permissions.structured ?? {}) as { accessibility?: boolean; screen_recording?: boolean; source?: unknown }
    return {
      accessibility: s.accessibility === true,
      screenRecording: s.screen_recording === true,
      source: s.source ?? null,
      captureOk: !capture.isError && capture.imageCount > 0,
      captureError: capture.isError ? capture.text.slice(0, 300) : null,
    }
  },
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
