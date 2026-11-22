/**
 * One port scan for one Session: read the process table, read the listening
 * sockets, attribute them, and turn them into the rows the service stores.
 */

import { readCmdline, readNetTables, listPids, readProcEntry, decodeAddress, defaultIo } from './proc.mjs'
import { attributeSockets } from './attribution.mjs'

/**
 * Build the tracked ports of one Session.
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {number[]} [options.rootPids] - terminal pids of this Session.
 * @param {string[]} [options.worktreeRoots] - checkout paths of this Session.
 * @param {boolean} [options.scanWorktreeCwd]
 * @param {Record<string, { port: number, pid: number, jobId: string }[]>} [options.jobPorts] - job ids already known by pid.
 * @param {object} [options.io] - injectable `/proc` IO for tests.
 * @param {(pid: number) => Promise<{ pid: number, name: string, id: string } | undefined>} [options.jobOfPid]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<import('../domain.mjs').TrackedPort[]>}
 */
export async function scanSession({
  sessionId, rootPids = [], worktreeRoots = [], scanWorktreeCwd = true,
  io, jobOfPid, signal,
}) {
  if (signal?.aborted) return []
  const netIo = io ?? defaultIo
  const sockets = (await readNetTables(netIo)).filter(socket => socket.listen && socket.inode !== '0')
  if (sockets.length === 0) return []
  const pids = await listPids(netIo)
  const entries = []
  for (const pid of pids) {
    if (signal?.aborted) break
    // Only processes that hold at least one socket can own a port; reading
    // every process's fd table would be needlessly expensive.
    const entry = await readProcEntry(pid, netIo)
    if (entry !== undefined && entry.socketInodes.length > 0) entries.push(entry)
  }
  const attributed = attributeSockets({
    entries, sockets, sessionId, rootPids, worktreeRoots, scanWorktreeCwd,
  })
  const rows = []
  const seen = new Set()
  for (const { pid, socket, entry, origin } of attributed) {
    const key = `${socket.localPort}:${pid}`
    if (seen.has(key)) continue
    seen.add(key)
    const command = await readCmdline(pid, netIo)
    const job = jobOfPid === undefined ? undefined : await jobOfPid(pid).catch(() => undefined)
    rows.push({
      port: socket.localPort,
      protocol: socket.protocol,
      host: decodeAddress(socket.localHex),
      pid,
      pgid: entry.pgid,
      startTime: entry.startTime,
      processName: entry.comm,
      command,
      origin: job !== undefined ? 'job' : origin,
      ...(job !== undefined ? { jobId: job.id } : {}),
      state: 'listening',
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    })
  }
  return rows
}
