import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { MODELS, type ModelId } from '../shared/models'

const ModelIds = MODELS.map((m) => m.id) as [ModelId, ...ModelId[]]
export const Settings = z.object({
  /** Watch mode: targets come to the front so you can see the cursor work. */
  watch: z.boolean(),
  model: z.enum(ModelIds),
  /** Apps JevAuto must never act in: names or bundle ids. */
  excluded: z.array(z.string().trim().min(1).max(200)).max(100),
})
export type Settings = z.infer<typeof Settings>

export const DEFAULT_SETTINGS: Settings = { watch: true, model: MODELS[0].id, excluded: [] }

/** settings.json in userData, readable only by you. A damaged file means defaults, never a crash. */
export class SettingsStore {
  private value: Settings
  private readonly file: string

  constructor(dir: string) {
    this.file = join(dir, 'settings.json')
    this.value = this.read()
  }

  get(): Settings {
    return structuredClone(this.value)
  }

  update(patch: Partial<Settings>): Settings {
    this.value = Settings.parse({ ...this.value, ...patch })
    writeFileSync(this.file, JSON.stringify(this.value, null, 2), { mode: 0o600 })
    chmodSync(this.file, 0o600)
    return this.get()
  }

  private read(): Settings {
    try {
      return Settings.parse(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return structuredClone(DEFAULT_SETTINGS)
    }
  }
}
