// The signed arm64 release: a DMG to install, and a ZIP plus latest-mac.yml for auto-update, signed with the Developer ID.
// Notarizes and staples when the `jevauto-notary` keychain profile exists; without it the build is signed but Gatekeeper
// warns on other Macs. Create the profile once with:
//   xcrun notarytool store-credentials jevauto-notary --apple-id <your Apple ID> --team-id T856B6ULMN
// `--publish` uploads the files to a draft GitHub release for this version; nothing leaves this Mac without it.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'

const IDENTITY = process.env.JEVAUTO_RELEASE_IDENTITY ?? 'Victor Udeh (T856B6ULMN)'
const PROFILE = process.env.JEVAUTO_NOTARY_PROFILE ?? 'jevauto-notary'
const publish = process.argv.includes('--publish')
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

const run = (command, argv, env = {}) => {
  const result = spawnSync(command, argv, { stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const succeeds = (command, argv) => spawnSync(command, argv, { stdio: 'ignore' }).status === 0

if (publish && execFileSync('git', ['status', '--porcelain']).toString().trim()) {
  console.error('Commit your changes first: a published release is built from a clean tree.')
  process.exit(1)
}
const notarize = succeeds('xcrun', ['notarytool', 'history', '--keychain-profile', PROFILE])
if (!notarize) console.warn(`No "${PROFILE}" notary profile: this build is signed but not notarized (see the top of scripts/release.mjs).`)
if (publish && !notarize) {
  console.error('A published release must be notarized, or macOS blocks it on other Macs and refuses its updates.')
  process.exit(1)
}

run('pnpm', ['build'])
run(
  'pnpm',
  ['exec', 'electron-builder', '--mac', '--arm64', '--publish', 'never', `-c.mac.identity=${IDENTITY}`, `-c.mac.notarize=${notarize}`],
  notarize ? { APPLE_KEYCHAIN_PROFILE: PROFILE } : {},
)

const app = 'dist/mac-arm64/JevAuto.app'
const dmg = `dist/JevAuto-${version}-arm64.dmg`
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
if (notarize) {
  // electron-builder notarized and stapled the app inside both files; the DMG itself gets its own ticket too.
  run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', PROFILE, '--wait'])
  run('xcrun', ['stapler', 'staple', dmg])
  run('xcrun', ['stapler', 'validate', app])
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
}

const files = readdirSync('dist')
  .filter((f) => f.includes(`-${version}-`) || f === 'latest-mac.yml')
  .map((f) => `dist/${f}`)
for (const f of files) console.log(`${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f}`)
if (publish)
  run('gh', ['release', 'create', `v${version}`, '--draft', '--title', `JevAuto ${version}`, '--notes', `JevAuto ${version} for Apple silicon Macs (macOS 26 or later).`, ...files])
