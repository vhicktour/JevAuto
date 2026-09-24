import { readFile, mkdtemp, cp, rm } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { launchAgentChrome, signInLaunchArgs } from '../../src/agent/browser/chrome'
import { buildJevRequest, offeredTargets, type SnapshotResult } from '../../src/agent/jev/questions'
import { jevClient } from '../../src/agent/jev/client'
import { readFrontmost } from '../../src/shared/native'
import { createReport, writeReport, percentile } from '../../src/shared/report'
import { startFixtureServer } from '../fixtures/server'

const root = resolve(import.meta.dirname, '../..')
const helper = join(root, 'native/build/JevNative')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Chrome processes started on this profile; the browser process is the one without --type=. */
function chromeProcesses(profile: string) {
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(`--user-data-dir=${profile}`))
    .map((line) => {
      const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? []
      return { pid: Number(pid), command: command ?? '', browser: !command?.includes('--type=') }
    })
}

async function waitFor(check: () => boolean, ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await sleep(250)
  }
  return false
}

/** The same window size on every run, so snapshots see the same viewport. */
async function sizeWindow(page: Page, width = 1440, height = 900) {
  const cdp = await page.context().newCDPSession(page)
  const { windowId } = await cdp.send('Browser.getWindowForTarget')
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width, height, windowState: 'normal' } })
  await cdp.detach()
}

const report = createReport('d')
const server = await startFixtureServer()
const snapshotSource = await readFile(join(root, 'src/agent/browser/snapshot.upstream.js'), 'utf8')
const profile = await mkdtemp(join(tmpdir(), 'jevauto-agent-profile-'))
const control = await mkdtemp(join(tmpdir(), 'jevauto-control-profile-'))

// Your everyday Chrome runs first, so the link-routing check sees two Chrome instances.
spawnSync('open', ['-g', '-a', 'Google Chrome'])
await sleep(2000)

// Keychain round trip: set a cookie in a plain launch, quit cleanly (SIGTERM flushes cookies), read it from the automated launch.
spawnSync('open', signInLaunchArgs(profile, `http://127.0.0.1:${server.port}/set-cookie`))
const cookieSet = await waitFor(() => server.hits.includes('/set-cookie'), 20_000)
await sleep(2000)
for (const p of chromeProcesses(profile).filter((p) => p.browser)) process.kill(p.pid, 'SIGTERM')
const plainQuit = await waitFor(() => chromeProcesses(profile).length === 0, 15_000)
await cp(profile, control, { recursive: true })

const ctx = await launchAgentChrome(profile)
const page = ctx.pages()[0] ?? (await ctx.newPage())
await sizeWindow(page)
await page.goto(`http://127.0.0.1:${server.port}/get-cookie`)
const body = (await page.textContent('body')) ?? ''
report.add({ name: 'a cookie set in the plain launch survives into the automated launch', pass: cookieSet && plainQuit && body.includes('jev=1'), details: { cookieSet, plainQuit, body } })

// Control: Playwright's defaults (mock keychain) on a copy of the same profile.
const defaults = await chromium.launchPersistentContext(control, { channel: 'chrome', headless: false, chromiumSandbox: true })
const controlPage = defaults.pages()[0] ?? (await defaults.newPage())
await controlPage.goto(`http://127.0.0.1:${server.port}/get-cookie`)
report.add({ name: 'control: Playwright defaults on a copy of the profile', pass: null, details: { body: await controlPage.textContent('body') } })
await defaults.close()

// Process flags: sandbox on, weakening defaults gone, the curated feature list in effect.
const processes = chromeProcesses(profile)
const browserCommand = processes.find((p) => p.browser)?.command ?? ''
const features = [...browserCommand.matchAll(/--disable-features=(\S+)/g)].map((m) => m[1])
report.add({
  name: 'agent Chrome runs sandboxed without the weakening flags',
  pass: Boolean(browserCommand) && !/--no-sandbox|--use-mock-keychain|--password-store=basic/.test(browserCommand) && !features.some((f) => /HttpsUpgrades|ThirdPartyStoragePartitioning/.test(f)),
  details: { disableFeatures: features },
})
const renderers = processes.filter((p) => p.command.includes('--type=renderer'))
await page.goto('chrome://sandbox').catch(() => {})
report.add({
  name: 'sandbox evidence: renderer seatbelt flags and chrome://sandbox',
  pass: null,
  details: { renderers: renderers.length, withSeatbelt: renderers.filter((p) => p.command.includes('--seatbelt-client=')).length, sandboxPage: ((await page.textContent('body').catch(() => '')) ?? '').slice(0, 600) },
})

// Focus: CDP clicks must not pull the agent Chrome in front of your app.
await page.goto(`http://127.0.0.1:${server.port}/button`)
spawnSync('open', ['-a', 'TextEdit'])
await sleep(1500)
const before = await readFrontmost(helper)
let stolen = 0
for (let i = 0; i < 10; i++) {
  await page.mouse.click(140, 110)
  await sleep(300)
  if ((await readFrontmost(helper)).bundleId !== before.bundleId) stolen++
}
report.add({ name: 'CDP clicks never take focus from your app', pass: before.bundleId === 'com.apple.TextEdit' && stolen === 0, details: { frontmost: before.bundleId, stolen } })

// Link routing: a link another app opens in Chrome must not land in the agent Chrome.
spawnSync('open', ['-a', 'Google Chrome', `http://127.0.0.1:${server.port}/routing-probe`])
await sleep(3000)
report.add({
  name: 'a link opened from another app stays out of the agent Chrome',
  pass: !ctx.pages().some((p) => p.url().includes('/routing-probe')),
  details: { served: server.hits.includes('/routing-probe') },
})

// Snapshot in every frame, including a cross-site iframe.
await page.goto(`http://127.0.0.1:${server.port}/frames`)
await sleep(1000)
const perFrame: Array<{ url: string; actions?: number; error?: string }> = []
for (const frame of page.frames()) {
  try {
    perFrame.push({ url: frame.url(), actions: ((await frame.evaluate(snapshotSource)) as SnapshotResult).actions.length })
  } catch (error) {
    perFrame.push({ url: frame.url(), error: String(error) })
  }
}
report.add({ name: 'snapshot runs inside the cross-site iframe', pass: perFrame.some((f) => f.url.includes('[::1]') && (f.actions ?? 0) > 0), details: perFrame })

// A second launch on the held profile fails fast instead of hanging.
const lockStarted = performance.now()
const second = await launchAgentChrome(profile).then(
  async (c) => {
    await c.close()
    return 'launched'
  },
  (e: Error) => e.message,
)
const lockMs = Math.round(performance.now() - lockStarted)
report.add({ name: 'a second launch on the held profile fails fast', pass: /in use/.test(second) && lockMs < 15_000, details: { second, ms: lockMs } })

// Jev against hand labels, in shadow: nothing is clicked. A label whose target is not on screen is a bad label, not a Jev miss.
const labels = JSON.parse(await readFile(join(root, 'evals/jev-labels.json'), 'utf8')) as Array<{ url: string; goal: string; match: string }>
const jev = jevClient()
type Result = { goal: string; correct: boolean; operation: string; chosen: string | null; confidence: number; ms: number }
const results: Result[] = []
const invalid: Array<{ goal: string; reason: string; offered?: string[] }> = []
for (const c of labels) {
  const tab = await ctx.newPage()
  try {
    await sizeWindow(tab)
    await tab.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await sleep(1500)
    const snap = (await tab.evaluate(snapshotSource)) as SnapshotResult
    const expected = new RegExp(c.match, 'i')
    const offered = offeredTargets(snap)
    if (!offered.some((a) => expected.test(a.label))) {
      invalid.push({ goal: c.goal, reason: 'target not offered', offered: offered.slice(0, 40).map((a) => a.label) })
      continue
    }
    const started = performance.now()
    const { answers } = await jev.systemOne(buildJevRequest(c.goal, snap))
    const chosen = offered.find((a) => String(a.node) === answers.click_target.choice)
    results.push({
      goal: c.goal,
      correct: answers.operation.choice === 'CLICK' && Boolean(chosen && expected.test(chosen.label)),
      operation: answers.operation.choice,
      chosen: chosen?.label ?? null,
      confidence: answers.click_target.confidence,
      ms: Math.round(performance.now() - started),
    })
  } catch (error) {
    invalid.push({ goal: c.goal, reason: String(error) })
  } finally {
    await tab.close()
  }
}
const calibration = [0, 0.5, 0.7, 0.9].map((threshold) => {
  const kept = results.filter((r) => r.confidence >= threshold)
  return { threshold, coverage: results.length ? kept.length / results.length : 0, precision: kept.length ? kept.filter((r) => r.correct).length / kept.length : null }
})
report.add({
  name: 'Jev on hand-labelled steps (shadow)',
  pass: null,
  details: {
    scored: results.length,
    precision: results.length ? results.filter((r) => r.correct).length / results.length : null,
    latencyP50: percentile(results.map((r) => r.ms), 50),
    latencyP95: percentile(results.map((r) => r.ms), 95),
    calibration,
    invalid,
    results,
  },
})

await ctx.close()
await server.close()
await Promise.all([profile, control].map((dir) => rm(dir, { recursive: true, force: true })))
console.log(await writeReport(join(root, 'evidence'), report.finish()))
