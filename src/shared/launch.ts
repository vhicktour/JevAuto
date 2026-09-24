import { APP_BUNDLE_ID } from './constants'

export type LaunchContext = { fromTerminal: boolean; hint?: string }

/**
 * LaunchServices (Finder, `open`) runs the app as its own launchd job, `application.<bundle id>.…`, so macOS
 * credits TCC grants to JevAuto. A terminal or IDE launch inherits the terminal's job label and its grants.
 * TERM variables can't tell them apart (macOS 27's `open` passes them on), and the parent pid can't either
 * (a backgrounded terminal launch is re-parented to launchd).
 */
export function launchContext(env: Record<string, string | undefined>): LaunchContext {
  const fromTerminal = !(env.XPC_SERVICE_NAME ?? '').startsWith(`application.${APP_BUNDLE_ID}.`)
  return fromTerminal
    ? {
        fromTerminal,
        hint: `Launched from ${env.TERM_PROGRAM ?? 'a terminal or IDE'}: macOS will credit Accessibility and Screen Recording to that app, not JevAuto. Relaunch with pnpm app:dev.`,
      }
    : { fromTerminal }
}
