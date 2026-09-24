import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PINS, APP_BUNDLE_ID, DEV_BUNDLE_ID, JEV_MODEL } from '../src/shared/constants'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const all: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }

test('package.json pins match the versions the code relies on', () => {
  assert.equal(all['electron'], PINS.electron)
  assert.equal(all['@trycua/cua-driver'], PINS.cuaDriver)
  assert.equal(all['playwright-core'], PINS.playwrightCore)
  assert.equal(all['@typesafe-ai/sdk'], PINS.typesafeSdk)
  assert.equal(all['@anthropic-ai/sdk'], PINS.anthropicSdk)
  assert.equal(all['openai'], PINS.openai)
  assert.equal(all['@google/genai'], PINS.googleGenai)
})

test('every dependency is an exact version', () => {
  for (const [name, version] of Object.entries(all)) assert.match(version, /^\d+\.\d+\.\d+$/, name)
})

test('identities are stable', () => {
  assert.equal(APP_BUNDLE_ID, 'personal.jevauto.desktop')
  assert.equal(DEV_BUNDLE_ID, 'personal.jevauto.desktop.dev')
  assert.equal(JEV_MODEL, 'jev-1.13.0')
})
