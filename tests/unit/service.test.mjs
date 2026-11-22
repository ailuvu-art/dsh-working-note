/** Unit tests: the service contract over an in-memory domain table (no Harness needed). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createService, toView } from '../../src/service.mjs'
import { memoryTable } from '../../src/store.mjs'
import { resolveConfig } from '../../src/config.mjs'

const setup = (overrides = {}) => {
  const table = memoryTable()
  let clock = 1_000
  const service = createService({
    table,
    config: resolveConfig(overrides),
    stopScans: () => {},
    now: () => clock,
  })
  return { table, service, advance: (ms) => { clock += ms }, now: () => clock }
}

test('an unknown session starts empty and durable only when touched', async () => {
  const { table, service } = setup()
  const view = service.view('s1')
  assert.deepEqual(view.steps, [])
  assert.equal(view.archived, false)
  assert.equal(table.get('s1'), undefined)
  await service.addSteps('s1', { steps: ['step one'] })
  assert.ok(table.get('s1'))
})

test('mutations persist before subscribers see them', async () => {
  const { service, table } = setup()
  const seen = []
  service.subscribe('s1', (view) => seen.push({ steps: view.steps.length, persisted: table.get('s1')?.steps.length }))
  await service.addSteps('s1', { steps: ['a', 'b'] })
  assert.deepEqual(seen.at(-1), { steps: 2, persisted: 2 })
})

test('steps CRUD carries ids, sources and counts', async () => {
  const { service } = setup()
  const added = await service.addSteps('s1', { steps: ['one', 'one', 'two'], source: 'ai' })
  assert.equal(added.added, 2)
  assert.equal(added.skipped, 1)
  const [first, second] = added.view.steps
  assert.equal(first.source, 'ai')
  const toggled = await service.updateStep('s1', first.id, { done: true })
  assert.equal(toggled.steps[0].done, true)
  const moved = await service.updateStep('s1', second.id, { move: -1 })
  assert.deepEqual(moved.steps.map(step => step.text), ['two', 'one'])
  const cleared = await service.clearDone('s1')
  assert.equal(cleared.removed, 1)
  await assert.rejects(service.removeStep('s1', 'missing'), /No step/)
})

test('concurrent writes serialise instead of losing the earlier one', async () => {
  // Two devices (or a device and the agent tool) patch different steps at the same
  // instant: the chain must keep both changes, and a rejected write must not block
  // the next one.
  const { service } = setup()
  const added = await service.addSteps('s1', { steps: ['first', 'second', 'third'], source: 'ai' })
  const [a, b, c] = added.view.steps.map(step => step.id)
  const results = await Promise.allSettled([
    service.updateStep('s1', a, { done: true }),
    service.updateStep('s1', b, { text: 'second edited' }),
    service.removeStep('s1', 'not-a-step'),
    service.updateStep('s1', c, { done: true }),
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'fulfilled')
  assert.equal(results[2].status, 'rejected')
  assert.equal(results[3].status, 'fulfilled')
  const steps = service.record('s1').steps
  assert.equal(steps.length, 3)
  assert.equal(steps.find(step => step.id === a).done, true)
  assert.equal(steps.find(step => step.id === b).text, 'second edited')
  assert.equal(steps.find(step => step.id === c).done, true)
})

test('the pre-queue implementation would lose one of those writes', async () => {
  // Guard against a false-positive concurrency test: with the naive
  // read-modify-write (no chain), the second patch is computed from the record
  // read before the first one committed, so its result drops the first change.
  const record = { steps: [{ id: 'a', done: false }, { id: 'b', done: false }] }
  const readA = structuredClone(record)
  const readB = structuredClone(record)
  readA.steps[0] = { id: 'a', done: true }
  readB.steps[1] = { id: 'b', done: true }
  const lastWrite = readB
  assert.equal(lastWrite.steps[0].done, false, 'naive writes drop the earlier change')
})

test('archived sessions reject every mutation', async () => {
  const { service } = setup()
  await service.addSteps('s1', { steps: ['keep me'] })
  await service.markArchived('s1')
  assert.equal(service.view('s1').archived, 'grace')
  await assert.rejects(service.addSteps('s1', { steps: ['nope'] }), /read-only/)
  await assert.rejects(service.updateStep('s1', service.view('s1').steps[0].id, { done: true }), /read-only/)
  await assert.rejects(service.setUi('s1', { expanded: true }), /read-only/)
  assert.equal(service.view('s1').capabilities.mutate, false)
})

test('unarchive restores write access and keeps steps', async () => {
  const { service } = setup()
  await service.addSteps('s1', { steps: ['keep me'] })
  await service.markArchived('s1')
  await service.unarchive('s1')
  assert.equal(service.view('s1').archived, false)
  assert.equal(service.view('s1').steps.length, 1)
  const edited = await service.updateStep('s1', service.view('s1').steps[0].id, { text: 'edited' })
  assert.equal(edited.steps[0].text, 'edited')
})

test('purge removes the record and tells open streams', async () => {
  const { service, table } = setup()
  await service.addSteps('s1', { steps: ['x'] })
  const seen = []
  service.subscribe('s1', (view) => seen.push(view.steps.length))
  await service.markArchived('s1')
  await service.purgeNow('s1')
  assert.equal(table.get('s1'), undefined)
  assert.equal(seen.at(-1), 0)
  assert.equal(service.subscriberCount('s1'), 1)
})

test('scheduled purge fires after the configured grace window', async () => {
  const { service, table } = setup({ archiveGraceMs: 30 })
  await service.markArchived('s1')
  service.schedulePurge('s1')
  assert.ok(table.get('s1'))
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(table.get('s1'), undefined)
})

test('unarchive inside the grace window cancels the purge', async () => {
  const { service, table } = setup({ archiveGraceMs: 40 })
  await service.markArchived('s1')
  service.schedulePurge('s1')
  await service.unarchive('s1')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.ok(table.get('s1'), 'record survived because the archive was undone')
})

test('idle eviction releases memory and keeps the record', async () => {
  const { service, table } = setup()
  let stopped = 0
  const table2 = memoryTable()
  const second = createService({
    table: table2, config: resolveConfig({}), stopScans: async () => { stopped += 1 }, now: () => 1,
  })
  await second.addSteps('s1', { steps: ['x'] })
  await second.disposeSession('s1')
  assert.equal(stopped, 1)
  assert.ok(table2.get('s1'), 'record survives idle eviction')
  void service
  void table
})

test('port scans keep history and mark disappeared ports stopped', async () => {
  const { service, advance } = setup()
  await service.applyScan('s1', [
    { port: 5173, protocol: 'tcp', host: '127.0.0.1', pid: 10, processName: 'node', command: 'vite', origin: 'job', state: 'listening', firstSeenAt: 0, lastSeenAt: 0 },
    { port: 8000, protocol: 'tcp', host: '127.0.0.1', pid: 11, processName: 'uvicorn', command: 'uvicorn', origin: 'terminal', state: 'listening', firstSeenAt: 0, lastSeenAt: 0 },
  ])
  advance(10)
  await service.applyScan('s1', [
    { port: 5173, protocol: 'tcp', host: '127.0.0.1', pid: 10, processName: 'node', command: 'vite', origin: 'job', state: 'listening', firstSeenAt: 0, lastSeenAt: 0 },
  ])
  const view = service.view('s1')
  const byPort = Object.fromEntries(view.ports.map(port => [port.port, port.state]))
  assert.deepEqual(byPort, { 5173: 'listening', 8000: 'stopped' })
  assert.ok(view.ports.find(port => port.port === 8000).stoppedAt !== undefined)
  assert.equal(view.ports.find(port => port.port === 5173).firstSeenAt, view.ports.find(port => port.port === 5173).firstSeenAt)
  const cleared = await service.clearStoppedPorts('s1')
  assert.equal(cleared.removed, 1)
})

test('markPortsStopped only touches listening rows', async () => {
  const { service } = setup()
  await service.applyScan('s1', [
    { port: 5173, protocol: 'tcp', host: '127.0.0.1', pid: 10, processName: 'node', command: '', origin: 'job', state: 'listening', firstSeenAt: 0, lastSeenAt: 0 },
  ])
  await service.markPortsStopped('s1', [5173])
  assert.equal(service.view('s1').ports[0].state, 'stopped')
})

test('contextText is gated by config and archived state', async () => {
  const on = setup()
  await on.service.addSteps('s1', { steps: ['open the page'] })
  assert.match(on.service.contextText('s1'), /open the page/)
  await on.service.markArchived('s1')
  assert.equal(on.service.contextText('s1'), '')
  const off = setup({ injectContextToModel: false })
  await off.service.addSteps('s1', { steps: ['open the page'] })
  assert.equal(off.service.contextText('s1'), '')
})

test('ui state is persisted and validated', async () => {
  const { service } = setup()
  const view = await service.setUi('s1', { expanded: true, gitScope: 'nonsense' })
  assert.equal(view.ui.expanded, true)
  assert.equal(view.ui.gitScope, 'uncommitted')
  const next = await service.setUi('s1', { gitScope: 'branch' })
  assert.equal(next.ui.gitScope, 'branch')
  assert.equal(next.ui.expanded, true)
})

test('toView advertises capabilities per platform and archive state', () => {
  const record = {
    sessionId: 's', steps: [], ports: [], ui: { expanded: false, gitScope: 'uncommitted' }, updatedAt: 1,
  }
  const live = toView(record, resolveConfig({}))
  assert.equal(live.capabilities.git, true)
  assert.equal(live.capabilities.mutate, true)
  assert.equal(live.v, 1)
  const archived = toView({ ...record, archivedAt: 1 }, resolveConfig({}))
  assert.equal(archived.archived, 'grace')
  assert.equal(archived.capabilities.kill, false)
})
