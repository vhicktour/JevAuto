import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toCuaKeys } from '../src/agent/loop/keys'

test('a single key becomes press_key with Cua names', () => {
  assert.deepEqual(toCuaKeys(['ENTER']), { tool: 'press_key', key: 'return' })
  assert.deepEqual(toCuaKeys(['ArrowDown']), { tool: 'press_key', key: 'down' })
  assert.deepEqual(toCuaKeys(['BACKSPACE']), { tool: 'press_key', key: 'delete' })
  assert.deepEqual(toCuaKeys(['esc']), { tool: 'press_key', key: 'escape' })
  assert.deepEqual(toCuaKeys(['F5']), { tool: 'press_key', key: 'f5' })
  assert.deepEqual(toCuaKeys(['A']), { tool: 'press_key', key: 'a' })
  assert.deepEqual(toCuaKeys(['/']), { tool: 'press_key', key: '/' })
})

test('modifiers make a hotkey, modifiers first, in Cua names', () => {
  assert.deepEqual(toCuaKeys(['CTRL', 'C']), { tool: 'hotkey', keys: ['ctrl', 'c'] })
  assert.deepEqual(toCuaKeys(['SHIFT', 'CMD', 'D']), { tool: 'hotkey', keys: ['shift', 'cmd', 'd'] })
  assert.deepEqual(toCuaKeys(['META', 'a']), { tool: 'hotkey', keys: ['cmd', 'a'] })
  assert.deepEqual(toCuaKeys(['ALT', 'TAB']), { tool: 'hotkey', keys: ['option', 'tab'] })
  assert.deepEqual(toCuaKeys(['C', 'CMD']), { tool: 'hotkey', keys: ['cmd', 'c'] })
})

test('chords Cua cannot press are errors the model can read', () => {
  assert.match((toCuaKeys([]) as { error: string }).error, /no key/i)
  assert.match((toCuaKeys(['SHIFT']) as { error: string }).error, /modifier/i)
  assert.match((toCuaKeys(['A', 'B']) as { error: string }).error, /one key/i)
  assert.match((toCuaKeys(['FOO']) as { error: string }).error, /FOO/)
})
