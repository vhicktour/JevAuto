import { parseArgs } from 'node:util'
import { DEFAULT_BUDGET, type Budget } from '../src/agent/loop/budget'
import type { Answer } from '../src/agent/loop/run'
import { PHASE0_MODELS } from '../src/shared/constants'

export type AgentArgs = { task: string; model: string; budget: Budget; watch: boolean; excluded: string[] }

function positive(flag: string, value: string | undefined, integer: boolean): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw new Error(`--${flag} needs a positive ${integer ? 'whole number' : 'number'}, not "${value}".`)
  return n
}

export function parseAgentArgs(argv: string[]): AgentArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      model: { type: 'string' },
      'max-actions': { type: 'string' },
      minutes: { type: 'string' },
      budget: { type: 'string' },
      watch: { type: 'boolean', default: false },
      exclude: { type: 'string', multiple: true },
    },
  })
  const task = positionals.join(' ').trim()
  if (!task) throw new Error('Give JevAuto a task, for example: pnpm agent "In TextEdit, type a haiku about autumn"')
  const minutes = positive('minutes', values.minutes, false)
  return {
    task,
    model: values.model ?? PHASE0_MODELS.openai,
    budget: {
      maxActions: positive('max-actions', values['max-actions'], true) ?? DEFAULT_BUDGET.maxActions,
      maxMs: minutes === undefined ? DEFAULT_BUDGET.maxMs : Math.round(minutes * 60_000),
      maxUsd: positive('budget', values.budget, false) ?? DEFAULT_BUDGET.maxUsd,
    },
    watch: values.watch ?? false,
    excluded: values.exclude ?? [],
  }
}

/** Deny unless the answer is clearly yes. "a" (for this run) counts only where it was offered. */
export function answerOf(input: string, runOffered: boolean): Answer {
  const a = input.trim().toLowerCase()
  if (a === 'y' || a === 'yes') return 'once'
  if (runOffered && (a === 'a' || a === 'always')) return 'run'
  return 'deny'
}

const TERMINALS = ['com.apple.Terminal', 'com.googlecode.iterm2', 'com.mitchellh.ghostty', 'dev.warp.Warp-Stable', 'com.github.wez.wezterm', 'org.alacritty', 'net.kovidgoyal.kitty', 'com.microsoft.VSCode', 'com.todesktop.230313mzl4w4u92', 'dev.zed.Zed']

/** macOS passes the launching app's bundle id to its shell in __CFBundleIdentifier. */
export function avoidBundles(env: NodeJS.ProcessEnv): string[] {
  return [...new Set([env.__CFBundleIdentifier, ...TERMINALS].filter((b): b is string => Boolean(b)))]
}
