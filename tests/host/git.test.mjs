/**
 * Real-git integration for the worktree inspector (SPEC §11.2).
 *
 * Builds a throwaway repository with one commit and a linked worktree, runs the
 * inspector through a subprocess service that maps onto the real `git` binary,
 * and checks the two deltas: uncommitted work against HEAD, and the branch
 * against its base.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createGitInspector } from '../../src/git.mjs'
import { resolveConfig } from '../../src/config.mjs'

/** A subprocess service that runs the real `git` and returns the handle shape the inspector reads. */
function subprocessService() {
  return {
    resolveExecutable: async (command) => command,
    spawn: (spec) => {
      const state = { text: '' }
      const done = new Promise((resolve) => {
        try {
          state.text = execFileSync(spec.argv[0], spec.argv.slice(1), {
            cwd: spec.cwd, encoding: 'utf8', env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'],
          })
          resolve({ exitCode: 0, signal: null })
        } catch (error) {
          state.text = String(error.stdout ?? '')
          resolve({ exitCode: error.status ?? 1, signal: null })
        }
      })
      return { done, collected: { stdout: { readFrom: () => ({ text: state.text, nextOffset: 0, lossy: false }) } } }
    },
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

test('inspects a repository, its worktree, and both line deltas', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wn-git-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'app.txt'), 'one\ntwo\nthree\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  const worktree = join(root, 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree, 'main')

  // Uncommitted: one edited line pair, one untracked text file, one binary file.
  writeFileSync(join(worktree, 'app.txt'), 'one\ntwo changed\nthree\nfour\n')
  writeFileSync(join(worktree, 'new.txt'), 'a\nb\n')
  const inspector = createGitInspector({ get: (name) => name === 'subprocess' ? subprocessService() : undefined }, resolveConfig({}))

  const snapshot = await inspector.inspect(worktree)
  assert.equal(snapshot.isGitRepo, true)
  assert.equal(snapshot.isWorktree, true, 'linked worktree detected')
  assert.equal(snapshot.branch, 'feature')
  assert.equal(snapshot.uncommitted.files, 2, 'edited + untracked')
  assert.equal(snapshot.uncommitted.deleted, 1)
  assert.ok(snapshot.uncommitted.added >= 3, `added ${snapshot.uncommitted.added}`)

  // Branch delta appears when a base is resolvable (main exists locally).
  assert.equal(snapshot.baseRef, 'main')
  assert.ok(snapshot.branchDelta !== undefined)

  // A plain non-repository directory is reported, never thrown.
  const outside = join(root, 'plain')
  mkdirSync(outside)
  const plain = await inspector.inspect(outside)
  assert.equal(plain.isGitRepo, false)
  assert.equal(plain.branch, undefined)

  // The main checkout is not flagged as a worktree.
  const main = await inspector.inspect(repo)
  assert.equal(main.isWorktree, false)
})
