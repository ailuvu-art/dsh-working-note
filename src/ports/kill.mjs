/**
 * Signalling, with the checks that make "Kill all" safe to press.
 *
 * Every signal re-proves the kill contract (CONTRACTS §7) right before it is
 * sent: the pid is not the Harness or one of its ancestors, the process still
 * owns the port, and its start time still matches the value recorded at scan
 * time. A process that exited and whose pid the kernel reused therefore fails
 * the check instead of receiving the signal.
 */

import { readFileSync } from 'node:fs'
import { readNetTables, readProcEntry, listPids } from './proc.mjs'
import { protection } from './attribution.mjs'

/**
 * Re-read `/proc/<pid>/stat` and compare its start time.
 * @param {number} pid
 * @param {string | undefined} expected
 * @param {object} [io] - injected readers for tests.
 * @returns {Promise<'alive' | 'reused' | 'gone'>}
 */
export async function verifyPid(pid, expected, io) {
  const entry = await readProcEntry(pid, io)
  if (entry === undefined) return 'gone'
  if (expected === undefined) return 'alive'
  return entry.startTime === expected ? 'alive' : 'reused'
}

/**
 * Re-read the socket table and check that the pid still listens on this port.
 * @param {number} pid
 * @param {number} port
 * @param {object} [io]
 * @returns {Promise<boolean>}
 */
export async function verifyPortOwner(pid, port, io) {
  const sockets = await readNetTables(io)
  const listening = new Set(sockets.filter(s => s.listen && s.localPort === port).map(s => s.inode))
  if (listening.size === 0) return false
  const entry = await readProcEntry(pid, io)
  if (entry === undefined) return false
  return entry.socketInodes.some(inode => listening.has(inode))
}

/** The Harness process's own process group, read once. */
let cachedPgid
/**
 * @returns {number | undefined} the process group of this Host, when `/proc` is readable.
 */
export function hostPgid() {
  if (cachedPgid !== undefined) return cachedPgid
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    cachedPgid = Number(stat.slice(close + 2).trim().split(/\s+/)[2])
  } catch {
    cachedPgid = undefined
  }
  return cachedPgid
}

/**
 * Send one signal to a pid, or to its process group when it owns a group of
 * its own that is not the Harness's group.
 * @param {number} pid
 * @param {number | undefined} pgid
 * @param {NodeJS.Signals} signal
 * @param {{ kill?: typeof process.kill }} [options]
 * @returns {boolean} whether the signal was delivered.
 */
export function signalProcess(pid, pgid, signal, { kill = process.kill } = {}) {
  const ownGroup = pgid !== undefined && pgid === pid && pgid !== hostPgid() && pgid > 1
  if (ownGroup) {
    try {
      kill(-pid, signal)
      return true
    } catch {
      // Fall through: the group may already be gone while the process lives.
    }
  }
  try {
    kill(pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * Terminate one tracked port: SIGTERM, wait for the grace window, then SIGKILL
 * if the same process still holds the port.
 *
 * @param {object} input
 * @param {import('../domain.mjs').TrackedPort} input.row - the tracked port.
 * @param {number} input.graceMs - SIGTERM to SIGKILL delay.
 * @param {(reason?: string) => unknown} [input.killJob] - kills the owning job first when known.
 * @param {(ms: number) => Promise<void>} [input.sleep] - injectable wait.
 * @param {object} [input.io] - injected `/proc` readers for tests.
 * @param {number[]} [input.extraProtected] - pids that must survive.
 * @returns {Promise<{ status: 'killed' | 'already-stopped' | 'protected' | 'pid-reused' | 'signal-failed', reason?: string }>}
 */
export async function terminatePort({
  row, graceMs, killJob, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  io, extraProtected = [],
}) {
  if (row.state !== 'listening') return { status: 'already-stopped' }

  const pids = await listPids(io)
  const table = []
  for (const pid of pids) {
    const entry = await readProcEntry(pid, io)
    if (entry !== undefined) table.push(entry)
  }
  const guard = protection({ pid: row.pid, entries: table, extraProtected })
  if (guard.protected) return { status: 'protected', reason: guard.reason }

  const liveness = await verifyPid(row.pid, row.startTime, io)
  if (liveness === 'gone') return { status: 'already-stopped' }
  if (liveness === 'reused') return { status: 'pid-reused' }
  if (!(await verifyPortOwner(row.pid, row.port, io))) return { status: 'already-stopped' }

  try {
    killJob?.('killed from the Working Note port list')
  } catch {
    // The job registry reports its own failures; the process kill still runs.
  }

  if (!signalProcess(row.pid, row.pgid, 'SIGTERM')) return { status: 'signal-failed', reason: 'SIGTERM' }
  await sleep(graceMs)

  const after = await verifyPid(row.pid, row.startTime, io)
  if (after === 'gone') return { status: 'killed' }
  if (after === 'reused') return { status: 'pid-reused' }
  if (!(await verifyPortOwner(row.pid, row.port, io))) return { status: 'killed' }
  return signalProcess(row.pid, row.pgid, 'SIGKILL')
    ? { status: 'killed' }
    : { status: 'signal-failed', reason: 'SIGKILL' }
}
