import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { packageDir, patchResolver, verifyNative, stageCua } from '../scripts/prepare-cua'

const resolverSource = [
  'function resolveOverride(crateName, path) { return path; }',
  'function resolveLibPath(opts) {',
  '  if ("override" in opts) return resolveOverride(opts.crateName, opts.override);',
  '}',
].join('\n')

test('patchResolver adds exactly one env override hook', () => {
  const out = patchResolver(resolverSource, 'JEVAUTO_CUA_SDK_LIBRARY')
  assert.equal(out.match(/process\.env\.JEVAUTO_CUA_SDK_LIBRARY/g)?.length, 2)
  assert.match(out, /function resolveLibPath\(opts\) \{\n\s+if \(process\.env\.JEVAUTO_CUA_SDK_LIBRARY\) return resolveOverride/)
})

test('patchResolver refuses a bundle it does not understand', () => {
  assert.throws(() => patchResolver('function other() {}', 'X'), /expected exactly one resolveLibPath/)
  assert.throws(() => patchResolver(resolverSource + '\nfunction resolveLibPath2(opts) {}', 'X'), /expected exactly one resolveLibPath/)
  assert.throws(() => patchResolver('function resolveLibPath(opts) {}', 'X'), /resolveOverride is missing/)
})

test('verifyNative rejects a hash mismatch with file, expected and actual', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevauto-cua-'))
  writeFileSync(join(dir, 'libcua_driver_sdk.dylib'), 'not the real library')
  await assert.rejects(
    verifyNative(dir, { 'libcua_driver_sdk.dylib': '3ba1' + '0'.repeat(60) }),
    /libcua_driver_sdk\.dylib: expected 3ba10+, got [0-9a-f]{64}/,
  )
})

test('packageDir finds a package whose exports hide its package.json', () => {
  const dir = packageDir('@trycua/cua-driver', join(process.cwd(), 'package.json'))
  assert.ok(existsSync(join(dir, 'dist', 'index.js')))
  assert.throws(() => packageDir('@trycua/not-installed', join(process.cwd(), 'package.json')), /Cannot find @trycua\/not-installed/)
})

test('stageCua stages a patched bundle and arm64-only native files', async () => {
  const out = mkdtempSync(join(tmpdir(), 'jevauto-stage-'))
  const staged = await stageCua(process.cwd(), out)
  assert.ok(existsSync(staged.bundle) && existsSync(staged.library) && existsSync(staged.runtime))
  assert.match(readFileSync(staged.bundle, 'utf8'), /process\.env\.JEVAUTO_CUA_SDK_LIBRARY/)
  assert.equal(execFileSync('lipo', ['-archs', staged.library], { encoding: 'utf8' }).trim(), 'arm64')
})

test('stageCua keeps the licence notices with what it ships', async () => {
  const out = mkdtempSync(join(tmpdir(), 'jevauto-stage-'))
  const staged = await stageCua(process.cwd(), out)
  assert.match(readFileSync(join(out, 'native', 'node-runtime-NOTICE.md'), 'utf8'), /Mozilla Public License 2\.0/)
  const head = readFileSync(staged.bundle, 'utf8').slice(0, 600)
  assert.match(head, /@ubjs\/core and @ubjs\/node 0\.31\.0-3 \(MPL-2\.0\)/)
  assert.match(head, /@trycua\/cua-driver 0\.28\.2 \(MIT\)/)
})
