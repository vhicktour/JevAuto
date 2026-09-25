import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Updates, type UpdateState } from '../src/main/updates'

/** Stands in for electron-updater's autoUpdater: events, a check that can be counted, and quitAndInstall. */
function fakeUpdater() {
  const u = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checks: 0,
    installs: 0,
    checkForUpdates: async () => void u.checks++,
    quitAndInstall: () => void u.installs++,
  })
  return u
}

test('a release build checks at start, downloads in the background, and installs only when you ask', () => {
  const updater = fakeUpdater()
  const seen: UpdateState[] = []
  const updates = new Updates({ packaged: true, name: 'JevAuto', updater: () => updater, onChange: (s) => seen.push(s), log: () => {} })
  updates.start()
  assert.equal(updater.checks, 1)
  assert.equal(updater.autoDownload, true)
  assert.equal(updates.install(), false, 'nothing is ready yet')
  updater.emit('update-available', { version: '0.2.0' })
  updater.emit('update-downloaded', { version: '0.2.0' })
  assert.deepEqual(seen.at(-1), { status: 'ready', version: '0.2.0' })
  assert.equal(updater.installs, 0, 'never installs by itself while the app runs')
  assert.equal(updates.install(), true)
  assert.equal(updater.installs, 1)
  updates.stop()
})

test('dev bundles and unpackaged runs never check; a failed check is reported, not thrown', () => {
  for (const [packaged, name] of [[true, 'JevAuto Dev'], [false, 'JevAuto']] as const) {
    const updater = fakeUpdater()
    let created = false
    const updates = new Updates({ packaged, name, updater: () => ((created = true), updater), onChange: () => {}, log: () => {} })
    updates.start()
    assert.equal(updater.checks, 0, `${name} packaged=${packaged}`)
    assert.equal(created, false, 'the updater is never even created')
    assert.equal(updates.current.status, 'off')
  }
  const updater = fakeUpdater()
  const lines: string[] = []
  const updates = new Updates({ packaged: true, name: 'JevAuto', updater: () => updater, onChange: () => {}, log: (l) => void lines.push(l) })
  updates.start()
  updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
  assert.equal(updates.current.status, 'error')
  assert.match(lines.join(' '), /ERR_INTERNET_DISCONNECTED/)
  updates.stop()
})
