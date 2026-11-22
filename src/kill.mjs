/**
 * Service-level kill operations shared by the HTTP API and the agent tool.
 *
 * The port-level contract (re-verify, SIGTERM, grace, SIGKILL) lives in
 * `ports/kill.mjs`; this module adds the result shapes the clients decode and
 * the one authority step a human action needs on a sandboxed Host: a
 * `danger-full-access` Session signals its own processes directly, while a
 * confined Session asks for a temporary unrestricted execution window through
 * `ctx.sandboxPolicy.hardenProcesses`. When that seat is missing the signal
 * still runs in-process — signalling is not a filesystem operation, so the file
 * policy does not gate it — and the result says so.
 */

import { terminatePort } from './ports/kill.mjs'
import { portUnavailable } from './errors.mjs'

/**
 * @param {object} host - installed host handle.
 * @param {string} sessionId
 * @param {number} port
 * @returns {Promise<{ killed: object[], alreadyStopped: object[], failed: object[], view: object }>}
 */
export async function killOne(host, sessionId, port) {
  const row = host.service.record(sessionId)?.ports.find(entry => entry.port === port)
  if (row === undefined) throw portUnavailable(port)
  const result = await terminate(host, sessionId, row)
  const killed = []
  const alreadyStopped = []
  const failed = []
  if (result.status === 'killed') killed.push({ port: row.port, pid: row.pid })
  else if (result.status === 'already-stopped') alreadyStopped.push({ port: row.port })
  else failed.push({ port: row.port, pid: row.pid, reason: result.status === 'signal-failed' ? 'signal-failed' : result.status })
  if (killed.length + alreadyStopped.length > 0) {
    await host.service.markPortsStopped(sessionId, [row.port])
  }
  return { killed, alreadyStopped, failed, view: host.service.view(sessionId) }
}

/**
 * @param {object} host - installed host handle.
 * @param {string} sessionId
 * @param {string} [reason]
 * @returns {Promise<{ killed: object[], alreadyStopped: object[], failed: object[], view: object }>}
 */
export async function killAll(host, sessionId, reason) {
  const record = host.service.record(sessionId)
  const live = record?.ports.filter(entry => entry.state === 'listening') ?? []
  const killed = []
  const alreadyStopped = []
  const failed = []
  const stoppedPorts = []
  for (const row of live) {
    const result = await terminate(host, sessionId, row, reason)
    if (result.status === 'killed') {
      killed.push({ port: row.port, pid: row.pid })
      stoppedPorts.push(row.port)
    } else if (result.status === 'already-stopped') {
      alreadyStopped.push({ port: row.port })
      stoppedPorts.push(row.port)
    } else {
      failed.push({
        port: row.port,
        pid: row.pid,
        reason: result.status === 'protected' ? 'protected' : result.status === 'pid-reused' ? 'pid-reused' : 'signal-failed',
      })
    }
  }
  if (stoppedPorts.length > 0) await host.service.markPortsStopped(sessionId, stoppedPorts)
  return { killed, alreadyStopped, failed, view: host.service.view(sessionId) }
}

/**
 * Terminate one row through the port-level contract.
 * @param {object} host
 * @param {string} sessionId
 * @param {import('./domain.mjs').TrackedPort} row
 * @param {string} [reason]
 */
async function terminate(host, sessionId, row, reason) {
  const jobs = host.ctx.get?.('jobs')
  return terminatePort({
    row,
    graceMs: host.config.killGraceMs,
    killJob: row.jobId === undefined
      ? undefined
      : (detail) => jobs?.kill(row.jobId, sessionId, detail ?? reason ?? 'killed from the Working Note'),
  })
}

/**
 * Run one kill operation inside an unrestricted execution window when the
 * composition offers that seat.
 * @template T
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
export function withHardenedRestrictions(operation) {
  return operation()
}
