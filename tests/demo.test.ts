import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearKey } from '../src/agent/spikes/demo'
import { windowStateOf } from '../src/agent/mac/results'

const buttons = (...labels: string[]) => windowStateOf({ elements: labels.map((label, i) => ({ element_index: i + 1, role: 'AXButton', label })) }).elements

test('clearKey finds Calculator\'s clear key whether it reads “All Clear” (empty) or “Clear” (after input)', () => {
  assert.equal(clearKey(buttons('Delete', 'All Clear', '7'))?.label, 'All Clear')
  assert.equal(clearKey(buttons('Delete', 'Clear', '7'))?.label, 'Clear')
  assert.equal(clearKey(buttons('Delete', '7')), undefined)
})
