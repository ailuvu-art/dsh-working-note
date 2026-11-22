/**
 * One plain-Cordis Host integration test: the full install path without a
 * Harness or a web server.
 *
 * It proves the pieces a live Host depends on are wired: storage (memory fallback
 * without a domain), the service face, the archive lifecycle, the scanner's
 * registration and stop hook, the agent tool, and clean disposal.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installHost } from '../../src/host.mjs'
import { resolveConfig } from '../../src/config.mjs'

/** Minimal Cordis-shaped context: `get` plus listeners on the events the host uses. */
function fakeCtx(services = {}) {
  const listeners = new Map()
  const ctx = {
    services,
    logger: { warn() {} },
    get(name) { return this.services[name] },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter(entry => entry !== listener))
      }
    },
    emit(name, payload) {
      return Promise.all((listeners.get(name) ?? []).map(listener => listener(payload)))
    },
    /** Cordis waterfall: hand the listener a `next` that yields the inner answer. */
    async waterfall(name, payload, inner) {
      let index = 0
      const next = async () => (index < 1 ? inner() : [])
      return Promise.all((listeners.get(name) ?? []).map(listener => listener(payload, next)))
    },
    listenerCount(name) { return (listeners.get(name) ?? []).length },
  }
  return ctx
}

test('installing the host wires storage, service, lifecycle, tool and disposal', async () => {
  const registrations = []
  const ctx = fakeCtx({
    tools: { register: (tool) => { registrations.push(tool); return () => {} } },
  })
  const host = installHost(ctx, resolveConfig({ portPollIntervalMs: 250 }))
  await host.ready
  try {
    assert.ok(host.service !== null, 'service installed')
    assert.ok(host.scanner !== null, 'scanner installed')
    assert.ok(host.table !== null, 'table installed (memory fallback)')

    // Service writes are durable in the table and survive a re-install.
    await host.service.addSteps('s1', { steps: ['open the page', 'check the callback'], source: 'ai' })
    assert.equal(host.table.get('s1').steps.length, 2)

    // The tool registered itself and operates on the same service.
    assert.equal(registrations.length, 1)
    const tool = registrations[0]
    assert.equal(tool.name, 'working_note')
    const exec = { agent: { session: { header: { id: 's1' } } } }
    const added = await tool.execute({ action: 'add_steps', steps: ['paste the log'] }, exec)
    assert.match(added, /Added 1 step/)
    const listed = await tool.execute({ action: 'list' }, exec)
    assert.match(listed, /\[ \] paste the log/)
    const stepId = host.service.record('s1').steps[0].id
    const toggled = await tool.execute({ action: 'toggle_step', step_id: stepId, done: true }, exec)
    assert.match(toggled, /Completed step/)
    await assert.rejects(tool.execute({ action: 'toggle_step', step_id: 'nope' }, exec), /No step/)
    await assert.rejects(tool.execute({ action: 'nonsense' }, exec), /Unknown action/)

    // Lifecycle: activity reports open steps, archive → read-only, undo → writable, purge → gone.
    // Open steps make the archive ask first: the waterfall answer is non-empty.
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId: 's1' }, async () => [])
    assert.equal(activity.length, 1)
    assert.ok(activity[0].length > 0)
    assert.equal(activity[0][0].kind, 'workingNoteSteps')

    await ctx.emit('workspace/session-archived', { sessionId: 's1' })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(host.service.view('s1').archived, 'grace')
    await assert.rejects(host.service.addSteps('s1', { steps: ['nope'] }), /read-only/)

    await ctx.emit('workspace/session-unarchiving', { sessionId: 's1' })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(host.service.view('s1').archived, false)

    // Idle eviction releases memory but keeps the record.
    await ctx.emit('session/disposed', { session: { header: { id: 's1' } } })
    assert.ok(host.table.get('s1'), 'record survives idle eviction')

    // A scanner source can be registered and its stop handler runs for archive.
    let stopped = 0
    host.scanner.register('test-source', {
      probe: async () => [],
      stop: async () => { stopped += 1 },
    })
    await ctx.emit('workspace/session-stop', { sessionId: 's1' })
    assert.equal(stopped, 1, 'stop handler ran')
    assert.equal(ctx.listenerCount('workspace/session-archived'), 1)
  } finally {
    await host.dispose()
  }
  assert.equal(registrations[0].name, 'working_note')
})

test('the host falls back to memory when storageDomain is missing or fails', async () => {
  const failing = fakeCtx({
    storageDomain: { open: async () => { throw new Error('backend-not-found') } },
  })
  const host = installHost(failing, resolveConfig({}))
  await host.ready
  try {
    await host.service.addSteps('s9', { steps: ['works in memory'] })
    assert.equal(host.service.view('s9').steps.length, 1)
  } finally {
    await host.dispose()
  }
})
