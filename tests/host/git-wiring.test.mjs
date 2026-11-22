/**
 * The port scan also refreshes git (SPEC §5): the worktree pill, the branch and
 * the two line deltas come from the same tick, so a Session that never opened
 * the panel still shows real numbers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { installPortSources } from '../../src/ports/install.mjs'
import { resolveConfig } from '../../src/config.mjs'

const gitAvailable = spawnSync('git', ['--version']).status === 0

/** A subprocess service that runs the real `git` for the inspector. */
const subprocessService = () => ({
  async resolveExecutable(name) { return spawnSync('which', [name]).stdout.toString().trim() || null },
  spawn({ argv, cwd, env }) {
    const run = () => spawnSync(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, encoding: 'utf8' })
    const first = run()
    return {
      done: Promise.resolve({ exitCode: first.status ?? 1 }),
      collected: { stdout: { readFrom: () => ({ text: first.stdout ?? '' }) }, stderr: { readFrom: () => ({ text: first.stderr ?? '' }) } },
    }
  },
})

test('one scan writes the checkout, the branch and the line deltas', { skip: !gitAvailable }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wn-git-wiring-'))
  const run = (...argv) => spawnSync('git', argv, { cwd: root, encoding: 'utf8' })
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
  run('add', '.')
  run('commit', '-qm', 'init')
  await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/new.txt'), 'x\ny\n')

  const applied = []
  let source
  const host = {
    config: resolveConfig({}),
    service: {
      record: () => undefined,
      applyGit: async (sessionId, snapshot) => { applied.push([sessionId, snapshot]) },
      applyScan: async () => {},
    },
    scanner: { register: (kind, face) => { source = face } },
  }
  // A live Agent puts the Session's directory in `workingDirectory`; that is what
  // the port source already uses, so git rides on the same lookup.
  const session = { id: 's1' }
  const ctx = {
    get: (name) => name === 'subprocess' ? subprocessService()
      : name === 'workingDirectory' ? { get: (target) => (target === session ? root : undefined) }
        : name === 'agents' ? { get: (id) => (id === 's1' ? { session } : undefined) }
          : undefined,
  }
  await installPortSources(ctx, host)
  assert.equal(typeof source?.probe, 'function', 'the scan source is registered')

  await source.probe('s1')
  const [, snapshot] = applied.at(-1) ?? []
  assert.ok(snapshot !== undefined, 'the scan applied a git snapshot')
  assert.equal(snapshot.isGitRepo, true)
  assert.equal(snapshot.branch, 'main')
  assert.equal(snapshot.cwd, root)
  // One added line in the tracked file, plus the two lines of the untracked one
  // counted line by line; `files` counts the untracked file too, which is why it
  // is 2 rather than 1. Asserting the real numbers keeps the wiring honest.
  assert.equal(snapshot.uncommitted.added, 2)
  assert.equal(snapshot.uncommitted.deleted, 0)
  assert.equal(snapshot.uncommitted.files, 2)

})
