/**
 * The browser transport: authenticated HTTP + SSE over `ctx.webServer`.
 *
 * Every request passes `ctx.connection.requestRejection` first. Mutations
 * publish through one SSE stream per Session, so every open device converges on
 * the Host's durable record rather than on its own optimistic copy.
 */

import { WorkingNoteError, missingSession } from './errors.mjs'

export const BASE_PATH = '/api/working-note'
const PING_MS = 15_000
/** Paths that exist on other methods, answered with 405 instead of 404. */
const ROUTE_PATHS = Object.freeze([
  '/state',
  '/stream',
  '/refresh',
  '/steps',
  '/ports/kill',
  '/ports/kill-all',
  '/ports/stopped',
  '/ui',
])
const STEP_PATH = /^\/steps\/[^/]+$/
/** Sentinel: the handler already owns the response (an open SSE stream). */
export const STREAM_HANDLED = Symbol('stream-handled')

/**
 * Mount the routes.
 * @param {object} ctx - Cordis context with `webServer` and `connection`.
 * @param {object} host - installed host handle.
 * @returns {Promise<{ dispose: () => Promise<void>, closeStreams: (sessionId: string) => void }>}
 */
export async function installApi(ctx, host) {
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  const service = host.service
  /** @type {Map<string, Set<(text: string) => void>>} */
  const streams = new Map()
  /** @type {Map<string, () => void>} */
  const unsubscribes = new Map()

  const rejected = (req, res) => {
    const rejection = connection?.requestRejection?.(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.setHeader?.('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  const sendError = (res, error) => {
    if (error instanceof WorkingNoteError) {
      sendJson(res, error.status, { code: error.code, message: error.message })
      return true
    }
    sendJson(res, 500, { code: 'workingNote/internal', message: String(error?.message ?? error) })
    return true
  }

  const openStream = (res, sessionId) => {
    res.writeHead?.(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const write = (text) => { res.write(text) }
    let set = streams.get(sessionId)
    if (set === undefined) {
      set = new Set()
      streams.set(sessionId, set)
      unsubscribes.set(sessionId, service.subscribe(sessionId, (view) => {
        const frame = `data: ${JSON.stringify(view)}\n\n`
        for (const sink of [...(streams.get(sessionId) ?? [])]) {
          try {
            sink(frame)
          } catch {
            // A dropped socket unregisters through its own close handler.
          }
        }
      }))
    }
    set.add(write)
    write(`data: ${JSON.stringify(service.view(sessionId))}\n\n`)
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        clearInterval(ping)
      }
    }, PING_MS)
    ping.unref?.()
    void host.scanner?.watch(sessionId)
    const close = () => {
      clearInterval(ping)
      const current = streams.get(sessionId)
      if (current === undefined) return
      current.delete(write)
      if (current.size > 0) return
      streams.delete(sessionId)
      unsubscribes.get(sessionId)?.()
      unsubscribes.delete(sessionId)
      void host.scanner?.unwatch(sessionId)
    }
    res.on?.('close', close)
    res.on?.('error', close)
  }

  const readBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 256 * 1024) throw new WorkingNoteError('workingNote/body-too-large', 'Request body too large.', 413)
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new WorkingNoteError('workingNote/bad-json', 'Request body is not JSON.', 400)
    }
  }

  const sessionOf = (url, body) => {
    const sessionId = body?.sessionId ?? url.searchParams.get('sessionId') ?? undefined
    if (typeof sessionId !== 'string' || sessionId === '') throw missingSession()
    return sessionId
  }

  /**
   * Route one write.
   * @param {string} method - POST, PATCH or DELETE.
   * @param {string} rest - path after {@link BASE_PATH} ('' / '/refresh' / '/steps/:id' …).
   * @param {string} sessionId - validated Session id.
   * @param {object} body - parsed JSON body.
   * @returns the JSON value for the response.
   */
  /**
   * Route one write: the `method rest` pairs this module serves.
   * Keys are `${method} ${rest}` so a dispatch never re-tests two conditions.
   * @param {string} method - POST, PATCH or DELETE.
   * @param {string} rest - path after {@link BASE_PATH} ('' / '/refresh' / '/steps/:id' …).
   * @param {string} sessionId - validated Session id.
   * @param {object} body - parsed JSON body.
   * @returns the JSON value for the response.
   */
  const dispatch = async (method, rest, sessionId, body) => {
    const route = `${method} ${rest}`
    if (route === 'POST /refresh') {
      await host.refresh(sessionId)
      return service.view(sessionId)
    }
    if (route === 'POST /steps') {
      const list = Array.isArray(body.steps) ? body.steps : [body.steps].filter(value => typeof value === 'string')
      return service.addSteps(sessionId, { steps: list, source: 'user' })
    }
    if (route === 'DELETE /steps') return service.clearDone(sessionId)
    const stepMatch = /^PATCH \/steps\/([^/]+)$/.exec(route) ?? /^DELETE \/steps\/([^/]+)$/.exec(route)
    if (stepMatch !== null) {
      const stepId = decodeURIComponent(stepMatch[1])
      if (method === 'DELETE') return service.removeStep(sessionId, stepId)
      return service.updateStep(sessionId, stepId, {
        text: typeof body.text === 'string' ? body.text : undefined,
        done: typeof body.done === 'boolean' ? body.done : undefined,
        move: body.move === -1 || body.move === 1 ? body.move : undefined,
      })
    }
    if (route === 'POST /ports/kill') return host.killPort(sessionId, Number(body.port))
    if (route === 'POST /ports/kill-all') return host.killAllPorts(sessionId, 'killed from the Working Note')
    if (route === 'DELETE /ports/stopped') return service.clearStoppedPorts(sessionId)
    if (route === 'PATCH /ui') return service.setUi(sessionId, { expanded: body.expanded, gitScope: body.gitScope })
    throw new WorkingNoteError('workingNote/not-found', `No route ${route}.`, 404)
  }

  const handler = async (req, res) => {
    if (rejected(req, res)) return
    const url = new URL(String(req.url), 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    try {
      const rest = path.startsWith(BASE_PATH) ? path.slice(BASE_PATH.length) : path
      const known = ROUTE_PATHS.indexOf(rest) >= 0 || STEP_PATH.test(rest)
      if (!known) return sendJson(res, 404, { code: 'workingNote/not-found', message: 'No route for this working-note path.' })
      const isRead = method === 'GET' || method === 'HEAD'
      const isWrite = method === 'POST' || method === 'PATCH' || method === 'DELETE'
      if (isRead) {
        if (rest === '/stream') return openStream(res, sessionOf(url))
        if (rest === '/state') return sendJson(res, 200, service.view(sessionOf(url)))
      }
      if (isRead || !isWrite) {
        return sendJson(res, 405, { code: 'workingNote/method', message: `Method ${method} is not allowed on ${rest}.` })
      }
      const body = await readBody(req)
      return sendJson(res, 200, await dispatch(method, rest, sessionOf(url, body), body))
    } catch (error) {
      return sendError(res, error)
    }
  }

  const methodNotAllowed = (res, allow) => {
    res.setHeader?.("allow", allow)
    return sendJson(res, 405, { code: "workingNote/method", message: "Method not allowed on this path." })
  }

  const dispose = webServer?.register?.({ kind: 'prefix', path: BASE_PATH, handler }) ?? (() => {})

  return {
    async dispose() {
      for (const set of streams.values()) set.clear()
      streams.clear()
      for (const stop of unsubscribes.values()) stop()
      unsubscribes.clear()
      dispose()
    },
    closeStreams(sessionId) {
      unsubscribes.get(sessionId)?.()
      unsubscribes.delete(sessionId)
      streams.delete(sessionId)
    },
  }
}
