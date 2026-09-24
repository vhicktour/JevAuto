import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildJevRequest, offeredTargets, type SnapshotResult } from '../src/agent/jev/questions'

const snap = (clicks: number): SnapshotResult => ({
  url: 'https://example.com',
  title: 'Example',
  text: 't'.repeat(9000),
  actions: [
    ...Array.from({ length: clicks }, (_, i) => ({ id: `e${i + 1}`, kind: 'click' as const, node: i + 1, role: 'link', label: `Link ${i + 1}` })),
    { id: 'f1', kind: 'fill' as const, node: 900, role: 'textbox', label: 'Search' },
    { id: 'scroll_down', kind: 'scroll' as const, label: 'Scroll down' },
  ],
})

test('only clickable rows with a node are offered, capped at 250, keyed by node', () => {
  assert.equal(offeredTargets(snap(400)).length, 250)
  const { criteria } = buildJevRequest('Open link 3', snap(3)).questions.click_target
  assert.deepEqual(Object.keys(criteria), ['1', '2', '3'])
  assert.equal(criteria['3'], '[link] Link 3')
})

test('page text is capped and untrusted; operations include DONE and BLOCKED', () => {
  const req = buildJevRequest('Open link 3', snap(3))
  assert.equal(req.state.page.text.length, 6000)
  assert.match(String(req.questions.operation.instructions), /untrusted/)
  for (const k of ['CLICK', 'TYPE_TEXT', 'DONE', 'BLOCKED']) assert.ok(k in req.questions.operation.criteria, k)
})

test('a page with nothing to click is refused before any request', () => {
  assert.throws(() => buildJevRequest('Open link 3', snap(0)), /nothing to click/)
})
