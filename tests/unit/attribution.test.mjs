/**
 * Unit tests: socket attribution tiers and the kill guard.
 *
 * The table below is a small synthetic `/proc`: a Harness process, a job shell
 * carrying `DSH_SESSION_ID`, its `vite` child, an unrelated user process, one
 * process started from inside the session's worktree, and a second session's
 * job. The expected winners are what CONTRACTS §7 allows to be signalled.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ancestorsOf, attributeSockets, canonicalPath, descendantsOf, isInside, protection, buildChildIndex,
} from '../../src/ports/attribution.mjs'

const proc = (pid, ppid, extra = {}) => ({
  pid, ppid, pgid: pid, comm: `p${pid}`, startTime: '100', sessionId: undefined, cwd: '/tmp', socketInodes: [], uid: 1000, ...extra,
})

const entries = [
  proc(1, 0),
  proc(100, 1, { comm: 'dsh' }),                 // the Harness
  proc(200, 100, { sessionId: 's-a', comm: 'bash' }),   // job shell of session A
  proc(201, 200, { comm: 'pnpm' }),              // child of the job, no env
  proc(202, 201, { comm: 'vite' }),              // grandchild, holds :5173
  proc(300, 100, { comm: 'sshd' }),              // unrelated
  proc(400, 1, { cwd: '/repo/.agents/worktrees/wt-a', comm: 'uvicorn' }), // worktree process
  proc(500, 100, { sessionId: 's-b', comm: 'bash' }),    // another session's job
  proc(600, 100, { comm: 'terminal', pid: 600 }),
  proc(601, 600, { comm: 'node', socketInodes: ['222'] }), // terminal child holds :8000
]

const socks = [
  { inode: '111', protocol: 'tcp', localHex: '0100007F', localPort: 5173, listen: true },
  { inode: '222', protocol: 'tcp', localHex: '0100007F', localPort: 8000, listen: true },
  { inode: '333', protocol: 'tcp', localHex: '0100007F', localPort: 3000, listen: true },
  { inode: '444', protocol: 'tcp', localHex: '0100007F', localPort: 9000, listen: true },
]

const withSockets = () => {
  const copy = entries.map(entry => ({ ...entry, socketInodes: [...entry.socketInodes] }))
  copy.find(entry => entry.pid === 202).socketInodes = ['111']
  copy.find(entry => entry.pid === 300).socketInodes = ['444']
  copy.find(entry => entry.pid === 500).socketInodes = []
  copy.find(entry => entry.pid === 400).socketInodes = ['333']
  copy.find(entry => entry.pid === 601).socketInodes = ['222', '555']
  return copy
}

test('tier 1 wins over tier 2 for a terminal process in the same session', () => {
  const rows = attributeSockets({ entries: withSockets(), sockets: socks, sessionId: 's-a', rootPids: [600] })
  const ports = Object.fromEntries(rows.map(row => [row.socket.localPort, [row.pid, row.origin]]))
  assert.deepEqual(ports, { 5173: [202, 'job'], 8000: [601, 'terminal'] })
})

test('tier 2: DSH_SESSION_ID owns the job and every descendant', () => {
  const rows = attributeSockets({ entries: withSockets(), sockets: socks, sessionId: 's-a' })
  const ports = Object.fromEntries(rows.map(row => [row.socket.localPort, [row.pid, row.origin]]))
  assert.deepEqual(ports[5173], [202, 'job'])
})

test('tier 3: worktree cwd is opt-in and only catches unowned processes', () => {
  const off = attributeSockets({ entries: withSockets(), sockets: socks, sessionId: 's-a', scanWorktreeCwd: false })
  assert.equal(off.some(row => row.socket.localPort === 3000), false)
  const on = attributeSockets({
    entries: withSockets(), sockets: socks, sessionId: 's-a',
    worktreeRoots: ['/repo/.agents/worktrees/wt-a'], scanWorktreeCwd: true,
  })
  const row = on.find(entry => entry.socket.localPort === 3000)
  assert.equal(row.origin, 'worktree')
  assert.equal(row.pid, 400)
})

test('another session only claims the sockets it owns', () => {
  // Session B's job also listens on :9000 through an inode the unrelated sshd
  // process holds; the shared inode must not let A claim B's socket, or B claim
  // the unrelated one.
  const table = withSockets()
  table.find(entry => entry.pid === 500).socketInodes = ['444']
  const rowsB = attributeSockets({ entries: table, sockets: socks, sessionId: 's-b' })
  const rowsA = attributeSockets({ entries: table, sockets: socks, sessionId: 's-a' })
  const own = [...new Set(rowsB.map(row => [row.pid, row.socket.localPort, row.origin]))]
  assert.deepEqual(own, [[500, 9000, 'job']])
  assert.equal(rowsA.some(row => row.socket.localPort === 9000), false)
})

test('unrelated listeners are never attributed', () => {
  const rows = attributeSockets({ entries: withSockets(), sockets: socks, sessionId: 's-a' })
  assert.equal(rows.some(row => row.pid === 300), false)
  assert.equal(rows.some(row => row.pid === 500), false)
})

test('descendant walk is cycle-safe', () => {
  const children = buildChildIndex([proc(2, 1), proc(3, 2), proc(4, 4)])
  assert.deepEqual([...descendantsOf(children, 1)].sort(), [2, 3])
})

test('ancestors of the Harness are recognised', () => {
  const byPid = new Map(entries.map(entry => [entry.pid, entry]))
  assert.deepEqual([...ancestorsOf(byPid, 202)], [201, 200, 100])
})

test('protection blocks the Harness, its parents and ancestors, and pids <= 1', () => {
  const table = withSockets()
  assert.equal(protection({ pid: 1, entries: table, hostPid: 202 }).protected, true)
  assert.equal(protection({ pid: 0, entries: table, hostPid: 202 }).protected, true)
  assert.equal(protection({ pid: 202, entries: table, hostPid: 202 }).protected, true)
  assert.equal(protection({ pid: 201, entries: table, hostPid: 202 }).protected, true)
  assert.equal(protection({ pid: 500, entries: table, hostPid: 202, extraProtected: [500] }).protected, true)
  assert.equal(protection({ pid: 100, entries: table, hostPid: 202 }).reason, 'harness-ancestor')
  assert.equal(protection({ pid: 300, entries: table, hostPid: 202 }).protected, false)
})

test('isInside compares canonical prefixes, not raw strings', () => {
  assert.equal(isInside('/a/b/c', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/bc', '/a/b'), false)
  assert.equal(isInside(undefined, '/a/b'), false)
  assert.equal(canonicalPath('/'), '/')
})
