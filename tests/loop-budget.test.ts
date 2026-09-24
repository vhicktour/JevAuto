import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Meter } from '../src/agent/loop/budget'

test('the action budget ends a run once it is used up', () => {
  const m = new Meter({ maxActions: 2, maxMs: 60_000, maxUsd: 1 })
  m.addAction()
  assert.equal(m.over(), null)
  m.addAction()
  assert.equal(m.over(), 'actions')
})

test('the cost budget counts every turn', () => {
  const m = new Meter({ maxActions: 40, maxMs: 60_000, maxUsd: 0.05 })
  m.addCost(0.03)
  assert.equal(m.over(), null)
  m.addCost(0.03)
  assert.equal(m.over(), 'cost')
})

test('time spent waiting for you does not count against the run', () => {
  let now = 0
  const m = new Meter({ maxActions: 40, maxMs: 1000, maxUsd: 1 }, () => now)
  m.start()
  now = 600
  m.pause()
  now = 60_000
  m.resume()
  assert.equal(m.over(), null)
  assert.equal(m.activeMs(), 600)
  now = 60_500
  assert.equal(m.over(), 'time')
})

test('extending a budget adds the same allowance again', () => {
  const m = new Meter({ maxActions: 1, maxMs: 60_000, maxUsd: 1 })
  m.addAction()
  assert.equal(m.over(), 'actions')
  m.extend('actions')
  assert.equal(m.over(), null)
})
