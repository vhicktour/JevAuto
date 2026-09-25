import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { WebDriver } from '../src/agent/browser/web'
import { agentChromeOptions } from '../src/agent/browser/chrome'
import { windowStateOf } from '../src/agent/mac/results'
import { startFixtureServer, type FixtureServer } from '../evals/fixtures/server'

let server: FixtureServer
let web: WebDriver
let id: number
before(async () => {
  server = await startFixtureServer()
  const profile = await mkdtemp(join(tmpdir(), 'jevauto-web-test-'))
  web = new WebDriver(profile, (dir) => chromium.launchPersistentContext(dir, { ...agentChromeOptions(), headless: true }), { blockPrivate: false }) // the fixtures live on 127.0.0.1
  id = (await web.open(`http://127.0.0.1:${server.port}/form`)).windowId
})
after(async () => {
  await web.close()
  await server.close()
})

const state = async () => {
  const r = await web.call('get_window_state', { pid: 0, window_id: id })
  assert.equal(r.isError, false, r.text)
  return { r, s: r.structured as { window_bounds: { x: number; y: number; width: number; height: number }; screenshot_width: number; window_title: string }, ...windowStateOf(r.structured) }
}
const px = (s: { window_bounds: { x: number; y: number; width: number }; screenshot_width: number }, f: { x: number; y: number; width: number; height: number }) => {
  const k = s.screenshot_width / s.window_bounds.width
  return { x: Math.round((f.x - s.window_bounds.x + f.width / 2) * k), y: Math.round((f.y - s.window_bounds.y + f.height / 2) * k) }
}

test('a tab is a window: a large id, a viewport screenshot, and its controls as AX-like elements', async () => {
  assert.ok(web.isWeb(id) && !web.isWeb(12345))
  const { r, s, elements, snapshotId } = await state()
  assert.equal(r.imageCount, 1)
  assert.equal(s.window_title, 'form')
  assert.ok(snapshotId)
  const roles = Object.fromEntries(elements.map((e) => [e.label, e.role]))
  assert.equal(roles.Save, 'AXButton')
  assert.equal(roles.More, 'AXLink')
  assert.equal(roles.Name, 'AXTextField')
  assert.equal(roles.Password, 'AXSecureTextField')
  assert.equal(roles.Notes, 'AXTextArea')
  assert.match(elements.find((e) => e.role === 'AXTextField' && /Card/.test(e.label ?? ''))?.label ?? '', /card number/i)
  assert.equal(elements.find((e) => e.role === 'AXSecureTextField')?.value, undefined) // a password's value is never read
})

test('typing by element index, then a click by screenshot pixels, work in the page', async () => {
  let { elements, snapshotId, s } = await state()
  const name = elements.find((e) => e.label === 'Name')!
  assert.equal((await web.call('type_text', { window_id: id, element_index: name.element_index, snapshot_id: snapshotId, text: 'Ada' })).isError, false)
  ;({ elements, s } = await state())
  const save = elements.find((e) => e.label === 'Save')!
  assert.equal((await web.call('click', { window_id: id, ...px(s, save.frame!) })).isError, false)
  assert.equal((await state()).s.window_title, 'saved Ada')
})

test('⌘A selects all in a field, so typing replaces it; focus reports the field and password fields as secure', async () => {
  const { elements, snapshotId, s } = await state()
  const notes = elements.find((e) => e.label === 'Notes')!
  await web.call('click', { window_id: id, ...px(s, notes.frame!) })
  assert.equal((await web.focus(id)).role, 'AXTextArea')
  assert.equal((await web.call('hotkey', { window_id: id, keys: ['cmd', 'a'] })).isError, false)
  await web.call('type_text', { window_id: id, text: 'new text' })
  assert.equal((await state()).elements.find((e) => e.label === 'Notes')?.value, 'new text')
  const pw = elements.find((e) => e.role === 'AXSecureTextField')!
  await web.call('click', { window_id: id, ...px(s, pw.frame!), snapshot_id: snapshotId })
  const focus = await web.focus(id)
  assert.deepEqual([focus.ok, focus.secure, focus.webArea], [true, true, true])
})

test('scrolling moves the page, and a link that opens a tab shows up as a new window', async () => {
  const before = await state()
  const saveY = (st: Awaited<ReturnType<typeof state>>) => st.elements.find((e) => e.label === 'Save')?.frame?.y ?? NaN
  await web.call('scroll', { window_id: id, x: 200, y: 200, direction: 'down', amount: 5 })
  const scrolled = await state()
  assert.ok(Math.abs(saveY(before) - saveY(scrolled) - 60) < 2, `${saveY(before)} → ${saveY(scrolled)}`) // 5 notches ≈ 60 CSS px
  await web.call('scroll', { window_id: id, x: 200, y: 200, direction: 'up', amount: 5 })
  const more = (await state()).elements.find((e) => e.label === 'More')!
  const windowsBefore = (await web.windows()).length
  await web.call('click', { window_id: id, ...px(before.s, more.frame!) })
  for (let i = 0; i < 20 && (await web.windows()).length === windowsBefore; i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal((await web.windows()).length, windowsBefore + 1)
})

test('JevAuto’s browser refuses every request to your own network, not only open_url', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'jevauto-web-block-'))
  const guarded = new WebDriver(profile, (dir) => chromium.launchPersistentContext(dir, { ...agentChromeOptions(), headless: true }), { blockPrivate: true })
  try {
    await assert.rejects(guarded.open(`http://127.0.0.1:${server.port}/form`), /ERR_BLOCKED_BY_CLIENT|blocked/i)
  } finally {
    await guarded.close()
  }
})

test('a button that submits a form says so in its label, so the gate asks before it', async () => {
  const tab = (await web.open(`http://127.0.0.1:${server.port}/signup`)).windowId
  const r = await web.call('get_window_state', { pid: 0, window_id: tab })
  const labels = windowStateOf(r.structured).elements.map((e) => e.label)
  assert.ok(labels.includes('Continue (submits a form)'), labels.join(' | '))
  assert.ok(labels.includes('Join (submits a form)'), labels.join(' | '))
  assert.ok(labels.includes('Help'), labels.join(' | '))
})
