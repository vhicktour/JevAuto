import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const source = 'native/JevNative.swift'
const output = 'native/build/JevNative'
if (existsSync(output) && statSync(output).mtimeMs > statSync(source).mtimeMs) process.exit(0)
mkdirSync('native/build', { recursive: true })
writeFileSync(
  'native/build/Info.plist',
  '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>personal.jevauto.native</string><key>CFBundleName</key><string>JevNative</string></dict></plist>',
)
const build = spawnSync('xcrun', [
  'swiftc', '-swift-version', '5', '-O', '-target', 'arm64-apple-macosx26.0', source, '-o', output,
  '-framework', 'AppKit',
  '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', 'native/build/Info.plist',
], { stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status || 1)
const sign = spawnSync('codesign', ['--force', '--sign', '-', '--identifier', 'personal.jevauto.native', output], { stdio: 'inherit' })
process.exit(sign.status || 0)
