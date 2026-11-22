/**
 * Which Session owns a listening socket, and which processes may be signalled.
 *
 * Three tiers, strongest first:
 *  1. `terminal` — the pid the Session's own agent terminal reported, plus its
 *     descendants. Exact.
 *  2. `job` — any process carrying `DSH_SESSION_ID=<session>` in its
 *     environment. The shell environment injects that for every foreground and
 *     background shell call of the Session, so it survives process re-parenting
 *     and helper daemons.
 *  3. `worktree` — a process whose working directory lies inside the Session's
 *     own checkout. Opt-in, because it is the only tier that could see another
 *     Session's work if two Sessions shared a directory; it is what catches a
 *     dev server started from an external editor inside this Session's worktree.
 *
 * The guard below decides the other direction: which processes must never be
 * signalled, whatever the tiers say.
 */

import { existsSync, realpathSync } from 'node:fs'

/**
 * @typedef {import('./proc.mjs').ProcEntry} ProcEntry
 * @typedef {{ port: number, host: string, pid: number, protocol: 'tcp' | 'tcp6' }} SocketRow
 */

/**
 * Build the pid set for descendant expansion.
 * @param {ProcEntry[]} entries - every readable process.
 * @returns {Map<number, number[]>} ppid -> children.
 */
export function buildChildIndex(entries) {
  const children = new Map()
  for (const entry of entries) {
    const list = children.get(entry.ppid)
    if (list === undefined) children.set(entry.ppid, [entry.pid])
    else list.push(entry.pid)
  }
  return children
}

/**
 * Every process in one process's descendant tree (excluding the root).
 * @param {Map<number, number[]>} children
 * @param {number} root
 * @returns {Set<number>}
 */
export function descendantsOf(children, root) {
  const out = new Set()
  const stack = [...(children.get(root) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop()
    if (out.has(pid)) continue
    out.add(pid)
    for (const child of children.get(pid) ?? []) stack.push(child)
  }
  return out
}

/**
 * Canonicalise a path for prefix comparison; unresolvable paths stay as given.
 * @param {string | undefined} path
 * @returns {string | undefined}
 */
export function canonicalPath(path) {
  if (typeof path !== 'string' || path === '') return undefined
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Whether `cwd` lies inside `root` (inclusive).
 * @param {string | undefined} cwd
 * @param {string | undefined} root
 * @returns {boolean}
 */
export function isInside(cwd, root) {
  const a = canonicalPath(cwd)
  const b = canonicalPath(root)
  if (a === undefined || b === undefined) return false
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`)
}

/**
 * Group sockets by owning pid using the `/proc/<pid>/fd` inodes.
 * @param {ProcEntry[]} entries
 * @param {SocketRow[]} sockets - listening sockets with their inodes.
 * @returns {Map<number, SocketRow[]>}
 */
export function socketsByPid(entries, sockets) {
  const byInode = new Map(sockets.map(socket => [socket.inode, socket]))
  const out = new Map()
  for (const entry of entries) {
    for (const inode of entry.socketInodes) {
      const socket = byInode.get(inode)
      if (socket === undefined) continue
      const list = out.get(entry.pid)
      if (list === undefined) out.set(entry.pid, [socket])
      else list.push(socket)
    }
  }
  return out
}

/**
 * Attribute listening sockets to Sessions.
 *
 * @param {object} input
 * @param {ProcEntry[]} input.entries - every readable process.
 * @param {(SocketRow & { inode: string })[]} input.sockets - listening sockets.
 * @param {string} input.sessionId - the Session being scanned.
 * @param {number[]} [input.rootPids] - pids from the Session's own terminals.
 * @param {string[]} [input.worktreeRoots] - the Session's checkout paths.
 * @param {boolean} [input.scanWorktreeCwd] - whether tier 3 is enabled.
 * @param {(sessionId: string) => string | undefined} [input.jobLabels] - job id for a pid, for origin provenance.
 * @returns {{ pid: number, socket: SocketRow, entry: ProcEntry, origin: 'terminal' | 'job' | 'worktree' }[]}
 */
export function attributeSockets({
  entries, sockets, sessionId, rootPids = [], worktreeRoots = [], scanWorktreeCwd = true,
}) {
  const byPid = new Map(entries.map(entry => [entry.pid, entry]))
  const children = buildChildIndex(entries)
  const owned = new Map()

  for (const root of rootPids) {
    if (!byPid.has(root)) continue
    owned.set(root, 'terminal')
    for (const pid of descendantsOf(children, root)) owned.set(pid, 'terminal')
  }

  for (const entry of entries) {
    if (owned.has(entry.pid)) continue
    if (entry.sessionId === sessionId) owned.set(entry.pid, 'job')
  }

  // Descendants of a job process belong to the same Session (a `pnpm dev`
  // wrapper is the job; vite is its child).
  for (const pid of [...owned.keys()]) {
    for (const child of descendantsOf(children, pid)) {
      if (!owned.has(child)) owned.set(child, owned.get(pid))
    }
  }

  if (scanWorktreeCwd && worktreeRoots.length > 0) {
    for (const entry of entries) {
      if (owned.has(entry.pid)) continue
      if (worktreeRoots.some(root => isInside(entry.cwd, root))) owned.set(entry.pid, 'worktree')
    }
  }

  const out = []
  for (const [pid, socketsOfPid] of socketsByPid(entries, sockets)) {
    const origin = owned.get(pid)
    if (origin === undefined) continue
    for (const socket of socketsOfPid) {
      out.push({ pid, socket, entry: byPid.get(pid), origin })
    }
  }
  return out
}

/**
 * Ancestors of one process, nearest first.
 * @param {Map<number, ProcEntry>} byPid
 * @param {number} pid
 * @returns {Set<number>}
 */
export function ancestorsOf(byPid, pid) {
  const out = new Set()
  let current = byPid.get(pid)
  while (current !== undefined && current.ppid > 1 && !out.has(current.ppid)) {
    out.add(current.ppid)
    current = byPid.get(current.ppid)
  }
  return out
}

/**
 * Whether a pid must never be signalled by this plugin.
 *
 * Guards: pid 0/1, the Harness process itself, its parent, any ancestor of the
 * Harness, and any pid the caller lists as protected (e.g. the DSH server).
 * @param {object} input
 * @param {number} input.pid - candidate.
 * @param {ProcEntry[]} input.entries - process table used for ancestry.
 * @param {number} [input.hostPid] - the Harness process (default `process.pid`).
 * @param {number} [input.hostPpid] - its parent (default `process.ppid`).
 * @param {number[]} [input.extraProtected] - additional pids that must survive.
 * @returns {{ protected: boolean, reason?: string }}
 */
export function protection({ pid, entries, hostPid = process.pid, hostPpid = process.ppid, extraProtected = [] }) {
  if (!Number.isInteger(pid) || pid <= 1) return { protected: true, reason: 'system' }
  if (pid === hostPid) return { protected: true, reason: 'harness' }
  if (pid === hostPpid) return { protected: true, reason: 'harness-parent' }
  if (extraProtected.includes(pid)) return { protected: true, reason: 'declared' }
  const byPid = new Map(entries.map(entry => [entry.pid, entry]))
  if (ancestorsOf(byPid, hostPid).has(pid)) return { protected: true, reason: 'harness-ancestor' }
  return { protected: false }
}

/**
 * Cheap existence check used before signalling (a stale `/proc` read is not an error).
 * @param {number} pid
 * @returns {boolean}
 */
export function pidExists(pid) {
  return existsSync(`/proc/${pid}`)
}
