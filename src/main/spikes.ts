import { createReport, writeReport } from '../shared/report'
import { launchContext } from '../shared/launch'
import { requestPermissions } from './cua-host'
import type { Supervisor } from './supervisor'

export type SpikeName = 'skeleton' | 'a' | 'b'
export type SpikeDeps = {
  supervisor: Supervisor
  paths: { cuaSdkPath: string; cuaLibraryPath: string; nativeHelperPath: string }
  evidenceDir: string
  argv: string[]
  emit: (line: string) => void
}

export const argValue = (argv: string[], name: string) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

export function spikeFromArgv(argv: string[]): SpikeName {
  const v = argValue(argv, 'spike')
  return v === 'a' || v === 'b' ? v : 'skeleton'
}

type AgentPermissions = { accessibility: boolean; screenRecording: boolean; source: unknown; captureOk: boolean; captureError: string | null }

export async function runSkeleton(deps: SpikeDeps): Promise<boolean> {
  const ctx = launchContext(process.env)
  const label = argValue(deps.argv, 'launch') ?? (ctx.fromTerminal ? 'terminal' : 'finder')
  const report = createReport('skeleton', label)
  report.add({ name: 'launched through LaunchServices', pass: !ctx.fromTerminal, details: ctx })
  if (ctx.hint) deps.emit(ctx.hint)
  const main = await requestPermissions(deps.paths)
  report.add({ name: 'main sees Accessibility', pass: main.accessibility })
  report.add({ name: 'main sees Screen Recording', pass: main.screenRecording })
  const agent = await deps.supervisor.request<AgentPermissions>('permissions.check', {}, { timeoutMs: 60_000 })
  report.add({ name: 'agent (in-process Cua) sees both grants', pass: agent.accessibility && agent.screenRecording, details: agent })
  report.add({ name: 'agent desktop capture works', pass: agent.captureOk, details: { captureError: agent.captureError } })
  const granted = main.accessibility && main.screenRecording && agent.accessibility && agent.screenRecording
  if (!granted)
    deps.emit('Grant Accessibility and Screen Recording to “JevAuto Dev” in System Settings, then quit (⌘Q) and relaunch with the same command.')
  const file = await writeReport(deps.evidenceDir, report.finish({ granted }))
  deps.emit(`skeleton report: ${file}`)
  return granted
}

export async function runSpike(name: SpikeName, deps: SpikeDeps): Promise<void> {
  const granted = await runSkeleton(deps)
  if (name === 'skeleton' || !granted) return
  // Tasks 7 and 8 add 'a' and 'b' here.
}
