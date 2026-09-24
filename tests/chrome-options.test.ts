import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentChromeOptions, IGNORED_DEFAULT_ARGS, PLAYWRIGHT_DISABLED_FEATURES, launchAgentChrome, profileLockOwner, signInLaunchArgs } from '../src/agent/browser/chrome'

test('the agent Chrome always runs sandboxed on the installed Chrome with a real viewport', () => {
  const o = agentChromeOptions()
  assert.equal(o.chromiumSandbox, true)
  assert.equal(o.channel, 'chrome')
  assert.equal(o.viewport, null)
  assert.equal(o.headless, false)
})

test("Playwright's weakening defaults are stripped with an array, never true", () => {
  const o = agentChromeOptions()
  assert.ok(Array.isArray(o.ignoreDefaultArgs))
  for (const flag of ['--use-mock-keychain', '--password-store=basic', '--disable-client-side-phishing-detection', '--disable-component-update', '--disable-background-networking', '--disable-popup-blocking', '--unsafely-disable-devtools-self-xss-warnings', `--disable-features=${PLAYWRIGHT_DISABLED_FEATURES}`])
    assert.ok((IGNORED_DEFAULT_ARGS as readonly string[]).includes(flag), flag)
  assert.ok(!o.ignoreDefaultArgs.includes('--remote-debugging-pipe'))
})

test('the curated feature list keeps HTTPS upgrades, storage partitioning and redirect protection on', () => {
  const flag = agentChromeOptions().args.find((a) => a.startsWith('--disable-features='))!
  for (const kept of ['HttpsUpgrades', 'ThirdPartyStoragePartitioning', 'BlockOriginHeaderModificationOnRedirect']) assert.ok(!flag.includes(kept), kept)
})

test('the sign-in launch is a plain Chrome launch of the same profile', () => {
  const args = signInLaunchArgs('/tmp/profile', 'https://accounts.google.com')
  assert.deepEqual(args.slice(0, 3), ['-n', '-a', 'Google Chrome'])
  assert.ok(args.includes('--user-data-dir=/tmp/profile'))
  assert.ok(!args.some((a) => /automation|remote-debugging/.test(a)))
})

test('a live profile lock is reported; a missing or dead one is not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevauto-lock-'))
  assert.equal(await profileLockOwner(dir), null)
  await symlink(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'))
  assert.equal(await profileLockOwner(dir), process.pid)
  await rm(join(dir, 'SingletonLock'))
  await symlink(`${hostname()}-999999`, join(dir, 'SingletonLock')) // macOS pids stop at 99998
  assert.equal(await profileLockOwner(dir), null)
  await rm(dir, { recursive: true })
})

test('launching on a held profile fails fast with "in use"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevauto-lock-'))
  await symlink(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'))
  const started = performance.now()
  await assert.rejects(launchAgentChrome(dir), /in use by another Chrome/)
  assert.ok(performance.now() - started < 1000)
  await rm(dir, { recursive: true })
})
