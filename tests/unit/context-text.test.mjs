/** Unit tests: the pinned runtime context is deterministic, bounded, and quiet when empty. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOCK_CAP, renderContext } from '../../src/context-text.mjs'

const step = (id, text, done, source = 'ai') => ({ id, text, done, source, createdAt: 1, updatedAt: 1 })

const record = (overrides = {}) => ({
  sessionId: 's1',
  steps: [
    step('a', 'Open the login page', true),
    step('b', 'Test the callback', false),
    step('c', 'Check SameSite', false, 'user'),
  ],
  ports: [
    { port: 5173, state: 'listening', processName: 'node', origin: 'job' },
    { port: 8000, state: 'stopped', processName: 'uvicorn', origin: 'job' },
    { port: 3000, state: 'listening', processName: 'next', origin: 'worktree' },
  ],
  git: {
    cwd: '/repo', isGitRepo: true, isWorktree: true, branch: 'dsh-abc', uncommitted: { added: 12, deleted: 3, files: 2 }, updatedAt: 1,
  },
  ui: { expanded: false, gitScope: 'uncommitted' },
  updatedAt: 1,
  ...overrides,
})

test('renders worktree, open ports and every step with markers', () => {
  const text = renderContext(record())
  assert.match(text, /^\[Pinned working note/)
  assert.match(text, /Worktree: dsh-abc \(linked worktree\) · uncommitted \+12\/−3 in 2 files/)
  assert.match(text, /Open ports: :3000 \(next, worktree\), :5173 \(node, job\)/)
  assert.match(text, /Steps \(2 open \/ 3\)/)
  assert.match(text, /- \[x\] Open the login page(?:\n|$)/)
  assert.match(text, /- \[ \] Check SameSite \(user\)(?:\n|$)/)
})

test('is deterministic for the same record', () => {
  assert.equal(renderContext(record()), renderContext(record()))
})

test('says nothing when nothing is pending', () => {
  assert.equal(renderContext(record({
    steps: [step('a', 'done', true)],
    ports: [{ port: 1, state: 'stopped', processName: 'x', origin: 'job' }],
  })), '')
})

test('says nothing for an archived or missing record', () => {
  assert.equal(renderContext(record({ archivedAt: 5 })), '')
  assert.equal(renderContext(undefined), '')
})

test('caps the block and marks the remainder', () => {
  const many = Array.from({ length: 200 }, (_, index) => step(`s${index}`, `Step number ${index} with some words in it`, false))
  const text = renderContext(record({ steps: many }), { cap: 600 })
  assert.ok(text.length <= 600, `length ${text.length}`)
  assert.match(text, /… \(\+\d+ more steps\)/)
})

test('non-git directories name the folder instead of a branch', () => {
  const text = renderContext(record({ git: { cwd: '/tmp/demo', isGitRepo: false, isWorktree: false, uncommitted: { added: 0, deleted: 0, files: 0 }, updatedAt: 1 } }))
  assert.match(text, /Folder: \/tmp\/demo/)
})

test('the documented cap is honoured by default', () => {
  const many = Array.from({ length: 200 }, (_, index) => step(`s${index}`, 'x'.repeat(180), false))
  assert.ok(renderContext(record({ steps: many })).length <= BLOCK_CAP)
})
