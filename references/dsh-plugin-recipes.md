# DeepSeek Harness — plugin recipes for `dsh-working-note`

Companion to [references/dsh-doc/plugin-development.md](references/dsh-doc/plugin-development.md). Every recipe here was copied from this checkout during the planning pass; **re-inspect before coding** (`cordis_inspect_query`, or the source path named beside each recipe), because these are the installed APIs, not a stable ABI.

---

## A. Minimal Host bundle (no build, no dependencies)

A Host-only bundle needs no `tsdown`, no `node_modules`, no install script — matching the installed `dsh-favicon-status` package in this profile. Git/Worker code lives in **plain `.mjs`**; the patch row and locales are JSON/YAML.

`package.json`:

```json
{
  "name": "dsh-working-note",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "license": "MIT",
  "exports": {
    ".": "./index.mjs",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.mjs", "src", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```

`cordis.patch.yml` (row id is also the entry the user edits in Settings):

```yaml
- insert:
    - id: working-note
      name: dsh-working-note
      config:
        portPollIntervalMs: 4000
        gitTimeoutMs: 5000
        killGraceMs: 1500
        archiveGraceMs: 30000
        stoppedPortTtlMs: 600000
        scanWorktreeCwd: true
        injectContextToModel: true
        maxStepsPerSession: 200
```

Host entry `index.mjs` — the function form with Schemastery `Config`:

```js
import z from '@deepseek-ai/schemastery'

export const name = 'working-note'
export const inject = ['tools', 'storageDomain', 'sessionQuery']   // optional services via ctx.get()
export const Config = z.object({
  portPollIntervalMs: z.number().default(4000),
  gitTimeoutMs: z.number().default(5000),
  killGraceMs: z.number().default(1500),
  archiveGraceMs: z.number().default(30000),
  stoppedPortTtlMs: z.number().default(600000),
  scanWorktreeCwd: z.boolean().default(true),
  injectContextToModel: z.boolean().default(true),
  maxStepsPerSession: z.number().default(200),
})

export function apply(ctx, config) {
  ctx.effect(() => /* every registration */ 0, 'working-note: …')
}
```

Package resolution: a bundle installed into the profile resolves `@deepseek-ai/*` from the dsh installation, so no dependency list is needed for shipped packages. Confirm with `apps/cli/package.json` in your DSH checkout.

---

## B. Session storage domain

Source: [`packages/storage/storage-domain/README.md`](../../deepseek-harness/packages/storage/storage-domain/README.md), example [`packages/workspace/workspace/src/spec.ts`](../../deepseek-harness/packages/workspace/workspace/src/spec.ts).

```js
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const workingNoteDomain = defineDomain({
  name: 'dsh_working_note',
  version: 1,
  layout: 'per-record',
  tables: { sessions: domainTable(sessionRecordSchema) },
})
```

Open once at `apply` and close on dispose; reads are synchronous, writes are durable before they resolve:

```js
let domain
const ready = ctx.storageDomain.open(workingNoteDomain).then(d => { domain = d; return d })
ctx.effect(() => async () => { await ready; await domain.close() }, 'working-note: storage')
```

Record shape is fixed in [CONTRACTS.md](CONTRACTS.md) §1.

---

## C. Authenticated HTTP + SSE route

Source: [`packages/host/open-in-app/src/index.ts:185-204`](../../deepseek-harness/packages/host/open-in-app/src/index.ts#L185-L204) (trust check + exact route) and `packages/host/open-in-app/tests/host-routes.spec.ts` (401/403/405 matrix).

```js
const rejected = (req, res) => {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

ctx.effect(() => ctx.webServer.register({
  kind: 'prefix',
  path: '/api/working-note',
  handler: async (req, res) => {
    if (rejected(req, res)) return
    const url = new URL(String(req.url), 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null) return sendJson(res, 400, { code: 'missing-session' })
    if (url.pathname.endsWith('/stream') && req.method === 'GET') return openStream(res, sessionId)
    // … other routes
  },
}), 'working-note: HTTP API')
```

SSE frames are `data: <json>\n\n`, plus a `: ping\n\n` comment every 15 s; `res.on('close', unsubscribe)`.

`ctx.connection` is available only in the web composition (`ctx.get('connection')`); without it the plugin keeps the tool + context working and the UI shows "host API unavailable".

---

## D. Lifecycle events (the "clean up follows session" seam)

Sources: [`packages/schedule/schedule/src/index.ts:323-341`](../../deepseek-harness/packages/schedule/schedule/src/index.ts#L323-L341) (both events in one effect), [`packages/jobs/jobs/src/archive-admission.ts`](../../deepseek-harness/packages/jobs/jobs/src/archive-admission.ts).

```js
ctx.effect(() => {
  const activity = ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const live = ports.listening(sessionId)
    const rest = await next()
    return live.length === 0 ? rest : [{ kind: 'workingNotePorts', items: live.map(p => ({ id: `:${p.port}`, label: p.processName })) }, ...rest]
  })
  const stop = ctx.on('workspace/session-stop', async ({ sessionId }) => { await ports.killAll(sessionId, { reason: 'session archived' }) })
  const archived = ctx.on('workspace/session-archived', ({ sessionId }) => { markArchived(sessionId); schedulePurge(sessionId) })
  const unarchiving = ctx.on('workspace/session-unarchiving', ({ sessionId }) => { cancelPurge(sessionId) })
  const disposed = ctx.on('session/disposed', ({ session }) => { releaseRuntime(session.header.id) })
  return () => { activity(); stop(); archived(); unarchiving(); disposed() }
}, 'working-note: lifecycle')
```

`session/disposed` fires for **idle eviction**, not deletion — release memory, never delete the record.

---

## E. Port ownership attribution

Sources: `/proc/<pid>/stat` (field 4 = ppid), `/proc/<pid>/environ` (NUL-separated; `DSH_SESSION_ID` is injected by `dsh-shell-env` for every shell call of that session), `ctx.terminals.list(agent)` (returns `pid` — [`packages/api/terminal-controller/src/types.ts:56`](../../deepseek-harness/packages/api/terminal-controller/src/types.ts#L56)), `ctx.jobs.list(sessionId)`, `ss -H -lptn` via `ctx.subprocess.spawn`.

Guard rules (all mandatory before any signal):
1. `pid > 1`, not `process.pid`, not `process.ppid`, not an ancestor of `process.pid`.
2. `/proc/<pid>/stat` start-time matches the start-time captured at scan (PID-reuse guard).
3. The process still owns the socket at kill time (re-read `/proc/net/tcp*` and the fd link).
4. Sending to a process group only when `pgid === pid` and `pgid !== process.pid`'s group.

---

## F. Client: inject + slot registration

Source: [`packages/session/message-quotes/src/client/index.ts:32-52`](../../deepseek-harness/packages/session/message-quotes/src/client/index.ts#L32-L52); sidebar tab type: [`packages/client/ui-sidebar-terminal/src/client/index.ts:71-96`](../../deepseek-harness/packages/client/ui-sidebar-terminal/src/client/index.ts#L71-L96).

```js
export const name = 'working-note'
export const inject = ['slots', 'locale', 'sessions']

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('workingNote', { en, vi, zh }), 'working-note: copy')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'working-note', order: 2, locale: 'workingNote',
  }, PinStrip))
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'dsh-working-note', kind: 'working-note', keepMounted: true, priority: 'extension',
    title: () => t('tab.title'),
    guide: [{ id: 'open', order: 30, title: () => t('guide.title'), description: () => t('guide.description') }],
  }), 'working-note: tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: 'dsh-working-note', locale: 'workingNote',
  }, WorkingNoteTab))
}
```

The bundle ships `client.js` as a plain module loader factory (`window.__ModuleLoader__.load({ id, factory(require) { … } })`) — the same shape as `dsh-favicon-status/client.js`.

---

## G. Selection actions (merged toolbar + fallback)

- **Merged (after the core slot lands):** register `conversation.chat.text-interaction.actions` under key `working-note`; the Chat selection surface renders `Quote` + every registered action side by side.
- **Fallback (works today):** [`packages/session/message-quotes/src/client/index.ts:35-46`](../../deepseek-harness/packages/session/message-quotes/src/client/index.ts#L35-L46) shows `ctx.uiConversation.interactions.register({ id, onInteraction })` with `trigger: 'selection' | 'contextmenu'`. Be aware: [`interaction-registry.ts:27-41`](../../deepseek-harness/packages/client/ui-conversation/src/client/conversation/interaction-registry.ts#L27-L41) **stops at the first handler that calls `open()`**, and `message-quotes` registers first — so in the fallback mode the plugin must use `trigger: 'contextmenu'` plus `Alt+Shift+P`, never `selection`.

---

## H. Model-facing tool + runtime context

Tool definition source: [`packages/core/tools/src/schema.ts:555`](../../deepseek-harness/packages/core/tools/src/schema.ts#L555) (`defineTool`), usage [`packages/jobs/tool-jobs/src/index.ts:432-543`](../../deepseek-harness/packages/jobs/tool-jobs/src/index.ts#L432-L543), schema rules in [references/dsh-doc/tool-design.md](references/dsh-doc/tool-design.md).

Context placement — follow `working-directory` and `sandbox-policy`, which register on the **agent's scope**, not globally:

```js
ctx.on('agent/created', ({ agent }) => {
  agent.ctx.systemPrompt.context({
    name: 'working-note:pinned',
    order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY') + 1,
    required: false,
    interpolate: false,
    text: ({ agent: subject }) => subject === undefined ? '' : renderWorkingNote(subject.session.header.id),
  })
})
```

(Central orders are enumerated in [`packages/core/system-prompt/src/index.ts:178-188`](../../deepseek-harness/packages/core/system-prompt/src/index.ts#L178-L188); an order between `WORKING_DIRECTORY` (100) and `SANDBOX_POLICY` (110) keeps it beside the directory context the model already reads.)

---

## I. Install, verify, roll back (profile facts)

- Profile: `DSH_PROFILE=web`, `DSH_PROFILE_DIR=$HOME/.dsh-repo/profiles/web`; existing bundles are `link:` dependencies (e.g. `dsh-favicon-status`).
- Install with `plugin_manager` `action: install_bundle`, `target: <path to this checkout>`. Do not hand-edit `$DSH_PROFILE_DIR/package.json` or its patch.
- Verify live state with `cordis_inspect_query`: `Config.listConfigs` (row id `working-note`), `Service.listService` (`workingNote`), `Tool.listTools` (`working_note`), `Slots.listSubTree` (`conversation.input.dock`, `sidebar.right.pane.tab`).
- Roll back with `plugin_manager` `set_plugin` `enabled: false`, or `remove_bundle`.
- Client code changes need a page refresh; core-slot changes need the Web bundle rebuilt.
