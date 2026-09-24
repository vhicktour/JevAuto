import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
if (args[0] !== 'dev') {
  console.error('usage: node scripts/app.mjs dev [--spike=skeleton|a|b] [--only=NAME] [--background] [--no-build]')
  process.exit(64)
}
const identity = process.env.JEVAUTO_DEV_IDENTITY ?? 'Victor Udeh (6T42U5DBW2)'
const appPath = resolve('dist/mac-arm64/JevAuto Dev.app')
const run = (command, argv) => {
  const result = spawnSync(command, argv, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (!args.includes('--no-build')) {
  run('pnpm', ['build'])
  run('pnpm', [
    'exec', 'electron-builder', '--mac', 'dir', '--arm64',
    '-c.appId=personal.jevauto.desktop.dev', '-c.productName=JevAuto Dev', '-c.extraMetadata.productName=JevAuto Dev',
    '-c.mac.type=development', `-c.mac.identity=${identity}`,
    // Dev signatures need no secure timestamp; skipping it removes a network round trip that can fail (release keeps it).
    '-c.mac.timestamp=none',
  ])
}
if (!existsSync(appPath)) {
  console.error(`Missing ${appPath}; run without --no-build first.`)
  process.exit(1)
}
const passthrough = args.filter((a) => a.startsWith('--spike=') || a.startsWith('--only=') || a === '--background')
// LaunchServices makes JevAuto Dev its own responsible process for TCC (spec §12 Phase 0E).
// --background launches without activating, so a full-screen Space stays current (Spike B).
const background = args.includes('--background') ? ['-g'] : []
run('open', [...background, '-n', '-a', appPath, '--args', ...passthrough, '--launch=open'])
console.log(`Launched ${appPath} ${passthrough.join(' ')} through LaunchServices.`)
