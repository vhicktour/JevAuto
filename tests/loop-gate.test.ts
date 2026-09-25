import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gate, isExcluded, type GateInput } from '../src/agent/loop/gate'
import type { IrAction } from '../src/agent/providers/ir'
import type { ElementInfo } from '../src/agent/mac/results'

const mail = { app: 'Mail', bundleId: 'com.apple.mail', title: 'New Message' }
const button = (label: string): ElementInfo => ({ element_index: 1, role: 'AXButton', label, frame: { x: 0, y: 0, width: 10, height: 10 } })
const click: IrAction = { kind: 'click', callId: 'c', x: 5, y: 5, space: 'pixels', button: 'left' }
const keys = (...k: string[]): IrAction => ({ kind: 'keys', callId: 'c', keys: k })
const type = (text: string): IrAction => ({ kind: 'type', callId: 'c', text })
const field = { ok: true, role: 'AXTextArea', webArea: false, secure: false } as const
const input = (action: IrAction, extra: Partial<GateInput> = {}): GateInput => ({ action, target: mail, ...extra })

const CONSEQUENTIAL: [string, GateInput][] = [
  ['click Send', input(click, { element: button('Send') })],
  ['click Send Message', input(click, { element: button('Send Message') })],
  ['click Pay Now', input(click, { element: button('Pay Now') })],
  ['click Buy', input(click, { element: button('Buy') })],
  ['click Place Order', input(click, { element: button('Place Order') })],
  ['click Delete', input(click, { element: button('Delete') })],
  ['click Move to Trash', input(click, { element: button('Move to Trash') })],
  ['click Empty Trash', input(click, { element: button('Empty Trash') })],
  ['click Don’t Save', input(click, { element: button('Don’t Save') })],
  ['click Submit', input(click, { element: button('Submit') })],
  ['click Publish', input(click, { element: button('Publish') })],
  ['click Allow', input(click, { element: button('Allow') })],
  ['click Install', input(click, { element: button('Install') })],
  ['click Erase', input(click, { element: button('Erase…') })],
  ['click Accept', input(click, { element: button('Accept') })],
  ['press Return in a chat app', input(keys('ENTER'), { target: { app: 'Messages', bundleId: 'com.apple.MobileSMS', title: 'Messages' }, focus: field })],
  ['press cmd+shift+D (Mail send)', input(keys('CMD', 'SHIFT', 'D'), { focus: field })],
  ['press cmd+Delete (move to Trash)', input(keys('CMD', 'BACKSPACE'), { focus: field })],
  ['type a new line into a web page', input(type('hello\nworld'), { focus: { ...field, webArea: true } })],
  ['provider safety check', input(click, { element: button('Continue'), safety: [{ id: 's1', code: 'malicious_instructions', message: 'Check the page' }] })],
]

test('all 20 labelled consequential actions wait for approval', () => {
  for (const [name, i] of CONSEQUENTIAL) assert.equal(gate(i).decision, 'ask', name)
})

test('everyday actions go through without asking', () => {
  const everyday: [string, GateInput][] = [
    ['click Bold', input(click, { element: button('Bold') })],
    ['click New Note', input(click, { element: button('New Note') })],
    ['click an unlabelled spot', input(click)],
    ['type plain text', input(type('Hello there'), { focus: field })],
    ['press cmd+B', input(keys('CMD', 'B'), { focus: field })],
    ['press Tab', input(keys('TAB'), { focus: field })],
    ['scroll', input({ kind: 'scroll', callId: 'c', x: 1, y: 1, space: 'pixels', dx: 0, dy: 100 })],
    ['wait', input({ kind: 'wait', callId: 'c' })],
    ['a text field holding the word send', input(click, { element: { element_index: 2, role: 'AXTextField', value: 'send it', frame: { x: 0, y: 0, width: 9, height: 9 } } })],
  ]
  for (const [name, i] of everyday) assert.equal(gate(i).decision, 'allow', name)
})

test('password fields are refused, and so are keystrokes into them', () => {
  const secure = { ok: true, role: 'AXTextField', subrole: 'AXSecureTextField', webArea: false, secure: true }
  assert.equal(gate(input(type('hunter2'), { focus: secure })).decision, 'refuse')
  assert.equal(gate(input(keys('H'), { focus: secure })).decision, 'refuse')
  assert.equal(gate(input(keys('TAB'), { focus: secure })).decision, 'allow')
})

test('typing where AX cannot say what has focus needs approval', () => {
  assert.equal(gate(input(type('hello'), { focus: 'unknown' })).decision, 'ask')
  assert.equal(gate(input(type('hello'), { focus: { ok: false, error: 'no focused element', webArea: false, secure: false } })).decision, 'ask')
})

test('card and one-time-code fields need approval', () => {
  const card: ElementInfo = { element_index: 3, role: 'AXTextField', label: 'Card number', frame: { x: 0, y: 0, width: 9, height: 9 } }
  assert.equal(gate(input(type('4242'), { focus: field, element: card })).decision, 'ask')
})

test('hard exclusions refuse: JevAuto, browsers, password managers, security UI, privacy panes, your list', () => {
  const refused = [
    { app: 'JevAuto Dev', bundleId: 'personal.jevauto.desktop.dev' },
    { app: 'Safari', bundleId: 'com.apple.Safari' },
    { app: 'Google Chrome', bundleId: 'com.google.Chrome' },
    { app: 'Arc', bundleId: 'company.thebrowser.Browser' },
    { app: 'Firefox' },
    { app: '1Password', bundleId: 'com.1password.1password' },
    { app: 'Keychain Access', bundleId: 'com.apple.keychainaccess' },
    { app: 'SecurityAgent', bundleId: 'com.apple.SecurityAgent' },
    { app: 'System Settings', bundleId: 'com.apple.systempreferences', title: 'Privacy & Security' },
    { app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' },
  ]
  for (const t of refused) {
    assert.ok(isExcluded(t, ['com.tinyspeck.slackmacgap']), t.app)
    assert.equal(gate({ action: click, target: t, excluded: ['com.tinyspeck.slackmacgap'] }).decision, 'refuse', t.app)
  }
  assert.equal(isExcluded({ app: 'System Settings', bundleId: 'com.apple.systempreferences', title: 'Appearance' }), false)
  assert.equal(isExcluded({ app: 'Notes', bundleId: 'com.apple.Notes' }), false)
  assert.equal(isExcluded({ app: 'Operator Notes' }), false)
})

test('a refusal or a question always says why', () => {
  for (const [name, i] of CONSEQUENTIAL) {
    const v = gate(i)
    assert.ok(v.decision === 'ask' && v.reason.length > 5, name)
  }
})

test('Return and new lines in a Mac app\'s multi-line text just add lines; chat apps, web pages and one-line fields still ask', () => {
  const textEdit = { app: 'TextEdit', bundleId: 'com.apple.TextEdit', title: 'Notes.rtf' }
  const messages = { app: 'Messages', bundleId: 'com.apple.MobileSMS', title: 'Messages' }
  assert.equal(gate(input(type('Line one\nLine two'), { target: textEdit, focus: field })).decision, 'allow')
  assert.equal(gate(input(keys('ENTER'), { target: textEdit, focus: field })).decision, 'allow')
  assert.equal(gate(input(keys('SHIFT', 'ENTER'), { target: textEdit, focus: field })).decision, 'allow')
  assert.equal(gate(input(keys('CMD', 'ENTER'), { target: textEdit, focus: field })).decision, 'ask', 'cmd+Return sends in many apps')
  assert.equal(gate(input(keys('ENTER'), { target: messages, focus: field })).decision, 'ask')
  assert.equal(gate(input(type('see you\n'), { target: messages, focus: field })).decision, 'ask')
  assert.equal(gate(input(keys('ENTER'), { target: textEdit, focus: { ...field, webArea: true } })).decision, 'ask')
  assert.equal(gate(input(keys('ENTER'), { target: textEdit, focus: { ...field, role: 'AXTextField' } })).decision, 'ask')
  assert.equal(gate(input(keys('ENTER'), { target: textEdit, focus: 'unknown' })).decision, 'ask')
})
