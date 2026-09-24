import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The shadow report (spec §6): how often Jev's pick matched the frontier model's first action on a web page, overall
 * and above confidence thresholds. The fast path may act only after this shows high precision on real coverage.
 */
const dir = resolve(import.meta.dirname, '../evidence/runs')
type Row = { agree: boolean; confidence: number; ms: number }
const rows: Row[] = []
for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')))
  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    if (!line.includes('"jev_shadow"')) continue
    const e = JSON.parse(line) as { agree: boolean; jev: { confidence: number; ms: number } }
    rows.push({ agree: e.agree, confidence: e.jev.confidence, ms: e.jev.ms })
  }
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a')
console.log(`${rows.length} compared web steps · agreement ${pct(rows.filter((r) => r.agree).length, rows.length)} · median ${rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0} ms`)
for (const t of [0.5, 0.7, 0.9]) {
  const kept = rows.filter((r) => r.confidence >= t)
  console.log(`confidence ≥ ${t}: coverage ${pct(kept.length, rows.length)}, agreement ${pct(kept.filter((r) => r.agree).length, kept.length)}`)
}
