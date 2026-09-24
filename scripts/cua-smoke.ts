import { resolve } from 'node:path'
import { loadStagedCua, MacDriver } from '../src/agent/mac/cua'

const root = resolve(import.meta.dirname, '..')
const cua = await loadStagedCua(resolve(root, 'resources/cua-sdk/cua-sdk.mjs'), resolve(root, 'resources/cua-sdk/native/libcua_driver_sdk.dylib'))
const mac = MacDriver.open(cua)
const size = await mac.call('get_screen_size', {})
const permissions = await mac.call('check_permissions', { prompt: false })
console.log(JSON.stringify({ screen: size.structured, permissions: permissions.structured, ms: [size.durationMs, permissions.durationMs] }, null, 2))
await mac.close()
