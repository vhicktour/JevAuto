import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JevShadow } from '../src/agent/jev/shadow'

const page = {
  url: 'https://shop.example/cart',
  title: 'Cart',
  text: 'Your cart: 2 items. Total $40.',
  controls: [
    { index: 0, role: 'AXTextField', label: 'Coupon' },
    { index: 1, role: 'AXButton', label: 'Checkout' },
    { index: 2, role: 'AXLink', label: 'Continue shopping' },
  ],
}

test('Jev is asked about the clickable controls only, and its pick maps back to one of them', async () => {
  const sent: unknown[] = []
  const shadow = new JevShadow(async (request) => {
    sent.push(request)
    return { answers: { operation: { choice: 'CLICK', confidence: 0.9 }, click_target: { choice: '1', confidence: 0.82 } } }
  })
  const guess = await shadow.guess('Check out', page)
  assert.deepEqual([guess?.operation, guess?.target, guess?.confidence], ['CLICK', { index: 1, label: 'Checkout' }, 0.82])
  const request = sent[0] as { state: { goal: string; page: { url: string; text: string } }; questions: { click_target: { options?: Record<string, string> } } }
  assert.equal(request.state.goal, 'Check out')
  assert.equal(request.state.page.url, page.url)
  assert.equal(JSON.stringify(request).includes('Coupon'), false) // a text field is not a click target
})

test('a failing or empty shadow never breaks the run', async () => {
  const broken = new JevShadow(async () => {
    throw new Error('429')
  })
  assert.equal(await broken.guess('x', page), undefined)
  let asked = false
  const idle = new JevShadow(async () => ((asked = true), { answers: {} }) as never)
  assert.equal(await idle.guess('x', { ...page, controls: [page.controls[0]] }), undefined)
  assert.equal(asked, false)
})
