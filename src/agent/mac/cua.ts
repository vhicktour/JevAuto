import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type * as Sdk from '@trycua/cua-driver'
import type * as SdkElectron from '@trycua/cua-driver/electron'
import { jsonSafe } from './results'
import { CUA_LIBRARY_ENV } from '../../shared/constants'

/** Only what `scripts/prepare-cua.ts` re-exports from the staged bundle. */
export type StagedCua = Pick<typeof Sdk, 'CuaDriver' | 'DriverOptions' | 'SdkClientKind'> & typeof SdkElectron

/** Loads the staged, re-signed SDK. The env var makes the patched resolver dlopen our copy, never a path inside app.asar. */
export async function loadStagedCua(bundle: string, library: string): Promise<StagedCua> {
  for (const [what, path] of [['SDK bundle', bundle], ['native library', library]] as const)
    if (!existsSync(path)) throw new Error(`Cua ${what} is missing at ${path}. Run pnpm prepare:cua.`)
  process.env[CUA_LIBRARY_ENV] = library
  return (await import(pathToFileURL(bundle).href)) as StagedCua
}

export type CuaResult = {
  text: string
  imageCount: number
  images: { mimeType: string; dataBase64: string }[]
  structured: unknown
  isError: boolean
  errorCode?: string
  action?: unknown
  durationMs: number
}

export class MacDriver {
  private driver: Sdk.CuaDriverLike

  private constructor(private readonly cua: StagedCua) {
    this.driver = MacDriver.create(cua)
  }

  static open(cua: StagedCua): MacDriver {
    return new MacDriver(cua)
  }

  private static create(cua: StagedCua): Sdk.CuaDriverLike {
    return cua.CuaDriver.create(cua.DriverOptions.new({ claudeCodeCompatibility: false }))
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    const started = performance.now()
    let result = await this.driver.callTool(name, JSON.stringify(args), signal ? { signal } : undefined)
    // Cua ends its implicit session after five idle minutes, then refuses every call ("this session has ended").
    // Nothing ran, so open a fresh driver session and ask once more.
    if (result.isError && (result.errorCode === 'session_ended' || /this session has ended/.test(result.text))) {
      const expired = this.driver
      this.driver = MacDriver.create(this.cua)
      void expired.shutdown().catch(() => undefined)
      result = await this.driver.callTool(name, JSON.stringify(args), signal ? { signal } : undefined)
    }
    let structured: unknown = undefined
    try {
      structured = result.structuredJson ? JSON.parse(result.structuredJson) : JSON.parse(result.rawJson)
    } catch {
      structured = result.rawJson
    }
    return {
      text: result.text,
      imageCount: result.images.length,
      images: result.images.map((i) => ({ mimeType: i.mimeType, dataBase64: i.dataBase64 })),
      structured,
      isError: result.isError,
      errorCode: result.errorCode,
      action: result.action === undefined ? undefined : jsonSafe(result.action),
      durationMs: Math.round(performance.now() - started),
    }
  }

  async close(): Promise<void> {
    await this.driver.shutdown()
    ;(this.driver as { uniffiDestroy?: () => void }).uniffiDestroy?.()
  }
}
