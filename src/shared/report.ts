import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { arch, release } from 'node:os'

export type Check = { name: string; pass: boolean | null; durationMs?: number; details?: unknown }
export type SpikeReport = {
  spike: string
  label?: string
  startedAt: string
  finishedAt: string
  host: { darwin: string; arch: string }
  checks: Check[]
  summary: Record<string, unknown>
}

export function createReport(spike: string, label?: string) {
  const startedAt = new Date().toISOString()
  const checks: Check[] = []
  return {
    add(check: Check) {
      checks.push(check)
    },
    finish(summary: Record<string, unknown> = {}): SpikeReport {
      return {
        spike,
        label,
        startedAt,
        finishedAt: new Date().toISOString(),
        host: { darwin: release(), arch: arch() },
        checks,
        summary: {
          passed: checks.filter((c) => c.pass === true).length,
          failed: checks.filter((c) => c.pass === false).length,
          observed: checks.filter((c) => c.pass === null).length,
          ...summary,
        },
      }
    },
  }
}

/** Evidence never carries screenshots or long page text (spec §8 Data). */
export function scrub(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}… [${value.length} chars]` : value
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      if (key === 'images' && Array.isArray(v)) out[key] = `[omitted ${v.length} image${v.length === 1 ? '' : 's'}]`
      else if (key === 'dataBase64' || key === 'screenshot') out[key] = '[omitted]'
      else out[key] = scrub(v)
    }
    return out
  }
  return value
}

export async function writeReport(dir: string, report: SpikeReport): Promise<string> {
  await mkdir(dir, { recursive: true })
  const stamp = report.startedAt.replace(/[:.]/g, '-')
  const file = join(dir, `${report.spike}${report.label ? `-${report.label}` : ''}-${stamp}.json`)
  await writeFile(file, JSON.stringify(scrub(report), null, 2))
  return file
}

/** Nearest-rank percentile; 0 for an empty list. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}
