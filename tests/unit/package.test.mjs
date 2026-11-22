/**
 * Integration tests that write the plugin files a client plugin cannot render
 * headlessly: the manifest, the locale dictionaries, and the browser bundle.
 *
 * The bundle is executed against a stub module loader, so a syntax error or a
 * missing export fails here instead of in the browser console.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

test('package.json declares the bundle and the client half', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.name, 'dsh-working-note')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['.'], './index.mjs')
  assert.equal(manifest.exports['./client'], './client.js')
  for (const file of ['index.mjs', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'src', 'locale/*.json', 'docs']) {
    if (file === 'docs') continue
    assert.ok(manifest.files.some(entry => entry === file || entry.startsWith(file)), `files misses ${file}`)
  }
})

test('the patch inserts one row with the documented defaults', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /id: working-note/)
  assert.match(patch, /name: dsh-working-note/)
  for (const field of ['portPollIntervalMs', 'gitTimeoutMs', 'killGraceMs', 'archiveGraceMs', 'stoppedPortTtlMs', 'scanWorktreeCwd', 'injectContextToModel', 'maxStepsPerSession']) {
    assert.ok(patch.includes(`${field}:`), `patch misses ${field}`)
  }
})

test('every locale carries the same keys and a usable meta block', () => {
  const locales = ['en', 'vi', 'zh']
  const dicts = locales.map(locale => JSON.parse(read(`locale/${locale}.json`)))
  const flatten = (object, prefix = '') => Object.entries(object).flatMap(([key, value]) => (
    value !== null && typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`]
  ))
  const base = flatten(dicts[0]).sort()
  for (const [index, dict] of dicts.entries()) {
    assert.ok(dict.meta.title.length > 0 && dict.meta.description.length > 40, `${locales[index]} meta is thin`)
    assert.deepEqual(flatten(dict).sort(), base, `${locales[index]} key set differs from en`)
  }
  assert.equal(dicts[0].meta.detail, undefined, 'no detail document is shipped')
})

test("the patch's config equals the resolved defaults, so a replaced row still validates", async () => {
  // A patch override replaces the row's whole config: a partial row would make
  // the plugin throw at activation. The shipped row therefore spells every field.
  const { resolveConfig, DEFAULT_CONFIG } = await import('../../index.mjs')
  const patch = read('cordis.patch.yml')
  const shipped = {}
  for (const line of patch.split('\n')) {
    const match = /^\s{8}([A-Za-z]+): (.+)$/.exec(line)
    if (match === null) continue
    const value = /^\d+$/.test(match[2]) ? Number(match[2]) : match[2] === 'true'
    shipped[match[1]] = value
  }
  assert.deepEqual(Object.keys(shipped).sort(), Object.keys(DEFAULT_CONFIG).sort(), 'every config field is shipped')
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) assert.equal(shipped[key], value, `${key} drifted from the code default`)
  assert.deepEqual(resolveConfig(shipped), resolveConfig({}))
})

test('the icon is self-contained and decode-safe', () => {
  const icon = read('icon.svg')
  assert.match(icon, /viewBox="0 0 36 36"/)
  for (const banned of ['<script', 'onload', '<foreignObject', '<text', '<image', 'http://www.w3.org/1999/xlink']) {
    assert.equal(icon.includes(banned), false, `icon contains ${banned}`)
  }
  assert.ok(Buffer.byteLength(icon) < 256 * 1024)
})

test('the browser bundle loads through the module loader and exports a plugin face', () => {
  const source = read('client.js')
  let registered
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  try {
    // The bundle is a plain script for the loader, not an ES module.
    // eslint-disable-next-line no-new-func
    new Function(source)()
  } finally {
    globalThis.window = previous
  }
  assert.equal(registered.id, 'dsh-working-note')
  const stubReact = {
    createElement: () => null, Fragment: 'Fragment',
    useCallback: fn => fn, useEffect: () => {}, useMemo: fn => fn(), useRef: value => ({ current: value }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
  const exported = registered.factory(id => {
    if (id === 'react') return stubReact
    throw new Error(`unexpected module request: ${id}`)
  })
  // The module system looks for `apply` on the module namespace: a face nested
  // inside something else would leave the Loader entry inactive with no error
  // worth reading, which is exactly the failure this assertion prevents.
  assert.deepEqual(Object.keys(exported).sort(), ['apply', 'inject'], 'apply is a module-level export')
  assert.deepEqual(exported.inject, ['slots', 'locale', 'sessions', 'sidebarRightTabs', 'sidebarRight', 'uiConversation'])
  assert.equal(typeof exported.apply, 'function')

  // Apply against a stub context: every registration must go through ctx.
  const registrations = []
  const disposers = []
  /** Snapshot of the declared inject list the face exposes. */
  const declared = [...exported.inject]
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', className: '', setAttribute() {}, remove() {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
  }
  const listeners = new Map()
  globalThis.window = {
    addEventListener: (type) => listeners.set(type, true),
    removeEventListener: (type) => listeners.delete(type),
    open: () => null,
  }
  try {
    // Every service the face names must exist on the context; a property the face
    // reads without declaring it throws exactly like Cordis does, so the test
    // catches an undeclared access before the browser does.
    const services = {
      locale: {
        register: (ns, dicts) => {
          const locales = typeof dicts === 'string' ? [dicts] : Object.keys(dicts)
          registrations.push(['locale', ns, locales.length])
          return () => {}
        },
        bind: () => key => key,
      },
      slots: {
        inject: (name) => { registrations.push(['slot', name]); return () => {} },
        register: (options) => { registrations.push(['register', options.name, options.id ?? options.key]); return () => {} },
      },
      sidebarRightTabs: { register: (definition) => { registrations.push(['tab-type', definition.id, definition.kind, definition.keepMounted]); return () => {} } },
      sidebarRight: { openTab: (kind) => { registrations.push(['open-tab', kind]) } },
      uiConversation: { interactions: { register: (definition) => { registrations.push(['interaction', definition.id]); return () => {} } } },
      effect: (fn) => { const result = fn(); if (typeof result === 'function') disposers.push(result); return () => {} },
    }
    const ctx = new Proxy(services, {
      get(target, key) {
        if (key in target) return Reflect.get(target, key)
        throw new Error(`cannot get property "${String(key)}" without inject`)
      },
    })
    exported.apply(ctx)
    assert.equal(listeners.has('keydown'), true, 'Alt+Shift+P listener installed')
  } catch (error) {
    delete globalThis.document
    delete globalThis.window
    throw error
  } finally {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        throw new Error(`a disposal failed: ${String(error)}`)
      }
    }
    delete globalThis.document
    delete globalThis.window
  }
  const kinds = registrations.map(row => row.slice(0, 2).join(':'))
  for (const expected of ['locale:workingNote', 'slot:conversation.input.dock', 'tab-type:dsh-working-note', 'slot:sidebar.right.pane.tab', 'interaction:working-note-pin']) {
    assert.ok(kinds.includes(expected), `missing registration ${expected}`)
  }
  assert.ok(disposers.length > 0, 'apply installs disposable effects')

  // Every key the components use exists in each catalog.
  const used = new Set([...read('client.js').matchAll(/t\('workingNote\.([a-zA-Z.]+)'/g)].map(match => match[1]))
  assert.ok(used.size > 40, `only ${used.size} keys used`)
  for (const locale of ['en', 'vi', 'zh']) {
    const dict = JSON.parse(read(`locale/${locale}.json`))
    const missing = [...used].filter(key => dict[key] === undefined)
    assert.deepEqual(missing, [], `${locale} misses ${missing.join(', ')}`)
  }
})

test('every ctx service the bundle reads is declared in inject', () => {
  // Cordis throws on a property without a matching `inject` entry, and the throw
  // happens at activation — the one failure mode that leaves an installed plugin
  // silently invisible. Read the face's own declaration and compare it with the
  // services the bundle body touches.
  const client = read('client.js')
  const declared = JSON.parse(/inject:\s*(\[[^\]]*\])/.exec(client)[1].replaceAll("'", '"'))
  const builtins = new Set(['get', 'inject', 'effect', 'on', 'emit', 'serial', 'waterfall', 'bail', 'provide', 'reflect'])
  const used = new Set([...client.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map(match => match[1]))
  const missing = [...used].filter(name => !builtins.has(name) && !declared.includes(name))
  assert.deepEqual(missing, [], `accessed without inject: ${missing.join(', ')}`)
})

test('the client half keeps to theme tokens and imports no Harness client package', () => {
  const client = read('client.js')
  assert.equal(/require\(\s*['"]@deepseek-ai\/dsh-client-/.test(client), false)
  assert.equal(/require\(\s*['"]@deepseek-ai\/dsh-client-ui-primitives['"]/.test(client), false)
  const colours = client.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g) ?? []
  assert.deepEqual(colours, [], `literal colours found: ${colours.join(', ')}`)
  assert.match(client, /--dsw-alias-/)
})

test('undeclared config fields are ignored and reported, never fatal', async () => {
  const { resolveConfig, FOREIGN_MARK } = await import('../../src/config.mjs')
  const resolved = resolveConfig({ props: [{ id: 'owner' }], injectContextToModel: false })
  assert.equal(resolved.injectContextToModel, false)
  assert.deepEqual(resolved[FOREIGN_MARK], ['props'])
  assert.equal(resolveConfig({})[FOREIGN_MARK], undefined, 'a clean row reports nothing')
})

test('a partial batch config still resolves to full defaults', async () => {
  // A field this plugin does not declare (a batch's `props`, say) must not leave
  // numeric fields undefined: resolveConfig fills every field independently.
  const { resolveConfig, DEFAULT_CONFIG } = await import('../../index.mjs')
  const resolved = resolveConfig({ props: ['x', { title: 'Missing' }] })
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.equal(resolved[key], value, `${key} lost its default`)
  }
})

test('the host entry exports the plugin contract', async () => {
  const entry = await import('../../index.mjs')
  assert.equal(entry.name, 'working-note')
  assert.deepEqual(entry.inject, ['storageDomain'])
  assert.equal(typeof entry.apply, 'function')
  assert.equal(typeof entry.resolveConfig, 'function')
})

test('no source file imports a Harness package at module top level except through ctx', () => {
  const files = ['src/host.mjs', 'src/service.mjs', 'src/api.mjs', 'src/tool.mjs', 'src/git.mjs']
  for (const file of files) {
    assert.ok(existsSync(resolve(root, file)), `${file} missing`)
    const text = read(file)
    const imports = [...text.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
    for (const specifier of imports) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `${file} imports ${specifier} at load time; read it from ctx instead`)
    }
  }
})
