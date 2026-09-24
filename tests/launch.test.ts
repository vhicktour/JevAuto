import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchContext } from '../src/shared/launch'

test('a launch from a terminal or IDE is detected and explained, even after re-parenting to launchd', () => {
  for (const env of [
    { XPC_SERVICE_NAME: '0', TERM_PROGRAM: 'Apple_Terminal', __CFBundleIdentifier: 'com.apple.Terminal' },
    { XPC_SERVICE_NAME: 'application.com.microsoft.VSCode.81712906.81712912', TERM_PROGRAM: 'vscode' },
    {},
  ]) {
    const ctx = launchContext(env)
    assert.equal(ctx.fromTerminal, true)
    assert.match(ctx.hint!, /credit Accessibility and Screen Recording to that app/)
  }
})

test('a LaunchServices launch is recognised by its launchd job, even when `open` passes the terminal environment', () => {
  // macOS 27's `open` hands the caller's TERM and TERM_PROGRAM to the app; the job label is set by LaunchServices.
  const shell = { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }
  for (const job of ['application.personal.jevauto.desktop.dev.78667378.78669530.31F92ACD', 'application.personal.jevauto.desktop.1234.5678'])
    assert.deepEqual(launchContext({ ...shell, XPC_SERVICE_NAME: job }), { fromTerminal: false })
})
