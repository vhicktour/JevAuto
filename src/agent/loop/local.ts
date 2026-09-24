import { resolve } from 'node:path'
import { loadStagedCua, MacDriver } from '../mac/cua'
import { openAIAdapter } from '../providers/openai/adapter'
import { readFocus, readFrontmost } from '../../shared/native'
import { INSTRUCTIONS } from './instructions'

/** What a run from this checkout needs (the `pnpm agent` CLI and the desktop evals): Cua, JevNative, a model. */
export async function localRuntime(root: string) {
  const cua = await loadStagedCua(resolve(root, 'resources/cua-sdk/cua-sdk.mjs'), resolve(root, 'resources/cua-sdk/native/libcua_driver_sdk.dylib'))
  const helper = resolve(root, 'native/build/JevNative')
  return {
    driver: MacDriver.open(cua),
    focus: (pid: number) => readFocus(helper, pid).catch(() => 'unknown' as const),
    frontmost: () => readFrontmost(helper).catch(() => undefined),
    adapter: (model: string) => openAIAdapter(model, INSTRUCTIONS),
  }
}
