/**
 * Mount the platform discovery sources on the Harness scanner.
 *
 * Linux registers one source: the `/proc` scan, seeded with the Session's own
 * agent-terminal pids and, when configured, its checkout paths. `ss` is not
 * registered as a second source — it answers "who listens" less precisely than
 * the inode join and would compete with it; it stays available for diagnosis.
 * macOS registers an `lsof` source when the tool exists.
 */

import { scanSession } from './scan.mjs'
import { terminatePort } from './kill.mjs'
import { createGitInspector } from '../git.mjs'

/**
 * @param {object} ctx - Cordis context.
 * @param {object} host - the installed host handle.
 * @returns {Promise<void>}
 */
export async function installPortSources(ctx, host) {
  const { config } = host
  const sessionRoots = async (sessionId) => {
    const workingDirectory = ctx.get('workingDirectory')
    const roots = []
    if (workingDirectory !== undefined) {
      const agents = ctx.get('agents')
      const agent = agents?.get?.(sessionId)
      const session = agent?.session
      if (session !== undefined) {
        try {
          const dir = workingDirectory.get(session)
          if (typeof dir === 'string' && dir !== '') roots.push(dir)
        } catch {
          // A Session without a live Agent falls back to its record below.
        }
      }
    }
    const record = host.service.record(sessionId)
    if (roots.length === 0 && record?.git?.cwd) roots.push(record.git.cwd)
    return roots
  }

  const terminalRoots = (sessionId) => {
    const terminals = ctx.get('terminals')
    if (terminals === undefined) return []
    const agents = ctx.get('agents')
    const agent = agents?.get?.(sessionId)
    if (agent === undefined) return []
    try {
      return terminals.list(agent).map(entry => entry.pid).filter(pid => Number.isInteger(pid))
    } catch {
      return []
    }
  }

  const jobOfPid = (pid) => {
    const jobs = ctx.get('jobs')
    if (jobs === undefined) return undefined
    for (const job of jobs.list()) {
      if (job.pid === pid) return { pid, name: job.kind, id: job.id }
    }
    return undefined
  }

  // Git rides on the same cadence as the port scan: one inspection per tick over
  // the Session's own checkout keeps the branch and both line deltas current, and
  // the service drops the write when nothing changed.
  const git = createGitInspector(ctx, config)
  const refreshGit = async (sessionId, roots) => {
    const cwd = roots[0]
    if (cwd === undefined) return
    try {
      await host.service.applyGit(sessionId, await git.inspect(cwd))
    } catch (error) {
      host.log?.(`working-note: git inspection failed for ${sessionId}: ${String(error)}`)
    }
  }

  host.refreshGit = async (sessionId) => refreshGit(sessionId, await sessionRoots(sessionId))

  host.scanner.register('ports:proc', {
    probe: async (sessionId) => {
      const [roots, rootPids] = await Promise.all([
        sessionRoots(sessionId),
        Promise.resolve(terminalRoots(sessionId)),
      ])
      await refreshGit(sessionId, roots)
      const worktreeRoots = roots.filter(root => config.scanWorktreeCwd || isDedicatedWorktree(root))
      return scanSession({
        sessionId,
        rootPids,
        worktreeRoots: config.scanWorktreeCwd ? worktreeRoots : [],
        scanWorktreeCwd: config.scanWorktreeCwd,
        jobOfPid,
      })
    },
    stop: async (sessionId, reason) => {
      const record = host.service.record(sessionId)
      if (record === undefined) return []
      const live = record.ports.filter(port => port.state === 'listening')
      const results = []
      for (const row of live) {
        const outcome = await terminatePort({
          row,
          graceMs: config.killGraceMs,
          killJob: row.jobId === undefined
            ? undefined
            : (detail) => ctx.get('jobs')?.kill(row.jobId, sessionId, detail ?? reason),
        })
        results.push({ port: row.port, ...outcome })
      }
      const stopped = results.filter(result => result.status === 'killed' || result.status === 'already-stopped')
      if (stopped.length > 0) {
        await host.service.markPortsStopped(sessionId, stopped.map(result => result.port))
      }
      return results
    },
  })
}

/**
 * A checkout path created by the Harness worktree pool (`.agents/worktrees/`).
 * @param {string} path
 * @returns {boolean}
 */
function isDedicatedWorktree(path) {
  return /[\\/]\.agents[\\/]worktrees[\\/]/.test(path)
}
