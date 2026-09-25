// Checks a packaged JevAuto: signature, fuses, every surface loads, the agent comes up, and axe finds no accessibility
// violations. Writes screenshots and a JSON report to verification/ (git-ignored).
//   node scripts/verify-app.mjs                     launches dist/mac-arm64/JevAuto.app through LaunchServices, then quits it
//   node scripts/verify-app.mjs --app <path.app>    the same for another bundle
//   node scripts/verify-app.mjs --attach 9232       inspects a JevAuto already running with --remote-debugging-port=9232
import { chromium } from 'playwright-core'
import { AxeBuilder } from '@axe-core/playwright'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const attach = arg('--attach')
const app = resolve(arg('--app') ?? 'dist/mac-arm64/JevAuto.app')
const port = attach ?? '9239'
const out = resolve('verification')
mkdirSync(out, { recursive: true })
const report = { at: new Date().toISOString(), app: attach ? `attached on ${port}` : app, checks: [], axe: {} }
const check = (name, ok, detail = '') => {
  report.checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` · ${detail}` : ''}`)
}

if (!attach) {
  const sig = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
  check('signature verifies (deep, strict)', sig.status === 0, sig.stderr.trim().split('\n').at(-1))
  const fuses = createRequire(import.meta.url)('@electron/fuses')
  const exe = join(app, 'Contents/MacOS', basename(app, '.app'))
  const wire = await fuses.getCurrentFuseWire(exe)
  const on = (option) => String.fromCharCode(Number(wire[option])) === '1' || Number(wire[option]) === 1 || wire[option] === 49
  const O = fuses.FuseV1Options
  check('no other program can run code as JevAuto', !on(O.RunAsNode) && !on(O.EnableNodeOptionsEnvironmentVariable) && !on(O.EnableNodeCliInspectArguments))
  check('only the signed app.asar loads', on(O.EnableEmbeddedAsarIntegrityValidation) && on(O.OnlyLoadAppFromAsar))
  // LaunchServices, so macOS credits permissions to JevAuto and not to this terminal (spec §12 Phase 0E).
  execFileSync('open', ['-n', '-g', '-a', app, '--args', `--remote-debugging-port=${port}`, '--background'])
}

let browser
for (let i = 0; i < 60 && !browser; i++)
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  } catch {
    await new Promise((r) => setTimeout(r, 500))
  }
if (!browser) {
  check('the app answers on the debugging port', false, `port ${port}`)
  process.exit(1)
}
const surface = async (name) => {
  for (let i = 0; i < 40; i++) {
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes(`surface=${name}`))
    if (page) return page
    await new Promise((r) => setTimeout(r, 250))
  }
}
const pages = { activity: await surface('activity'), command: await surface('command'), island: await surface('island'), overlay: await surface('overlay') }
for (const [name, page] of Object.entries(pages)) check(`${name} surface loads`, Boolean(page))
const activity = pages.activity
if (activity) {
  await activity.waitForSelector('.state-pill', { timeout: 15_000 })
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) {
    const lines = await activity.evaluate(() => window.jevauto.command({ type: 'status' }))
    ready = lines.some((l) => /agent ready/.test(l))
    if (!ready) await activity.waitForTimeout(500)
  }
  check('the agent process is up', ready)
  // axe cannot see the native glass behind a see-through page and would measure against white; measure against the
  // opaque fallback instead (what Reduce Transparency shows), then put the glass back.
  const scan = async (name, page, include) => {
    const before = await page.evaluate(() => {
      const b = document.body.style.background
      document.body.style.background = '#0b1620'
      return b
    })
    const result = await new AxeBuilder({ page }).setLegacyMode(true).include(include).analyze() // Electron cannot open the helper page axe wants
    await page.evaluate((b) => (document.body.style.background = b), before)
    report.axe[name] = result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5) }))
    check(`axe: ${name}`, result.violations.length === 0, result.violations.map((v) => `${v.id} (${v.nodes.length})`).join(', '))
  }
  await scan('activity', activity, 'main')
  await activity.screenshot({ path: join(out, 'activity.png') })
  await activity.getByRole('button', { name: 'Settings' }).click()
  await activity.waitForSelector('.settings')
  await scan('settings', activity, 'main')
  await activity.screenshot({ path: join(out, 'settings.png') })
  await activity.getByRole('button', { name: 'Close settings' }).click()
  if (pages.command) await scan('command bar', pages.command, 'form')
}
writeFileSync(join(out, 'verify-app.json'), JSON.stringify(report, null, 2))
await browser.close()
if (!attach) spawnSync('osascript', ['-e', `quit app "${app}"`])
const failed = report.checks.filter((c) => !c.ok).length
console.log(failed ? `${failed} check(s) failed · verification/verify-app.json` : 'All checks passed · verification/verify-app.json')
process.exit(failed ? 1 : 0)
