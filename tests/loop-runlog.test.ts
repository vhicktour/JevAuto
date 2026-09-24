import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunLog } from '../src/agent/loop/runlog'

test('a run log is JSONL, one event per line, readable only by you', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'jevauto-runlog-')), 'runs')
  const log = RunLog.open(dir, 'run-1')
  log.write('run.start', { task: 'x' })
  log.write('run.end', { status: 'success' })
  log.close()
  log.write('ignored', {})
  const lines = readFileSync(log.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => l.event), ['run.start', 'run.end'])
  assert.equal(statSync(log.path).mode & 0o777, 0o600)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
})
