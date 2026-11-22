// Render the two surfaces with the real bundled components against the snapshots
// the Host can actually produce: null (loading), a full view, and a partial one.
//
// The browser crash that motivated this file was a null `view` read as if it were
// a snapshot; a component that throws here blanks its slot entry in the page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const clientPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../client.js')

let registered
globalThis.window = {
  __ModuleLoader__: { load: (entry) => { registered = entry } },
  addEventListener() {}, removeEventListener() {}, open() { return null }, location: { href: 'http://127.0.0.1:3080/' },
}
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ set id(v) {}, set textContent(v) {}, set className(v) {}, setAttribute() {}, remove() {} }),
  head: { appendChild() {} }, body: { appendChild() {} }, querySelectorAll: () => [],
}
// The bundle resolves `EventSource` lexically at call time, so the fake transport
// must exist before the client runs.
globalThis.__stream = null
globalThis.EventSource = class {
  constructor() { globalThis.__stream = this }
  close() { if (globalThis.__stream === this) globalThis.__stream = null }
}
new Function(readFileSync(clientPath, 'utf8'))()

// `useSyncExternalStore` replays the last frame the store published, so a test can
// re-render a surface after the fake transport pushes a view.
let replay = null
const pendingEffects = []
const flushEffects = () => { for (const fn of pendingEffects.splice(0)) fn() }
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
  useCallback: (fn) => fn, useMemo: (fn) => fn(), useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  // Mounted effects are deferred to `flushEffects()` so a test can render first and
  // then let the subscription open, which is the order React uses.
  useEffect: (fn) => { pendingEffects.push(fn) },
  useSyncExternalStore: (subscribe, snapshot) => { replay = snapshot; subscribe?.(() => {}); return snapshot() },
}
const captured = []

const services = {
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: {
    inject: (_name, callback) => { callback(); return () => {} },
    register: (options, component) => { captured.push({ name: options.name, id: options.id ?? options.key, component }); return () => {} },
  },
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: { openTab() {} },
  uiConversation: { interactions: { register: () => () => {} } },
  effect: (fn) => { const disposer = fn(); return () => {} },
}
const face = registered.factory((id) => { if (id === 'react') return React; throw new Error(id) })

let strip
let panel
const base = {
  sessionId: 's1',
  steps: [{ id: 'a', text: 'step one', done: false, source: 'ai', createdAt: 1, updatedAt: 1 }],
  ports: [{ port: 5173, protocol: 'tcp', host: '127.0.0.1', pid: 10, processName: 'node', command: 'vite', origin: 'job', state: 'listening', firstSeenAt: 1, lastSeenAt: 1 }],
  git: { cwd: '/repo', isGitRepo: true, isWorktree: true, branch: 'feat', uncommitted: { added: 1, deleted: 2, files: 1 }, updatedAt: 1 },
  ui: { expanded: false, gitScope: 'uncommitted' },
  archived: false,
  capabilities: { git: true, portDiscovery: 'linux', kill: true, mutate: true, injectContext: true },
  updatedAt: 1, v: 1,
}

// The slot component reads the store through a hook, so exercise the inner
// components directly by calling them with each snapshot shape.
const inner = (component, view) => component({ view, t: (k) => k, api: { setUi: async () => {} }, actions: {}, toast() {}, openTab() {} })

test('every surface renders the snapshots the Host can produce', () => {
  face.apply(services)
  strip = captured.find(entry => entry.id === 'working-note').component
  panel = captured.find(entry => entry.id === 'dsh-working-note').component
  assert.equal(typeof strip, 'function')
  assert.equal(typeof panel, 'function')
  // While the first frame is pending the surface renders without a view.
  assert.equal(typeof strip({ sessionId: 's1' }), 'object')
  assert.equal(typeof panel({ sessionId: 's1' }), 'object')
})

/**
 * The registered surfaces subscribe to a per-Session store: the dock entry is a
 * fragment wrapping the real `PinStrip` element, so a test has to render that
 * element itself, and frames arrive through the fake transport as in the page.
 * Both surfaces of one Session share one stream, which is what this exercises.
 */
const renderWith = (surface, sessionId, view) => {
  pendingEffects.length = 0
  surface({ sessionId })
  flushEffects() // React mounts the subscription after the first paint
  assert.notEqual(globalThis.__stream, null, `no stream for ${sessionId}`)
  globalThis.__stream.onmessage({ data: JSON.stringify({ ...view, sessionId }) })
  // React re-renders the surface now; the dock entry is a fragment around the real
  // PinStrip element, so render that element too.
  for (const child of surface({ sessionId })?.c ?? []) {
    if (typeof child.type === 'function') {
      child.type(child.props)
      flushEffects()
    }
  }
}

const shapes = [
  ['loading (null)', null],
  ['full view', base],
  ['partial view', { sessionId: 's1', steps: [], ports: [], git: null, archived: false }],
  ['frame without ui/capabilities', { sessionId: 's1', archived: false }],
  // A git block from another Host release: no counters at all, a branch delta
  // without one, a counter without `files`. All used to be read straight through.
  ['git without counters', { ...base, git: { ...base.git, uncommitted: null } }],
  ['git without uncommitted', { ...base, git: { cwd: '/repo', isGitRepo: true, isWorktree: false } }],
  ['git with counters missing files', { ...base, git: { ...base.git, uncommitted: { added: 1, deleted: 2 } } }],
  ['branch scope with null delta', { ...base, ui: { expanded: true, gitScope: 'branch' }, git: { ...base.git, branchDelta: null } }],
]

test('the strip and the panel render every frame shape', () => {
  const surfaceOf = (id) => captured.find(entry => entry.id === id).component
  for (const [index, [label, view]] of shapes.entries()) {
    // A fresh Session per shape, so no store is shared between cases.
    const sessionId = `frame-shape-${index}`
    assert.doesNotThrow(() => renderWith(surfaceOf('working-note'), sessionId, view), `strip threw on ${label}`)
    assert.doesNotThrow(() => renderWith(surfaceOf('dsh-working-note'), sessionId, view), `panel threw on ${label}`)
  }
})

// React error 185: useSyncExternalStore loops forever when getSnapshot returns a new
// object on every call. The snapshot must be referentially stable between frames.
test('store snapshot is referentially stable between publishes', () => {
  const seen = []
  React.useSyncExternalStore = (_subscribe, getSnapshot) => {
    const first = getSnapshot()
    seen.push([first, getSnapshot()])
    return first
  }
  for (const entry of captured.filter(e => e.id === 'working-note' || e.id === 'dsh-working-note')) {
    entry.component({ sessionId: 'stable-check' })
  }
  assert.ok(seen.length >= 2)
  for (const [a, b] of seen) assert.equal(a, b)
  assert.equal(seen[0][0], seen[1][0], 'surfaces of one Session share the snapshot')
})
