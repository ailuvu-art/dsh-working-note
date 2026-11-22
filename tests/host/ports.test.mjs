/**
 * Live port scan and kill against a real child process (SPEC §11.2, CONTRACTS §7).
 *
 * The child listens on an ephemeral port and carries `DSH_SESSION_ID`, exactly
 * like a background job started by the Session's shell tool. The scan must
 * attribute it, "Kill all" must terminate it, and the Harness process itself
 * must never appear in the result.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { scanSession } from '../../src/ports/scan.mjs'
import { terminatePort } from '../../src/ports/kill.mjs'
import { attributeSockets } from '../../src/ports/attribution.mjs'
import { listPids, readProcEntry, readNetTables } from '../../src/ports/proc.mjs'

const SESSION = `wn-test-${process.pid}`

/** Start a Node child that listens and reports its port on stdout. */
async function startListener(sessionId, { ignoreTerm = false } = {}) {
  const script = `
    const http = require('node:http')
    if (${ignoreTerm}) process.on('SIGTERM', () => {})
    const server = http.createServer((_req, res) => res.end('ok'))
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      process.stdout.write(String(port) + '\\n')
    })
  `
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, DSH_SESSION_ID: sessionId },
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  })
  const port = await new Promise((resolve, reject) => {
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      const line = buffer.split('\n')[0]
      if (line !== undefined && /^\d+$/.test(line.trim())) resolve(Number(line.trim()))
    })
    child.on('error', reject)
    setTimeout(() => reject(new Error('listener did not report a port')), 5000).unref()
  })
  return { child, port, pid: child.pid }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a listening child carrying DSH_SESSION_ID is attributed to its session only', async (t) => {
  const listener = await startListener(SESSION)
  t.after(() => { try { process.kill(-listener.pid, 'SIGKILL') } catch { /* already gone */ } })

  const ours = await scanSession({ sessionId: SESSION })
  const row = ours.find(entry => entry.port === listener.port)
  assert.ok(row !== undefined, `port ${listener.port} not attributed`)
  assert.equal(row.pid, listener.pid)
  assert.equal(row.origin, 'job')
  assert.equal(row.state, 'listening')
  assert.equal(row.startTime !== undefined, true, 'start time recorded for the reuse guard')

  const other = await scanSession({ sessionId: 'a-different-session' })
  assert.equal(other.some(entry => entry.port === listener.port), false, 'another session must not claim it')
})

test('the Harness process is never attributed or signalled', async () => {
  const entries = []
  for (const pid of await listPids()) {
    const entry = await readProcEntry(pid)
    if (entry !== undefined) entries.push(entry)
  }
  const sockets = (await readNetTables()).filter(socket => socket.listen)
  const attributed = attributeSockets({ entries, sockets, sessionId: 'whatever' })
  assert.equal(attributed.some(row => row.pid === process.pid), false)
})

test('terminatePort stops the listening child and reports success', async (t) => {
  const listener = await startListener(SESSION)
  t.after(() => { try { process.kill(-listener.pid, 'SIGKILL') } catch { /* already gone */ } })
  const scan = await scanSession({ sessionId: SESSION })
  const row = scan.find(entry => entry.port === listener.port)
  assert.ok(row)

  const result = await terminatePort({ row, graceMs: 1500 })
  assert.equal(result.status, 'killed', JSON.stringify(result))
  const exited = await new Promise((resolve) => {
    listener.child.once('exit', () => resolve(true))
    setTimeout(() => resolve(!alive(listener.pid)), 3000)
  })
  assert.equal(exited, true, 'child exited after the kill')
})

test('a process that ignores SIGTERM is escalated to SIGKILL', async (t) => {
  const listener = await startListener(SESSION, { ignoreTerm: true })
  t.after(() => { try { process.kill(-listener.pid, 'SIGKILL') } catch { /* already gone */ } })
  const scan = await scanSession({ sessionId: SESSION })
  const row = scan.find(entry => entry.port === listener.port)
  assert.ok(row)
  const result = await terminatePort({ row, graceMs: 300 })
  assert.equal(result.status, 'killed', JSON.stringify(result))
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(alive(listener.pid), false, 'stubborn child was killed')
})
