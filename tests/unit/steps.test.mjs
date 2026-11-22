/** Unit tests: step operations and input normalisation (SPEC §11.1). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addSteps, clearDone, normaliseStepText, patchStep, removeStep, replaceSteps, splitLines,
} from '../../src/steps.mjs'

test('normaliseStepText strips bullets, numbering and checkboxes', () => {
  assert.equal(normaliseStepText('- Open the login page'), 'Open the login page')
  assert.equal(normaliseStepText('* Open the login page'), 'Open the login page')
  assert.equal(normaliseStepText('2. Run the e2e suite'), 'Run the e2e suite')
  assert.equal(normaliseStepText('1) Run the e2e suite'), 'Run the e2e suite')
  assert.equal(normaliseStepText('[ ] Check the callback'), 'Check the callback')
  assert.equal(normaliseStepText('- [ ] 1. Nested markers'), 'Nested markers')
  assert.equal(normaliseStepText('   '), '')
  assert.equal(normaliseStepText('a\nb'), 'a b')
  assert.equal(normaliseStepText('x'.repeat(5000)).length, 2000)
})

test('splitLines keeps one non-blank line per entry', () => {
  assert.deepEqual(splitLines('First\n\nSecond\n   \n- Third'), ['First', 'Second', 'Third'])
})

test('addSteps skips duplicates case-insensitively and reports counts', () => {
  const first = addSteps([], ['Open login', 'Run tests'], { source: 'ai', now: 1 })
  assert.equal(first.added, 2)
  const second = addSteps(first.steps, ['open LOGIN', 'New step'], { source: 'user', now: 2 })
  assert.equal(second.added, 1)
  assert.equal(second.skipped, 1)
  assert.deepEqual(second.steps.map(step => step.text), ['Open login', 'Run tests', 'New step'])
  assert.equal(second.steps[2].source, 'user')
})

test('addSteps expands a multi-line entry and honours the cap', () => {
  const result = addSteps([], ['a\nb', 'c'], { source: 'user', now: 3, limit: 2 })
  assert.equal(result.added, 2)
  assert.equal(result.skipped, 1)
  assert.equal(result.steps.length, 2)
})

test('replaceSteps keeps user rows by default and replaces agent rows', () => {
  const base = addSteps([], ['agent one', 'agent two'], { source: 'ai', now: 1 }).steps
  const withUser = addSteps(base, ['user note'], { source: 'user', now: 2 }).steps
  const replaced = replaceSteps(withUser, ['agent three'], { now: 3 })
  assert.deepEqual(replaced.steps.map(step => step.text), ['user note', 'agent three'])
  assert.equal(replaced.keptUser, 1)
  assert.equal(replaced.replaced, 2)
})

test('replaceSteps drops user rows only when explicitly allowed', () => {
  const base = addSteps([], ['user note'], { source: 'user', now: 1 }).steps
  const replaced = replaceSteps(base, ['agent only'], { now: 2, preserveUserSteps: false })
  assert.deepEqual(replaced.steps.map(step => step.text), ['agent only'])
  assert.equal(replaced.keptUser, 0)
})

test('patchStep edits, toggles and reorders', () => {
  const base = addSteps([], ['one', 'two', 'three'], { source: 'ai', now: 1 }).steps
  const [a, b, c] = base.map(step => step.id)
  const edited = patchStep(base, a, { text: '1. one edited' }, 2)
  assert.equal(edited.steps[0].text, 'one edited')
  const toggled = patchStep(edited.steps, b, { done: true }, 3)
  assert.equal(toggled.steps[1].done, true)
  const moved = patchStep(toggled.steps, c, { move: -1 }, 4)
  assert.deepEqual(moved.steps.map(step => step.text), ['one edited', 'three', 'two'])
  const first = patchStep(moved.steps, a, { move: -1 }, 5)
  assert.deepEqual(first.steps.map(step => step.text), ['one edited', 'three', 'two'])
  assert.equal(patchStep(base, 'missing', { done: true }).found, false)
})

test('removeStep and clearDone report what they removed', () => {
  const base = addSteps([], ['one', 'two', 'three'], { source: 'ai', now: 1 }).steps
  const removed = removeStep(base, base[1].id)
  assert.equal(removed.removed, 1)
  assert.deepEqual(removed.steps.map(step => step.text), ['one', 'three'])
  const done = patchStep(removed.steps, removed.steps[0].id, { done: true }).steps
  const cleared = clearDone(done)
  assert.equal(cleared.removed, 1)
  assert.deepEqual(cleared.steps.map(step => step.text), ['three'])
})
