/**
 * Unit tests: the kill contract with injected `/proc` readers.
 *
 * `terminatePort` must refuse a protected pid, a reused pid and a port the pid
 * no longer owns, and it must send SIGTERM before SIGKILL. The real
 * `/proc`-driven end-to-end kill runs in tests/host/ports.test.mjs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signalProcess, terminatePort, verifyPid } from '../../src/ports/kill.mjs'

const row = (overrides = {}) => ({
  port: 5173, protocol: 'tcp', host: '127.0.0.1', pid: 202, pgid: 202, startTime: '100',
  processName: 'vite', command: 'vite', origin: 'job', state: 'listening',
  firstSeenAt: 1, lastSeenAt: 1, ...overrides,
})

/** A tiny fake /proc around one target pid. */
const fakeIo = ({ pid = 202, startTime = '100', sockets = ['1001'], alive = true, ppid = 100 } = {}) => ({
  readFile: async (path) => {
    if (!alive) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    // Fields 3..22: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice numthreads itrealvalue starttime.
    if (path === `/proc/${pid}/stat`) return `${pid} (vite) S 100 202 202 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 ${startTime} 0 0 0`
    if (path === `/proc/${pid}/environ`) return 'PATH=/bin\0DSH_SESSION_ID=s-a\0'
    if (path === `/proc/${pid}/status`) return `Uid:\t1000\t1000\t1000\t1000\n`
    if (path === '/proc/net/tcp') return 'header\n0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 1001 1\n'
    if (path === '/proc/net/tcp6') return 'header\n'
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  },
  readdir: async (path) => path === '/proc' ? ['1', '100', String(pid)] : ['0', '1', '2'],
  readlink: async (path) => {
    if (path === `/proc/${pid}/fd/0`) return `/dev/null`
    if (path === `/proc/${pid}/fd/1`) return sockets.length > 0 ? 'socket:[1001]' : 'socket:[2002]'
    if (path === `/proc/${pid}/fd/2`) return 'pipe:[123]'
    if (path === `/proc/${pid}/cwd`) return '/repo'
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  },
})

test('verifyPid distinguishes alive, reused and gone', async () => {
  assert.equal(await verifyPid(202, '100', fakeIo()), 'alive')
  assert.equal(await verifyPid(202, '999', fakeIo()), 'reused')
  assert.equal(await verifyPid(202, '100', fakeIo({ alive: false })), 'gone')
})

test('SIGTERM settles the kill when the process releases the port', async () => {
  const signals = []
  const io = fakeIo()
  const original = process.kill
  // The fake process keeps listening until it receives SIGTERM, then dies:
  // this exercises the SIGTERM -> settled path of the contract (no SIGKILL).
  let listening = true
  process.kill = (pid, signal) => {
    signals.push([pid, signal])
    if (signal === 'SIGTERM') listening = false
    return true
  }
  const liveIo = {
    ...io,
    readFile: async (path) => (path === '/proc/net/tcp' && !listening ? 'header\n' : io.readFile(path)),
  }
  try {
    const result = await terminatePort({
      row: row({ pid: 202, pgid: 202 }), graceMs: 0, io: liveIo, sleep: async () => {},
    })
    assert.equal(result.status, 'killed')
    assert.deepEqual(signals.map(([, signal]) => signal), ['SIGTERM'])
  } finally {
    process.kill = original
  }
})

test('escalates to SIGKILL when the process ignores SIGTERM', async () => {
  const signals = []
  const io = fakeIo({ sockets: ['other'] })
  const original = process.kill
  process.kill = (pid, signal) => { signals.push([pid, signal]); return true }
  try {
    const result = await terminatePort({
      row: row({ pid: 202, pgid: 202 }), graceMs: 0, io, sleep: async () => {},
    })
    assert.equal(result.status, 'killed')
    assert.deepEqual(signals.map(([, signal]) => signal), ['SIGTERM', 'SIGKILL'])
  } finally {
    process.kill = original
  }
})

test('refuses the Harness and its ancestors', async () => {
  const signals = []
  const original = process.kill
  process.kill = (pid, signal) => { signals.push([pid, signal]); return true }
  try {
    const result = await terminatePort({
      row: row({ pid: process.pid }), graceMs: 0, io: fakeIo({ pid: process.pid }), sleep: async () => {},
    })
    assert.equal(result.status, 'protected')
    assert.equal(result.reason, 'harness')
    assert.deepEqual(signals, [])
  } finally {
    process.kill = original
  }
})

test('refuses a reused pid and a port the pid no longer owns', async () => {
  const original = process.kill
  const signals = []
  process.kill = (pid, signal) => { signals.push([pid, signal]); return true }
  try {
    const reused = await terminatePort({
      row: row({ startTime: '100' }), graceMs: 0, io: fakeIo({ startTime: '777' }), sleep: async () => {},
    })
    assert.equal(reused.status, 'pid-reused')
    const unowned = await terminatePort({
      row: row({ port: 9999 }), graceMs: 0, io: fakeIo(), sleep: async () => {},
    })
    assert.equal(unowned.status, 'already-stopped')
    assert.deepEqual(signals, [])
  } finally {
    process.kill = original
  }
})

test('group signalling only when the target owns its group', () => {
  const sent = []
  const kill = (pid, signal) => { sent.push([pid, signal]); return true }
  signalProcess(300, 300, 'SIGTERM', { kill })
  signalProcess(301, 300, 'SIGTERM', { kill })
  signalProcess(302, undefined, 'SIGTERM', { kill })
  assert.deepEqual(sent, [[-300, 'SIGTERM'], [301, 'SIGTERM'], [302, 'SIGTERM']])
})

test('reports a delivery failure instead of throwing', () => {
  const kill = () => { throw new Error('EPERM') }
  assert.equal(signalProcess(400, 400, 'SIGTERM', { kill }), false)
})
