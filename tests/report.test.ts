import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReport, percentile, scrub, writeReport } from '../src/shared/report'

test('scrub drops image payloads and long strings, keeps sizes, and survives bigint', () => {
  const out = scrub({ images: [{ dataBase64: 'x'.repeat(10) }], dataBase64: 'abc', text: 'y'.repeat(5000), id: 7n, ok: true }) as Record<string, unknown>
  assert.equal(out.images, '[omitted 1 image]')
  assert.equal(out.dataBase64, '[omitted]')
  assert.match(out.text as string, /^y{2000}… \[5000 chars\]$/)
  assert.equal(out.id, '7')
  assert.equal(out.ok, true)
})

test('finish counts passed, failed and observed checks', () => {
  const r = createReport('a', 'open')
  r.add({ name: 'one', pass: true })
  r.add({ name: 'two', pass: false })
  r.add({ name: 'three', pass: null })
  const report = r.finish({ extra: 1 })
  assert.deepEqual({ ...report.summary }, { passed: 1, failed: 1, observed: 1, extra: 1 })
  assert.equal(report.label, 'open')
})

test('writeReport writes scrubbed JSON named after the spike', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevauto-report-'))
  const r = createReport('skeleton')
  r.add({ name: 'shot', pass: true, details: { images: [{ dataBase64: 'AAAA' }] } })
  const file = await writeReport(dir, r.finish())
  assert.match(file, /skeleton-.*\.json$/)
  assert.ok(!readFileSync(file, 'utf8').includes('AAAA'))
})

test('percentile uses nearest rank', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3)
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5)
  assert.equal(percentile([], 50), 0)
})
