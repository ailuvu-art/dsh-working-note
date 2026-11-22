/**
 * HTTP + SSE contract over the real route handler (CONTRACTS §2).
 *
 * The handler is called with Node-shaped request/response doubles, so this test
 * covers authentication gating, the status/code matrix, the durable round trip,
 * and the SSE fan-out without a listening socket.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { installHost } from '../../src/host.mjs'
import { resolveConfig } from '../../src/config.mjs'

function fakeCtx(services = {}) {
  const listeners = new Map()
  return {
    services,
    logger: { warn() {} },
    get(name) { return this.services[name] },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => listeners.set(name, (listeners.get(name) ?? []).filter(entry => entry !== listener))
    },
    emit(name, payload) { return Promise.all((listeners.get(name) ?? []).map(listener => listener(payload))) },
  }
}

/** A response double that can also behave as an open SSE stream. */
function responseDouble() {
  const chunks = []
  return {
    statusCode: 200,
    headers: {},
    ended: false,
    chunks,
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers) },
    write(chunk) { chunks.push(String(chunk)); return true },
    end(chunk) { if (chunk !== undefined) chunks.push(String(chunk)); this.ended = true },
    on() {},
    json() { return JSON.parse(chunks.join('')) },
    text() { return chunks.join('') },
    frames() {
      return chunks
        .join('')
        .split('\n\n')
        .filter(frame => frame.startsWith('data: '))
        .map(frame => JSON.parse(frame.slice(6)))
    },
  }
}

/** One installed host with its API route mounted on a recording server double. */
async function harness({ rejectStatus } = {}) {
  const routes = []
  const services = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => rejectStatus },
  }
  const ctx = fakeCtx(services)
  const host = installHost(ctx, resolveConfig({ portPollIntervalMs: 250, archiveGraceMs: 5 }))
  await host.ready
  const route = routes.find(entry => entry.path === '/api/working-note')
  assert.ok(route, 'API route mounted')

  /**
   * Send one request through the mounted handler.
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @param {string} [raw] - a raw body that replaces `body` (malformed JSON tests).
   */
  const request = async (method, path, body, raw) => {
    const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body)
    const stream = Readable.from(payload === undefined ? [] : [Buffer.from(payload)])
    stream.method = method
    stream.url = path
    stream.headers = {}
    const response = responseDouble()
    await route.handler(stream, response)
    return response
  }

  return { host, request, ctx }
}

test('every route is authenticated before it is read', async () => {
  const { host, request } = await harness({ rejectStatus: 401 })
  try {
    assert.equal((await request('GET', '/api/working-note/state?sessionId=s1')).statusCode, 401)
    assert.equal((await request('POST', '/api/working-note/steps', { sessionId: 's1', steps: ['x'] })).statusCode, 401)
  } finally {
    await host.dispose()
  }
})

test('state, steps, updates and clear-done round-trip durably', async () => {
  const { host, request } = await harness()
  try {
    const empty = await request('GET', '/api/working-note/state?sessionId=s1')
    assert.equal(empty.statusCode, 200)
    assert.deepEqual(empty.json().steps, [])
    assert.equal(empty.json().v, 1)
    assert.equal(empty.json().capabilities.mutate, true)

    const missing = await request('GET', '/api/working-note/state')
    assert.equal(missing.statusCode, 400)
    assert.equal(missing.json().code, 'workingNote/missing-session')

    const added = await request('POST', '/api/working-note/steps', {
      sessionId: 's1', steps: ['open the login page', '- run the e2e suite', 'open the login page'],
    })
    assert.equal(added.statusCode, 200)
    assert.equal(added.json().added, 2)
    assert.equal(added.json().skipped, 1)
    assert.equal(added.json().view.steps.length, 2)
    const [first, second] = added.json().view.steps

    const toggled = await request('PATCH', `/api/working-note/steps/${first.id}`, { sessionId: 's1', done: true })
    assert.equal(toggled.json().steps[0].done, true)

    const moved = await request('PATCH', `/api/working-note/steps/${second.id}`, {
      sessionId: 's1', move: -1, text: 'run the e2e suite first',
    })
    assert.deepEqual(moved.json().steps.map(step => step.text), ['run the e2e suite first', 'open the login page'])

    const unknown = await request('PATCH', '/api/working-note/steps/nope', { sessionId: 's1', done: true })
    assert.equal(unknown.statusCode, 404)
    assert.equal(unknown.json().code, 'workingNote/unknown-step')

    const removed = await request('DELETE', `/api/working-note/steps/${first.id}?sessionId=s1`)
    assert.equal(removed.json().steps.length, 1)

    const cleared = await request('DELETE', '/api/working-note/steps?sessionId=s1')
    assert.equal(cleared.statusCode, 200)
    assert.equal(typeof cleared.json().removed, 'number')

    const ui = await request('PATCH', '/api/working-note/ui', { sessionId: 's1', expanded: true, gitScope: 'branch' })
    assert.equal(ui.json().ui.expanded, true)
    assert.equal(ui.json().ui.gitScope, 'branch')
  } finally {
    await host.dispose()
  }
})

test('method and body failures use their documented codes', async () => {
  const { host, request } = await harness()
  try {
    // PUT is not a method this module serves at all: known path, wrong verb.
    const wrongMethod = await request('PUT', '/api/working-note/refresh', { sessionId: 's1' })
    assert.equal(wrongMethod.statusCode, 405)
    assert.equal(wrongMethod.json().code, 'workingNote/method')
    const notFound = await request('POST', '/api/working-note/nope', { sessionId: 's1' })
    assert.equal(notFound.statusCode, 404)
    assert.equal(notFound.json().code, 'workingNote/not-found')
    const malformed = await request('POST', '/api/working-note/steps', undefined, '{not json')
    assert.equal(malformed.statusCode, 400)
    assert.equal(malformed.json().code, 'workingNote/bad-json')
  } finally {
    await host.dispose()
  }
})

test('manual refresh runs the registered scan sources before answering', async () => {
  const { host, request } = await harness()
  try {
    let scans = 0
    host.scanner.register('test-source', {
      probe: async () => { scans += 1; return [] },
      stop: async () => {},
    })
    const refreshed = await request('POST', '/api/working-note/refresh', { sessionId: 's1' })
    assert.equal(refreshed.statusCode, 200)
    assert.ok(scans >= 1)
  } finally {
    await host.dispose()
  }
})

test('the SSE stream sends the current view and then every committed change', async () => {
  const { host, request, ctx } = await harness()
  try {
    const stream = await request('GET', '/api/working-note/stream?sessionId=live')
    assert.equal(stream.statusCode, 200)
    assert.match(stream.headers['content-type'], /text\/event-stream/)
    assert.equal(stream.frames()[0].sessionId, 'live')

    await host.service.addSteps('live', { steps: ['watched step'] })
    const update = stream.frames().at(-1)
    assert.equal(update.steps.length, 1)
    assert.equal(update.steps[0].text, 'watched step')

    await ctx.emit('workspace/session-archived', { sessionId: 'live' })
    // Archive work runs in the background: wait for the read-only frame to arrive.
    for (let i = 0; i < 50 && stream.frames().at(-1).archived === false; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const archived = stream.frames().at(-1)
    assert.equal(archived.archived, 'grace')
  } finally {
    await host.dispose()
  }
})

test('kill endpoints refuse an unknown port and an unsupported platform', async () => {
  const { host, request } = await harness()
  try {
    const unknown = await request('POST', '/api/working-note/ports/kill', { sessionId: 's1', port: 4242 })
    assert.ok([404, 501].includes(unknown.statusCode), `unexpected ${unknown.statusCode}`)
    const all = await request('POST', '/api/working-note/ports/kill-all', { sessionId: 's1' })
    assert.equal(all.statusCode, 200)
    assert.deepEqual(all.json().killed, [])
    assert.deepEqual(all.json().failed, [])
    assert.equal(all.json().view.sessionId, 's1')
  } finally {
    await host.dispose()
  }
})
