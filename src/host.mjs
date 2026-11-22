/**
 * Host entry body: one service face shared by the HTTP API, the agent tool, and
 * the runtime context, plus the archive lifecycle that keeps the note in step
 * with its Session.
 *
 * Optional services are read through `ctx.get`: `connection`/`webServer` only
 * exist in the web composition, `tools`/`systemPrompt` only where a model runs,
 * and `terminals`/`jobs` only where those capabilities are mounted. Every
 * registration rides `ctx.effect`/`ctx.on`, so unloading the plugin removes it.
 */

import { createService } from './service.mjs'
import { createScanner } from './scanner.mjs'
import { memoryTable } from './store.mjs'
import { workingNoteDomainSpec } from './domain.mjs'
import { FOREIGN_MARK } from './config.mjs'
import { killAll, killOne, withHardenedRestrictions } from './kill.mjs'

/**
 * Install the Host half.
 * @param {object} ctx - Cordis context.
 * @param {object} config - resolved configuration (see index.mjs).
 * @returns {object} the host handle (service, scanner, dispose, and the API handle once mounted).
 */
export function installHost(ctx, config) {
  const host = {
    config,
    ctx,
    service: null,
    scanner: null,
    table: null,
    ready: null,
    api: null,
    /** @param {object} api - the browser transport handle. */
    attachApi(api) { host.api = api },
    /** Force one scan of a Session (manual refresh): ports and git together. */
    refresh: async (sessionId) => {
      await host.scanner?.refresh(sessionId)
      await host.refreshGit?.(sessionId)
    },
    /** Inspect the Session's checkout now; installed with the port sources. */
    refreshGit: null,
    /**
     * Terminate one tracked port after re-proving ownership and identity.
     * @param {string} sessionId
     * @param {number} port
     * @returns {Promise<object>} the kill result (CONTRACTS §2).
     */
    async killPort(sessionId, port) {
      if (Number.isNaN(port)) {
        const { portUnavailable } = await import('./errors.mjs')
        throw portUnavailable(port)
      }
      return withHardenedRestrictions(() => killOne(host, sessionId, port))
    },
    /**
     * Terminate every live port of one Session.
     * @param {string} sessionId
     * @param {string} [reason]
     * @returns {Promise<object>} the kill result (CONTRACTS §2).
     */
    async killAllPorts(sessionId, reason) {
      return withHardenedRestrictions(() => killAll(host, sessionId, reason))
    },
    /** Take every registered source's ports down for one Session. */
    async stopSession(sessionId, reason) {
      const results = []
      for (const [kind, source] of host.scanner?.stopHandlers() ?? []) {
        try {
          results.push(await source.stop(sessionId, reason))
        } catch (error) {
          ctx.logger?.warn?.(`working-note: ${kind} stop failed for ${sessionId}: ${String(error)}`)
        }
      }
      return results
    },
    async dispose() {
      await host.api?.dispose?.()
      await host.scanner?.dispose()
      await host.service?.dispose()
      await host.table?.close?.()
    },
  }

  const log = (message) => ctx.logger?.warn?.(message)
  // Sources and the git inspector report through the host handle.
  host.log = log
  // A patch row that carried fields this plugin does not declare (a misrouted
  // batch config, or a newer layer) is ignored; say so once at activation.
  if (Array.isArray(config[FOREIGN_MARK]) && config[FOREIGN_MARK].length > 0) {
    log(`working-note: ignoring undeclared config field(s): ${config[FOREIGN_MARK].join(', ')}`)
  }
  host.ready = (async () => {
    const table = await openTable(ctx, log)
    host.table = table
    host.service = createService({
      table,
      config,
      stopScans: async (sessionId) => { await host.scanner?.unwatch(sessionId) },
    })
    host.scanner = createScanner({
      intervalMs: config.portPollIntervalMs,
      watched: (sessionId) => host.service.subscriberCount(sessionId) > 0,
      apply: (sessionId, ports) => host.service.applyScan(sessionId, ports),
      log,
    })
    wireLifecycle()
    wireModelFacing()
    if (ctx.get('connection') !== undefined && ctx.get('webServer') !== undefined) {
      const { installApi } = await import('./api.mjs')
      host.api = await installApi(ctx, host)
    }
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const { installPortSources } = await import('./ports/install.mjs')
      await installPortSources(ctx, host)
    }
  })()
  host.ready.catch((error) => { log(`working-note: activation failed: ${String(error)}`) })
  return host

  function wireLifecycle() {
    // Idle eviction: live watchers go, the durable record stays.
    ctx.on('session/disposed', ({ session }) => {
      const sessionId = session?.header?.id ?? session?.id
      if (typeof sessionId !== 'string') return
      void host.service.disposeSession(sessionId)
    })

    // Archive admission: open steps and non-job ports are what a user would lose.
    ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      const record = host.service.record(sessionId)
      const rest = await next()
      if (record === undefined) return rest
      const live = record.ports.filter(port => port.state === 'listening' && port.origin !== 'job')
      const open = record.steps.filter(step => !step.done)
      const own = []
      if (live.length > 0) {
        own.push({
          kind: 'workingNotePorts',
          items: live.map(port => ({ id: `:${port.port}`, label: `${port.processName} :${port.port}` })),
        })
      }
      if (open.length > 0) {
        own.push({
          kind: 'workingNoteSteps',
          items: open.slice(0, 5).map(step => ({ id: step.id, label: step.text.slice(0, 90) })),
        })
      }
      return own.length === 0 ? rest : [...own, ...rest]
    })

    // Archiving with stopActivity asks every source to take its work down.
    ctx.on('workspace/session-stop', async ({ sessionId }) => {
      await host.stopSession(sessionId, 'session archived')
      await host.service.disposeSession(sessionId)
    })

    // Archive keeps the record read-only for the undo window, then purges it.
    ctx.on('workspace/session-archived', ({ sessionId }) => {
      void (async () => {
        await host.scanner?.unwatch(sessionId)
        await host.service.markArchived(sessionId)
        host.service.schedulePurge(sessionId)
      })()
    })

    ctx.on('workspace/session-unarchiving', ({ sessionId }) => {
      void host.service.unarchive(sessionId)
    })
  }

  function wireModelFacing() {
    if (config.injectContextToModel && ctx.get('systemPrompt') !== undefined) {
      ctx.on('agent/created', ({ agent }) => {
        if (agent?.ctx?.systemPrompt === undefined) return
        const sessionId = agent.session?.header?.id ?? agent.id
        if (typeof sessionId !== 'string') return
        agent.ctx.systemPrompt.context({
          name: 'working-note:pinned',
          // Beside the working-directory context, ahead of the sandbox policy.
          order: 105,
          required: false,
          interpolate: false,
          text: () => host.service.contextText(sessionId),
        })
      })
    }
    if (ctx.get('tools') !== undefined) {
      import('./tool.mjs').then(({ registerWorkingNoteTool }) => registerWorkingNoteTool(ctx, host))
        .catch(error => log(`working-note: tool registration skipped: ${String(error)}`))
    }
  }
}

/**
 * Open the storage domain when one is mounted; otherwise keep the note in memory.
 * @param {object} ctx - Cordis context.
 * @param {(message: string) => void} log - diagnostic sink.
 */
async function openTable(ctx, log) {
  const facility = ctx.get('storageDomain')
  if (facility === undefined) return memoryTable()
  try {
    const domain = await facility.open(workingNoteDomainSpec())
    const table = domain.table('sessions')
    return {
      get: (key) => table.get(key),
      entries: () => table.entries(),
      put: (key, value) => table.put(key, value),
      delete: (key) => table.delete(key),
      get size() { return table.size },
      close: () => domain.close(),
    }
  } catch (error) {
    log(`working-note: storage domain unavailable (${String(error)}); keeping the note in memory`)
    return memoryTable()
  }
}
