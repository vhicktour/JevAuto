import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { MODELS, type ModelId } from '../shared/models'
import { SPEEDS } from '../shared/motion'

const ModelIds = MODELS.map((m) => m.id) as [ModelId, ...ModelId[]]
export const Settings = z.object({
  /** Watch mode: targets come to the front so you can see the cursor work. */
  watch: z.boolean(),
  model: z.enum(ModelIds),
  /** Apps JevAuto must never act in: names or bundle ids. */
  excluded: z.array(z.string().trim().min(1).max(200)).max(100),
  /** How the cursor moves; files saved before this setting existed get the default. */
  speed: z.enum(SPEEDS).default('balanced'),
  /** Full auto: JevAuto answers its own questions (sends, submits, bringing apps forward). Off until you turn it on. */
  auto: z.boolean().default(false),
  /** Let Claude Code drive JevAuto over MCP (a socket only you can open). Off until you turn it on. */
  mcp: z.boolean().default(false),
  /** Apps you answered "Always" for: they come forward for shortcuts without asking. `id` is the bundle id or name. */
  trusted: z.array(z.object({ id: z.string().min(1).max(300), app: z.string().min(1).max(200) })).max(100).default([]),
})
export type Settings = z.infer<typeof Settings>

export const DEFAULT_SETTINGS: Settings = { watch: true, model: MODELS[0].id, excluded: [], speed: 'balanced', auto: false, mcp: false, trusted: [] }

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
