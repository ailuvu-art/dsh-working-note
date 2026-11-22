/** Unit tests: git numstat / untracked counting rules. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countNewFileLines, parseNumstat } from '../../src/git.mjs'

test('parses plain numstat entries', () => {
  const text = '12\t3\tsrc/a.ts\0' + '4\t0\tsrc/b.ts\0'
  assert.deepEqual(parseNumstat(text), { added: 16, deleted: 3, files: 2 })
})

test('counts a binary file as a file with no lines', () => {
  const text = '-\t-\tassets/logo.png\0' + '5\t1\treadme.md\0'
  assert.deepEqual(parseNumstat(text), { added: 5, deleted: 1, files: 2 })
})

test('handles renames that carry old and new names', () => {
  const text = '2\t2\t\0old/name.ts\0new/name.ts\0'
  assert.deepEqual(parseNumstat(text), { added: 2, deleted: 2, files: 1 })
})

test('tolerates empty and malformed input', () => {
  assert.deepEqual(parseNumstat(''), { added: 0, deleted: 0, files: 0 })
  assert.deepEqual(parseNumstat(undefined), { added: 0, deleted: 0, files: 0 })
  assert.deepEqual(parseNumstat('garbage\0'), { added: 0, deleted: 0, files: 0 })
})

test('counts untracked lines without inventing a trailing line', () => {
  assert.equal(countNewFileLines('a\nb\nc\n'), 3)
  assert.equal(countNewFileLines('a\nb\nc'), 3)
  assert.equal(countNewFileLines(''), 0)
  assert.equal(countNewFileLines('no newline'), 1)
})
