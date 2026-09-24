import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keycaps, gestureLabel } from '../src/renderer/src/cursor/gesture'
import type { UiAct } from '../src/shared/ui-events'

const act = (a: Partial<UiAct>): UiAct => ({ id: 'a', verb: 'click', visible: true, ...a })

test('keycaps read like the keys on a Mac keyboard', () => {
  assert.deepEqual(keycaps('cmd+shift+d'), ['⌘', '⇧', 'D'])
  assert.deepEqual(keycaps('return'), ['↩'])
  assert.deepEqual(keycaps('option+tab'), ['⌥', '⇥'])
  assert.deepEqual(keycaps('ctrl+down'), ['⌃', '↓'])
  assert.deepEqual(keycaps('f5'), ['F5'])
})

test('the chip names the gesture: double, right and modifier clicks, scroll direction', () => {
  assert.equal(gestureLabel(act({ label: 'Send' })), 'Click “Send”')
  assert.equal(gestureLabel(act({ count: 2, label: 'notes.txt' })), 'Double-click “notes.txt”')
  assert.equal(gestureLabel(act({ button: 'right' })), 'Right-click')
  assert.equal(gestureLabel(act({ held: ['shift'], label: 'may.pdf' })), '⇧ Click “may.pdf”')
  assert.equal(gestureLabel(act({ verb: 'drag', label: 'april.pdf' })), 'Drag “april.pdf”')
  assert.equal(gestureLabel(act({ verb: 'scroll', direction: 'down' })), 'Scroll ↓')
  assert.equal(gestureLabel(act({ verb: 'type', text: 'Hi' })), 'Type')
})
