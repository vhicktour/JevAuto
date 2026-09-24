import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { VisibleMac } from '../src/agent/mac/visible'
import { localRuntime } from '../src/agent/loop/local'
import { runTask, type Answer, type Approval } from '../src/agent/loop/run'
import { RunLog } from '../src/agent/loop/runlog'
import { narrate } from '../src/shared/narrate'
import { UiAct, UiDone, UiStatus } from '../src/shared/ui-events'
import { answerOf, avoidBundles, parseAgentArgs, type AgentArgs } from './agent-args'

const root = resolve(import.meta.dirname, '..')
/** An approval you leave unanswered expires as a no (spec §8). */
const APPROVAL_MS = 60_000

let args: AgentArgs
try {
  args = parseAgentArgs(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(64)
}
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Add it to .env.local.')
  process.exit(78)
}

const controller = new AbortController()
let stopping = false
function stop() {
  if (stopping) process.exit(130)
  stopping = true
  console.log('\nStopping…')
  controller.abort(new Error('Stopped by you'))
  // The app's backstop: 250 ms after Stop the process ends, and any keystrokes Cua still has queued end with it.
  setTimeout(() => process.exit(130), 250).unref()
}
process.on('SIGINT', stop)

async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) return '' // nobody can answer, so the answer is no
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.on('SIGINT', stop) // while a prompt is open, Ctrl-C reaches readline instead of the process
  try {
    return await rl.question(question, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(APPROVAL_MS)]) })
  } catch {
    return ''
  } finally {
    rl.close()
  }
}

async function approve(a: Approval): Promise<Answer> {
  const runOffered = a.kind === 'foreground'
  console.log(`\n? ${a.title}\n  ${a.reason}`)
  return answerOf(await prompt(runOffered ? '  [y] once  [a] for this run  [N] no › ' : '  [y] allow once  [N] no › '), runOffered)
}

async function ask(question: string): Promise<string | null> {
  console.log(`\n? ${question}`)
  return (await prompt('  › ')).trim() || null
}

function emit(name: string, data: unknown) {
  if (name === 'ui.act') {
    const act = UiAct.safeParse(data)
    // The terminal is not the screen: name the real action even when the window is hidden (the cursor still isn't drawn).
    if (act.success) console.log(`› ${narrate({ ...act.data, visible: true })}${act.data.visible ? '' : ' · in the background'}`)
  } else if (name === 'ui.done') {
    const done = UiDone.safeParse(data)
    if (done.success && !done.data.ok) console.log(`  ✗ did not work (${done.data.ms} ms)`)
  } else if (name === 'ui.status') {
    const s = UiStatus.safeParse(data)
    if (s.success && s.data.state === 'working' && s.data.detail) console.log(`  “${s.data.detail}”`)
  }
}

const { mac, web, focus, frontmost, adapter, close } = await localRuntime(root)
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const log = RunLog.open(join(homedir(), 'Library/Application Support/JevAuto Dev/runs'), runId)
const { maxActions, maxMs, maxUsd } = args.budget
console.log(`JevAuto · ${args.model} · up to ${maxActions} actions, ${maxMs / 60_000} min, $${maxUsd.toFixed(2)} · Ctrl-C stops`)

const result = await runTask({
  task: args.task,
  adapter: adapter(args.model),
  mac: new VisibleMac(mac, emit),
  web,
  focus,
  frontmost,
  approve,
  ask,
  log,
  signal: controller.signal,
  budget: args.budget,
  excluded: args.excluded,
  avoid: avoidBundles(process.env),
  front: args.watch,
  emit,
})
log.close()
const mark = result.status === 'success' || result.status === 'ended' ? '✓' : result.status === 'stopped' ? '■' : '✗'
console.log(`\n${mark} ${result.summary}`)
console.log(`  ${result.actions} actions · ${result.turns} turns · ${(result.ms / 1000).toFixed(1)} s · $${result.usd.toFixed(3)} · ${result.status}`)
console.log(`  Run log: ${log.path}`)
await close()
process.exit(mark === '✓' ? 0 : 1)
