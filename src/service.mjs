/**
 * The one implementation behind the HTTP API, the agent tool, and the UI.
 *
 * Every mutation runs through here: durable write first, then subscribe
 * notification, so a rejected write never shows in a client. Archive state is
 * enforced at this level, which is what makes the archived tab read-only on
 * every device at once.
 */

import {
  addSteps, clearDone, patchStep, removeStep, replaceSteps,
} from './steps.mjs'
import { emptyRecord } from './domain.mjs'
import { renderContext } from './context-text.mjs'
import {
  archivedSession, limitReached, missingSession, portUnavailable, unknownSession, unknownStep,
} from './errors.mjs'

const MAX_PORTS = 100

/**
 * @typedef {import('./domain.mjs').SessionRecord} SessionRecord
 * @typedef {import('./store.mjs').Table} Table
 */

/**
 * One Session's cache entry while the plugin is live.
 * @typedef {object} Runtime
 * @property {SessionRecord} record
 */

/**
 * Build the service over a table.
 * @param {object} deps
 * @param {Table} deps.table - durable KV table.
 * @param {object} deps.config - resolved plugin config.
 * @param {(sessionId: string) => boolean} deps.knownSession - whether the Host knows the session.
 * @param {(sessionId: string) => Promise<void>} deps.stopScans - stop background work for a session.
 * @param {() => number} [deps.now] - clock.
 * @returns the service face plus internals the other units need.
 */
export function createService({ table, config, knownSession, stopScans = async () => {}, now = Date.now }) {
  /** Live full-state subscribers, notified after every durable write. */
  const subscribers = new Map()

  /** @type {Map<string, Runtime>} */
  const runtimes = new Map()
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const purgeTimers = new Map()
  let disposed = false

  const runtime = (sessionId) => {
    let entry = runtimes.get(sessionId)
    if (entry === undefined) {
      const stored = table.get(sessionId)
      const record = stored === undefined ? emptyRecord(sessionId, now()) : { ...stored }
      entry = { record }
      runtimes.set(sessionId, entry)
    }
    return entry
  }

  const requireSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') throw missingSession()
    if (disposed) throw unknownSession(sessionId)
    return runtime(sessionId)
  }

  /**
   * Run one write without re-entering a queue (the queue itself calls this).
   * @param {string} sessionId
   * @param {(record: SessionRecord) => SessionRecord} fn
   * @returns {SessionRecord}
   */
  const mutateNow = (sessionId, fn) => {
    const entry = requireSession(sessionId)
    if (entry.record.archivedAt !== undefined) throw archivedSession(sessionId)
    const before = entry.record
    const next = fn({ ...before })
    if (next === before) return before
    entry.record = { ...next, updatedAt: now() }
    return entry.record
  }

  /** @type {Map<string, Promise<unknown>>} */
  const writeChains = new Map()

  /**
   * Serialize one Session's read-modify-write cycle.
   *
   * Two clients (or a client and the agent tool) may patch the same step at the
   * same moment; without a chain both read the same record and the later write
   * silently drops the earlier change. The chain keeps queued writes in call
   * order, isolates a rejected write from its successors, and drops itself once
   * it drains so a long-lived Host keeps no entry per Session.
   * @param {string} sessionId
   * @param {() => Promise<unknown>} work
   * @returns {Promise<unknown>} the work's own result or failure
   */
  const enqueue = (sessionId, work) => {
    const previous = writeChains.get(sessionId) ?? Promise.resolve()
    const run = previous.then(work, work)
    const tail = run.catch(() => {})
    writeChains.set(sessionId, tail)
    tail.then(() => {
      if (writeChains.get(sessionId) === tail) writeChains.delete(sessionId)
    })
    return run
  }

  /**
   * Apply one patch and persist it, serialized per Session.
   * @param {string} sessionId
   * @param {(record: SessionRecord) => SessionRecord} fn
   * @returns {Promise<object>} the resulting view
   */
  const save = (sessionId, fn) => enqueue(sessionId, async () => {
    mutateNow(sessionId, fn)
    await persist(sessionId)
    return view(sessionId)
  })

  const persist = async (sessionId) => {
    const entry = runtimes.get(sessionId)
    if (entry === undefined) return
    await table.put(sessionId, entry.record)
    publish(sessionId)
  }

  const publish = (sessionId) => {
    const entry = runtimes.get(sessionId)
    const target = subscribers.get(sessionId)
    if (target === undefined || target.size === 0) return
    // A purged record views as the empty default rather than leaking stale rows.
    const view = entry === undefined
      ? toView(emptyRecord(sessionId, now()), config)
      : toView(entry.record, config)
    for (const listener of [...target]) {
      try {
        listener(view)
      } catch {
        // A throwing subscriber must not break the write that already committed.
      }
    }
  }

  const view = (sessionId) => toView(requireSession(sessionId).record, config)

  // ---- reads -----------------------------------------------------------------

  const service = {
    view,

    subscribe(sessionId, listener) {
      requireSession(sessionId)
      let set = subscribers.get(sessionId)
      if (set === undefined) {
        set = new Set()
        subscribers.set(sessionId, set)
      }
      set.add(listener)
      return () => {
        const current = subscribers.get(sessionId)
        if (current === undefined) return
        current.delete(listener)
        if (current.size === 0) subscribers.delete(sessionId)
      }
    },

    subscriberCount(sessionId) {
      return subscribers.get(sessionId)?.size ?? 0
    },

    /** Synchronous read used by the context provider and by tests. */
    record(sessionId) {
      return runtimes.get(sessionId)?.record ?? table.get(sessionId)
    },

    allRecords() {
      return [...table.entries()]
    },

    // ---- steps ---------------------------------------------------------------

    async addSteps(sessionId, { steps, source = 'user' }) {
      let counts = { added: 0, skipped: 0 }
      await save(sessionId, (record) => {
        const result = addSteps(record.steps, steps, {
          source, now: now(), limit: config.maxStepsPerSession,
        })
        counts = { added: result.added, skipped: result.skipped }
        return { ...record, steps: result.steps }
      })
      return { ...counts, view: view(sessionId) }
    },

    async replaceSteps(sessionId, { steps, preserveUserSteps = true }) {
      let counts = { replaced: 0, keptUser: 0, added: 0, skipped: 0 }
      await save(sessionId, (record) => {
        const result = replaceSteps(record.steps, steps, {
          now: now(), limit: config.maxStepsPerSession, preserveUserSteps,
        })
        counts = { replaced: result.replaced, keptUser: result.keptUser, added: result.added, skipped: result.skipped }
        return { ...record, steps: result.steps }
      })
      return { ...counts, view: view(sessionId) }
    },

    async updateStep(sessionId, stepId, patch) {
      const entry = requireSession(sessionId)
      if (!entry.record.steps.some(step => step.id === stepId)) throw unknownStep(stepId)
      await save(sessionId, (record) => {
        const result = patchStep(record.steps, stepId, patch, now())
        return { ...record, steps: result.steps }
      })
      return view(sessionId)
    },

    async removeStep(sessionId, stepId) {
      const entry = requireSession(sessionId)
      if (!entry.record.steps.some(step => step.id === stepId)) throw unknownStep(stepId)
      await save(sessionId, record => ({ ...record, steps: removeStep(record.steps, stepId).steps }))
      return view(sessionId)
    },

    async clearDone(sessionId) {
      let removed = 0
      await save(sessionId, (record) => {
        const result = clearDone(record.steps)
        removed = result.removed
        return { ...record, steps: result.steps }
      })
      return { removed, view: view(sessionId) }
    },

    // ---- ports ---------------------------------------------------------------

    /**
     * Merge one scan result into the record, keeping stopped history.
     * Called by the port monitor, never by a client.
     * @param {string} sessionId
     * @param {import('./domain.mjs').TrackedPort[]} found - ports listening now.
     */
    async applyScan(sessionId, found) {
      if (runtimes.has(sessionId) && runtimes.get(sessionId).record.archivedAt !== undefined) return
      const entry = runtime(sessionId)
      const stamp = now()
      const previous = new Map(entry.record.ports.map(port => [port.port, port]))
      const live = found.map((port) => {
        const seen = previous.get(port.port)
        return {
          ...port,
          firstSeenAt: seen?.firstSeenAt ?? stamp,
          lastSeenAt: stamp,
          state: /** @type {const} */ ('listening'),
        }
      })
      const gone = entry.record.ports
        .filter(port => port.state === 'listening' && !found.some(next => next.port === port.port))
        .map(port => ({ ...port, state: /** @type {const} */ ('stopped'), stoppedAt: stamp }))
      const stopped = entry.record.ports.filter(port => port.state === 'stopped')
      const ttlCut = stamp - config.stoppedPortTtlMs
      const merged = [...live, ...gone, ...stopped.filter(port => (port.stoppedAt ?? stamp) >= ttlCut)]
        .sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.port - b.port)
        .slice(0, MAX_PORTS)
      const same = JSON.stringify(merged) === JSON.stringify(entry.record.ports)
      if (same) return
      entry.record = { ...entry.record, ports: merged, updatedAt: stamp }
      await persist(sessionId)
    },

    async markPortsStopped(sessionId, ports, stoppedAt = now()) {
      const wanted = new Set(ports)
      await save(sessionId, record => ({
        ...record,
        ports: record.ports.map(port => wanted.has(port.port) && port.state === 'listening'
          ? { ...port, state: 'stopped', stoppedAt }
          : port),
      }))
    },

    async clearStoppedPorts(sessionId) {
      let removed = 0
      await save(sessionId, (record) => {
        const kept = record.ports.filter(port => port.state !== 'stopped')
        removed = record.ports.length - kept.length
        return { ...record, ports: kept }
      })
      return { removed, view: view(sessionId) }
    },

    portRecord(sessionId, port) {
      return requireSession(sessionId).record.ports.find(row => row.port === port)
    },

    requirePort(sessionId, port) {
      const row = service.portRecord(sessionId, port)
      if (row === undefined) throw portUnavailable(port)
      return row
    },

    // ---- git + ui ------------------------------------------------------------

    async applyGit(sessionId, snapshot) {
      const entry = runtime(sessionId)
      if (entry.record.archivedAt !== undefined) return
      if (JSON.stringify(entry.record.git) === JSON.stringify(snapshot)) return
      entry.record = { ...entry.record, git: snapshot, updatedAt: now() }
      await persist(sessionId)
    },

    async setUi(sessionId, patch) {
      await save(sessionId, record => ({
        ...record,
        ui: {
          expanded: typeof patch.expanded === 'boolean' ? patch.expanded : record.ui.expanded,
          gitScope: patch.gitScope === 'uncommitted' || patch.gitScope === 'branch' ? patch.gitScope : record.ui.gitScope,
        },
      }))
      return view(sessionId)
    },

    contextText(sessionId) {
      if (!config.injectContextToModel) return ''
      const record = service.record(sessionId)
      return record === undefined ? '' : renderContext(record)
    },

    // ---- lifecycle -----------------------------------------------------------

    async markArchived(sessionId) {
      const entry = runtime(sessionId)
      if (entry.record.archivedAt !== undefined) return
      entry.record = {
        ...entry.record,
        archivedAt: now(),
        ports: entry.record.ports.map(port => port.state === 'listening'
          ? { ...port, state: 'stopped', stoppedAt: now() }
          : port),
        updatedAt: now(),
      }
      await table.put(sessionId, entry.record)
      publish(sessionId)
    },

    async unarchive(sessionId) {
      const timer = purgeTimers.get(sessionId)
      if (timer !== undefined) {
        clearTimeout(timer)
        purgeTimers.delete(sessionId)
      }
      const entry = runtimes.get(sessionId)
      if (entry === undefined || entry.record.archivedAt === undefined) return
      const { archivedAt: _drop, ...rest } = entry.record
      entry.record = { ...rest, updatedAt: now() }
      await table.put(sessionId, entry.record)
      publish(sessionId)
    },

    schedulePurge(sessionId) {
      const timer = purgeTimers.get(sessionId)
      if (timer !== undefined) clearTimeout(timer)
      purgeTimers.set(sessionId, setTimeout(() => {
        purgeTimers.delete(sessionId)
        void purged(sessionId)
      }, config.archiveGraceMs))
    },

    async purgeNow(sessionId) {
      const timer = purgeTimers.get(sessionId)
      if (timer !== undefined) {
        clearTimeout(timer)
        purgeTimers.delete(sessionId)
      }
      await purged(sessionId)
    },

    /** Release in-memory state on idle eviction; never touches the record. */
    async disposeSession(sessionId) {
      await stopScans(sessionId)
      subscribers.delete(sessionId)
      runtimes.delete(sessionId)
    },

    async dispose() {
      disposed = true
      for (const timer of purgeTimers.values()) clearTimeout(timer)
      purgeTimers.clear()
      subscribers.clear()
      runtimes.clear()
    },
  }

  const purged = async (sessionId) => {
    const had = table.get(sessionId) !== undefined
    runtimes.delete(sessionId)
    if (had) await table.delete(sessionId)
    // Subscribers still open see the empty state rather than stale rows.
    publish(sessionId)
  }

  return service
}

/**
 * Project a record into the wire shape every client decodes.
 * @param {SessionRecord} record
 * @param {object} config - resolved plugin config (for capabilities).
 * @returns {object} `SessionView` (CONTRACTS §2).
 */
export function toView(record, config) {
  const archived = record.archivedAt === undefined ? false : 'grace'
  const platform = process.platform
  const portDiscovery = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'macos-lsof' : 'unsupported'
  return {
    v: 1,
    sessionId: record.sessionId,
    steps: record.steps,
    ports: record.ports,
    git: record.git ?? null,
    ui: record.ui,
    archived,
    capabilities: {
      git: true,
      portDiscovery,
      kill: portDiscovery !== 'unsupported' && archived === false,
      mutate: archived === false,
      injectContext: config.injectContextToModel,
    },
    updatedAt: record.updatedAt,
  }
}

export { limitReached, unknownSession }
