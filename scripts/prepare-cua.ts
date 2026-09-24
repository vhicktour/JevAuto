import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, realpathSync, createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { CUA_LIBRARY_ENV, CUA_NATIVE_SHA256, PINS } from '../src/shared/constants'

export function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolvePromise(hash.digest('hex')))
  })
}

export async function verifyNative(dir: string, expected: Record<string, string>): Promise<void> {
  const problems: string[] = []
  for (const [file, want] of Object.entries(expected)) {
    const got = await sha256File(join(dir, file)).catch(() => 'missing')
    if (got !== want) problems.push(`${file}: expected ${want}, got ${got}`)
  }
  if (problems.length) throw new Error(`Cua native files do not match the pinned release:\n${problems.join('\n')}`)
}

export function patchResolver(source: string, envVar: string): string {
  const pattern = /function resolveLibPath\d*\(opts\) \{/g
  const matches = source.match(pattern) ?? []
  if (matches.length !== 1) throw new Error(`expected exactly one resolveLibPath in the bundle, found ${matches.length}`)
  if (!/function resolveOverride\d*\(/.test(source)) throw new Error('resolveOverride is missing from the bundle')
  const override = source.match(/function (resolveOverride\d*)\(/)![1]
  return source.replace(pattern, `${matches[0]}\n  if (process.env.${envVar}) return ${override}(opts.crateName, process.env.${envVar});`)
}

/** A package's real directory, searched the way Node walks node_modules. `@trycua/cua-driver`'s `exports` hides its package.json from require.resolve. */
export function packageDir(name: string, fromFile: string): string {
  for (const base of createRequire(fromFile).resolve.paths(name) ?? []) {
    const candidate = join(base, name, 'package.json')
    if (existsSync(candidate)) return dirname(realpathSync(candidate))
  }
  throw new Error(`Cannot find ${name} from ${fromFile}. Run pnpm install.`)
}

export async function stageCua(root: string, out: string) {
  const sdkDir = packageDir('@trycua/cua-driver', join(root, 'package.json'))
  const sdkVersion = JSON.parse(await readFile(join(sdkDir, 'package.json'), 'utf8')).version
  if (sdkVersion !== PINS.cuaDriver) throw new Error(`@trycua/cua-driver is ${sdkVersion}; JevAuto pins ${PINS.cuaDriver}`)
  const nativeDir = packageDir('@trycua/cua-driver-darwin-arm64', join(sdkDir, 'package.json'))
  await verifyNative(nativeDir, CUA_NATIVE_SHA256)

  await rm(out, { recursive: true, force: true })
  await mkdir(join(out, 'native'), { recursive: true })
  const library = join(out, 'native', 'libcua_driver_sdk.dylib')
  const runtime = join(out, 'native', 'cua_driver_node_runtime.node')
  for (const [from, to] of [[join(nativeDir, 'libcua_driver_sdk.dylib'), library], [join(nativeDir, 'cua_driver_node_runtime.node'), runtime]]) {
    const archs = execFileSync('lipo', ['-archs', from], { encoding: 'utf8' }).trim().split(/\s+/)
    if (archs.length > 1) execFileSync('lipo', [from, '-thin', 'arm64', '-output', to])
    else await copyFile(from, to)
  }
  // The Node runtime is MPL-2.0; its notice says where the source is, so it ships beside the binary (THIRD-PARTY.md).
  await copyFile(join(nativeDir, 'node-runtime-NOTICE.md'), join(out, 'native', 'node-runtime-NOTICE.md'))

  const bundle = join(out, 'cua-sdk.mjs')
  await build({
    stdin: {
      contents: [
        'export { CuaDriver, DriverOptions, SdkClientKind } from "@trycua/cua-driver";',
        'export { requestMacOSPermissions, hasRequiredMacOSPermissions, openMacOSScreenRecordingSettings } from "@trycua/cua-driver/electron";',
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'jevauto-cua-entry.mjs',
      loader: 'js',
    },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    legalComments: 'inline',
    banner: {
      js: [
        `/*! Bundled by scripts/prepare-cua.ts from @trycua/cua-driver ${PINS.cuaDriver} (MIT), Copyright (c) 2025 Cua AI, Inc.,`,
        ' * and @ubjs/core and @ubjs/node 0.31.0-3 (MPL-2.0), https://mozilla.org/MPL/2.0/, source on npmjs.com.',
        ' * See THIRD-PARTY.md. */',
        'import { createRequire as __jevautoCreateRequire } from "node:module"; const require = __jevautoCreateRequire(import.meta.url);',
      ].join('\n'),
    },
    outfile: bundle,
    logLevel: 'silent',
  })
  await writeFile(bundle, patchResolver(await readFile(bundle, 'utf8'), CUA_LIBRARY_ENV))
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ cuaDriver: sdkVersion, nativeSha256: CUA_NATIVE_SHA256, thinnedTo: 'arm64' }, null, 2))
  return { bundle, library, runtime }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..')
  const staged = await stageCua(root, join(root, 'resources/cua-sdk'))
  console.log(`Staged Cua ${PINS.cuaDriver}: ${staged.bundle}`)
}
