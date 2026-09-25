import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore, DEFAULT_SETTINGS } from '../src/main/settings'
import { KeyStore, type Crypter } from '../src/main/secrets'

const dir = () => mkdtempSync(join(tmpdir(), 'jevauto-settings-'))

test('settings start from defaults, save what you change, and survive a restart', () => {
  const d = dir()
  const a = new SettingsStore(d)
  assert.deepEqual(a.get(), DEFAULT_SETTINGS)
  a.update({ watch: false, model: 'gemini-3.8-flash', excluded: ['Slack', ' com.apple.mail '] })
  assert.deepEqual(new SettingsStore(d).get(), { watch: false, model: 'gemini-3.8-flash', excluded: ['Slack', 'com.apple.mail'], speed: 'balanced', auto: false, trusted: [] })
  assert.equal(statSync(join(d, 'settings.json')).mode & 0o777, 0o600)
})

test('the cursor speed is saved; a settings file from before it existed keeps its values', () => {
  const d = dir()
  writeFileSync(join(d, 'settings.json'), JSON.stringify({ watch: false, model: 'gemini-3.8-flash', excluded: ['Slack'] }))
  const s = new SettingsStore(d)
  assert.deepEqual(s.get(), { watch: false, model: 'gemini-3.8-flash', excluded: ['Slack'], speed: 'balanced', auto: false, trusted: [] })
  s.update({ speed: 'teach' })
  assert.equal(new SettingsStore(d).get().speed, 'teach')
  assert.throws(() => s.update({ speed: 'warp' as never }))
})

test('apps you always allow are kept until you remove them', () => {
  const d = dir()
  new SettingsStore(d).update({ trusted: [{ id: 'com.apple.TextEdit', app: 'TextEdit' }] })
  assert.deepEqual(new SettingsStore(d).get().trusted, [{ id: 'com.apple.TextEdit', app: 'TextEdit' }])
})

test('a broken or tampered settings file falls back to defaults instead of crashing', () => {
  const d = dir()
  writeFileSync(join(d, 'settings.json'), '{"watch": "yes", "model": 5')
  assert.deepEqual(new SettingsStore(d).get(), DEFAULT_SETTINGS)
  writeFileSync(join(d, 'settings.json'), JSON.stringify({ watch: true, model: 'gpt-6-sol', excluded: Array(500).fill('x') }))
  assert.deepEqual(new SettingsStore(d).get(), DEFAULT_SETTINGS)
})

// Stands in for Electron's safeStorage (the Keychain-backed key): reversible, and visibly not plain text on disk.
const crypter: Crypter = {
  available: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s).toString('base64').split('').reverse().join('')),
  decrypt: (b) => Buffer.from(b.toString().split('').reverse().join(''), 'base64').toString(),
}

test('keys are stored encrypted, reported only as set or not set, and cleared with an empty value', () => {
  const d = dir()
  const keys = new KeyStore(d, crypter)
  keys.set('openai', 'sk-live-secret')
  keys.set('google', 'g-secret')
  assert.deepEqual(keys.status(), { openai: true, anthropic: false, anthropicWorkspace: false, google: true, typesafe: false })
  assert.equal(readFileSync(join(d, 'keys.bin'), 'utf8').includes('sk-live-secret'), false)
  assert.equal(statSync(join(d, 'keys.bin')).mode & 0o777, 0o600)
  assert.deepEqual(new KeyStore(d, crypter).all(), { openai: 'sk-live-secret', google: 'g-secret' })
  keys.set('google', '')
  assert.deepEqual(new KeyStore(d, crypter).all(), { openai: 'sk-live-secret' })
})

test('without the Keychain nothing is written in the clear', () => {
  const keys = new KeyStore(dir(), { ...crypter, available: () => false })
  assert.throws(() => keys.set('openai', 'sk-x'), /Keychain/)
})

test('Full auto is off until you turn it on, and stays as you left it', () => {
  const d = dir()
  assert.equal(new SettingsStore(d).get().auto, false)
  new SettingsStore(d).update({ auto: true })
  assert.equal(new SettingsStore(d).get().auto, true)
})
