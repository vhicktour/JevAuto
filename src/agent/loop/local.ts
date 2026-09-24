import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadStagedCua, MacDriver } from '../mac/cua'
import { adapterFor } from '../providers'
import { readFocus, readFrontmost } from '../../shared/native'
import { RoutingMac } from '../browser/routing'
import { WebDriver } from '../browser/web'
import { INSTRUCTIONS } from './instructions'

/** The browser profile the dev app uses too, so sign-ins carry over (one of them at a time: Chrome locks it). */
export const DEV_BROWSER_PROFILE = join(homedir(), 'Library/Application Support/JevAuto Dev/browser-profile')

/** What a run from this checkout needs (the `pnpm agent` CLI and the evals): Cua and the agent Chrome behind one driver, JevNative, a model. */
export async function localRuntime(root: string, browserProfile = DEV_BROWSER_PROFILE) {
  const cua = await loadStagedCua(resolve(root, 'resources/cua-sdk/cua-sdk.mjs'), resolve(root, 'resources/cua-sdk/native/libcua_driver_sdk.dylib'))
  const helper = resolve(root, 'native/build/JevNative')
  const driver = MacDriver.open(cua)
  const web = new WebDriver(browserProfile)
  return {
    mac: new RoutingMac(driver, web),
    web,
    focus: (pid: number, windowId: number) => (web.isWeb(windowId) ? web.focus(windowId) : readFocus(helper, pid)).catch(() => 'unknown' as const),
    frontmost: () => readFrontmost(helper).catch(() => undefined),
    adapter: (model: string) => adapterFor(model, INSTRUCTIONS, { openai: process.env.OPENAI_API_KEY, google: process.env.GEMINI_API_KEY }),
    close: async () => {
      await web.close()
      await driver.close()
    },
  }
}
