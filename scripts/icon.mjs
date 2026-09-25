// Renders build/icon.svg into build/icon.icns (every size macOS asks for). Run after changing the SVG: node scripts/icon.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import sharp from 'sharp'

const svg = readFileSync('build/icon.svg')
const set = 'build/icon.iconset'
rmSync(set, { recursive: true, force: true })
mkdirSync(set)
for (const size of [16, 32, 128, 256, 512]) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(`${set}/icon_${size}x${size}.png`)
  await sharp(svg, { density: 384 }).resize(size * 2, size * 2).png().toFile(`${set}/icon_${size}x${size}@2x.png`)
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', 'build/icon.icns'])
rmSync(set, { recursive: true, force: true })
console.log('build/icon.icns written')
