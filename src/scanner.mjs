/**
 * Background scan loop for one Host.
 *
 * One loop serves every watched Session: every `intervalMs` it runs each
 * registered discovery source for the Sessions a client is currently viewing,
 * and the service merges the result into each record. An idle Harness runs no
 * scan at all, because the loop stops when the last Session is unwatched.
 *
 * Overlapping triggers for the same Session coalesce into one trailing run, so
 * a manual refresh during a scan never stacks a second `/proc` walk.
 */

/**
 * @param {object} options
 * @param {number} options.intervalMs - poll cadence while any Session is watched.
 * @param {(sessionId: string) => boolean} options.watched - whether a Session still needs scans.
 * @param {(sessionId: string, ports: object[]) => Promise<void>} options.apply - merge one scan.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @returns the scanner face.
 */
export function createScanner({ intervalMs, watched, apply, log = () => {} }) {
  /** @type {Map<string, { probe: (sessionId: string) => Promise<object[]>, stop: (sessionId: string, reason?: string) => Promise<unknown> }>} */
  const sources = new Map()
  /** @type {Set<string>} */
  const sessions = new Set()
  /** @type {Map<string, { running: boolean, again: boolean }>} */
  const busy = new Map()
  let timer = null
  let stopped = false
  let resolveTimer = null

  async function runOnce(sessionId) {
    const entry = busy.get(sessionId) ?? { running: false, again: false }
    busy.set(sessionId, entry)
    if (entry.running) {
      entry.again = true
      return
    }
    entry.running = true
    try {
      for (const [kind, source] of sources) {
        try {
          const ports = await source.probe(sessionId)
          await apply(sessionId, ports)
        } catch (error) {
          log(`working-note: ${kind} scan failed for ${sessionId}: ${String(error)}`)
        }
      }
    } finally {
      entry.running = false
      if (entry.again) {
        entry.again = false
        await runOnce(sessionId)
      }
    }
  }

  async function loop() {
    while (!stopped) {
      await new Promise((resolve) => {
        resolveTimer = resolve
        timer = setTimeout(resolve, intervalMs)
      })
      timer = null
      resolveTimer = null
      if (stopped) break
      await Promise.allSettled([...sessions].filter(watched).map(runOnce))
    }
  }

  return {
    /**
     * Register one discovery source. `stop` is what an archive with
     * `stopActivity` calls to take the Session's ports down.
     * @param {string} kind - e.g. `ports:proc`.
     * @param {{ probe: (sessionId: string) => Promise<object[]>, stop: (sessionId: string, reason?: string) => Promise<unknown> }} source
     */
    register(kind, source) {
      sources.set(kind, source)
    },

    /** Registered stop handlers, in registration order. */
    stopHandlers: () => [...sources.entries()],

    /** Start scanning a Session (idempotent); runs one scan immediately. */
    async watch(sessionId) {
      if (stopped) return
      if (!sessions.has(sessionId)) {
        sessions.add(sessionId)
        if (timer === null) void loop()
      }
      await runOnce(sessionId)
    },

    /** Stop scanning one Session; the loop ends with the last one. */
    async unwatch(sessionId) {
      sessions.delete(sessionId)
      busy.delete(sessionId)
      if (sessions.size === 0) {
        stopped = true
        if (timer !== null) clearTimeout(timer)
        timer = null
        resolveTimer?.()
      }
    },

    /** Force one immediate scan (manual refresh or a git-triggered rescan). */
    refresh: runOnce,

    async dispose() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      resolveTimer?.()
      sessions.clear()
      busy.clear()
    },
  }
}
