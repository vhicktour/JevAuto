import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { VisibleMac } from '../../src/agent/mac/visible'
import { localRuntime } from '../../src/agent/loop/local'
import { runTask, type Answer, type Approval } from '../../src/agent/loop/run'
import { RunLog } from '../../src/agent/loop/runlog'
import { createReport, writeReport } from '../../src/shared/report'
import { PHASE0_MODELS } from '../../src/shared/constants'
import { avoidBundles } from '../../scripts/agent-args'
import { TASKS, type DesktopTask } from './tasks'
import { startFixtureServer, type FixtureServer } from '../fixtures/server'

const root = resolve(import.meta.dirname, '../..')
const { values } = parseArgs({
  options: { repeat: { type: 'string', default: '3' }, only: { type: 'string' }, personal: { type: 'boolean', default: false }, model: { type: 'string' } },
})
const repeat = Number(values.repeat)
const model = values.model ?? PHASE0_MODELS.openai
const only = values.only?.split(',').map((s) => s.trim())
const tasks = TASKS.filter((t) => (only ? only.includes(t.id) : !t.personal || values.personal))
if (!tasks.length) throw new Error('No tasks selected.')
const skipped = TASKS.filter((t) => t.personal && !tasks.includes(t)).map((t) => t.id)

/** Unattended approvals: yes to routine steps and to brief foreground delivery; no to anything that sends, deletes or buys. */
function policy(task: DesktopTask, a: Approval): Answer {
  if (a.kind === 'budget') return 'deny'
  if (a.kind === 'foreground') return 'run'
  const text = `${a.title} ${a.reason}`
  if (task.deny?.test(text)) return 'deny'
  if (/send|delete|trash|erase|remove|pay|buy|purchase|publish|install|allow/i.test(a.title)) return 'deny'
  return 'once'
}

const controller = new AbortController()
process.on('SIGINT', () => {
  controller.abort()
  setTimeout(() => process.exit(130), 250).unref()
})

const { mac: routed, web, focus, frontmost, shadow, adapter, close } = await localRuntime(root, undefined, { allowPrivate: true })
const mac = new VisibleMac(routed, () => {})
const server: FixtureServer | undefined = tasks.some((t) => t.web) ? await startFixtureServer() : undefined
const site = server ? `http://127.0.0.1:${server.port}` : ''
const dir = join(homedir(), 'JevAutoSandbox', 'suite')
await mkdir(dir, { recursive: true })
const report = createReport('desktop', `${model} ×${repeat}`)
let usd = 0
console.log(`Desktop suite · ${model} · ${tasks.map((t) => t.id).join(', ')} × ${repeat}${skipped.length ? ` · skipped (personal data): ${skipped.join(', ')}` : ''}`)

for (let r = 1; r <= repeat; r++)
  for (const task of tasks) {
    const stamp = `${Date.now().toString(36)}`
    const ctx = { mac, dir, stamp, web, site }
    const name = `${task.id} #${r}`
    try {
      const data = await task.setup(ctx)
      const approvals: Approval[] = []
      const apps = new Set<string>()
      const log = RunLog.open(join(root, 'evidence', 'runs'), `${task.id}-${r}-${stamp}`)
      const result = await runTask({
        task: task.prompt(data),
        adapter: adapter(model),
        mac,
        web,
        allowPrivateUrls: true, // the web fixtures run on 127.0.0.1
        focus,
        frontmost,
        ...(shadow ? { shadow } : {}),
        approve: async (a) => (approvals.push(a), policy(task, a)),
        ask: async () => null,
        log: {
          write: (event, data) => {
            log.write(event, data)
            if (event === 'target' && typeof data?.app === 'string') apps.add(data.app)
          },
        },
        signal: controller.signal,
        avoid: avoidBundles(process.env),
      })
      log.close()
      const verdict = await task.check(ctx, data, { result, approvals, apps: [...apps] })
      usd += result.usd
      report.add({
        name,
        pass: verdict.pass,
        durationMs: result.ms,
        details: { status: result.status, summary: result.summary, actions: result.actions, turns: result.turns, usd: result.usd, approvals: approvals.map((a) => `${a.kind}: ${a.title}`), log: log.path, ...verdict.detail },
      })
      console.log(`${verdict.pass === true ? 'PASS' : verdict.pass === false ? 'FAIL' : 'SEEN'}  ${name}  ${result.status} · ${result.actions} actions · ${(result.ms / 1000).toFixed(1)} s · $${result.usd.toFixed(3)} · ${result.summary.slice(0, 110)}`)
      await task.cleanup?.(ctx, data).catch(() => {})
    } catch (error) {
      if (controller.signal.aborted) break
      const message = error instanceof Error ? error.message : String(error)
      report.add({ name, pass: false, details: { error: message } })
      console.log(`FAIL  ${name}  setup or check failed: ${message}`)
    }
  }

const out = report.finish({ model, repeat, usd: Math.round(usd * 1000) / 1000, skipped })
console.log(`\n${out.summary.passed}/${out.checks.length} passed · $${usd.toFixed(2)} · ${await writeReport(join(root, 'evidence'), out)}`)
await close()
await server?.close()
process.exit(0)
