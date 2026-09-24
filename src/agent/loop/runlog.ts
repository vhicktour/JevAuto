import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/** One append-only JSONL file per run, readable only by you (spec §8). Never holds screenshots or keys. */
export class RunLog {
  private fd: number | undefined

  private constructor(readonly path: string) {
    this.fd = openSync(path, 'a', 0o600)
  }

  static open(dir: string, runId: string): RunLog {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return new RunLog(join(dir, `${runId}.jsonl`))
  }

  /** Synchronous, so a Stop that ends the process right after still leaves the line on disk. */
  write(event: string, data: Record<string, unknown> = {}) {
    if (this.fd === undefined) return
    writeSync(this.fd, `${JSON.stringify({ t: new Date().toISOString(), event, ...data })}\n`)
  }

  close() {
    if (this.fd !== undefined) closeSync(this.fd)
    this.fd = undefined
  }
}
