import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

const PER_APP = 12
const MAX_TIP = 300
// A tip describes how an app works. Links, addresses and long numbers are what a planted tip would need to steer a
// later run somewhere (a web page can try to get the model to save one), so they are never kept.
const STEERING = /(https?:\/\/|www\.|\b[\w.+-]+@[\w-]+\.[\w.]+\b|\d{6,})/i

const File = z.object({ apps: z.record(z.string(), z.array(z.object({ tip: z.string(), at: z.string() }))) })
type Stored = z.infer<typeof File>

/**
 * What JevAuto learned about apps and sites (Victor: "self improve every time you hit a wall"): short tips a brain saves
 * after getting past a problem, shown again the next time that app is the target. Kept in lessons.json (0600); you can
 * read and delete them in Settings.
 */
export class Lessons {
  private data: Stored

  constructor(private readonly file: string) {
    this.data = this.read()
  }

  /** Tips for an app (any capitalisation), newest first. */
  for(app: string): string[] {
    return this.tipsOf(key(app)).map((t) => t.tip)
  }

  all(): { app: string; tips: string[] }[] {
    return Object.entries(this.data.apps).map(([app, tips]) => ({ app, tips: tips.map((t) => t.tip) }))
  }

  add(app: string, tip: string): { ok: true; repeat?: true } | { ok: false; error: string } {
    const text = tip.trim().replace(/\s+/g, ' ')
    const name = key(app)
    if (!name || !text || RESERVED.has(name)) return { ok: false, error: 'A tip needs an app and some text.' }
    if (text.length > MAX_TIP) return { ok: false, error: `Keep a tip under ${MAX_TIP} characters.` }
    if (STEERING.test(text)) return { ok: false, error: 'A tip describes how the app works; links, addresses and long numbers are not kept.' }
    const tips = this.tipsOf(name)
    if (tips.some((t) => t.tip.toLowerCase() === text.toLowerCase())) return { ok: true, repeat: true }
    this.data.apps[name] = [{ tip: text, at: new Date().toISOString() }, ...tips].slice(0, PER_APP)
    this.write()
    return { ok: true }
  }

  remove(app: string, tip: string): boolean {
    const tips = this.tipsOf(key(app))
    if (!tips.length) return false
    const kept = tips.filter((t) => t.tip !== tip)
    if (kept.length === tips.length) return false
    this.data.apps[key(app)] = kept
    this.write()
    return true
  }

  /** Own keys only: an app called "__proto__" or "constructor" is just an app with no tips. */
  private tipsOf(name: string) {
    return Object.hasOwn(this.data.apps, name) ? this.data.apps[name] : []
  }

  private read(): Stored {
    try {
      return File.parse(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return { apps: {} }
    }
  }

  private write() {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    chmodSync(this.file, 0o600)
  }
}

const key = (app: string) => app.trim().toLowerCase().slice(0, 100)
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
