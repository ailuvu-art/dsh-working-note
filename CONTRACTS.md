# Contracts — `dsh-working-note` v1

Every shape here is consumed by at least two callers (Host service, Agent tool, HTTP/SSE, Client UI). Change one side → change all three and bump the storage `version` or API `v` field.

---

## 1. Storage record (`storageDomain` `dsh_working_note`, version 1, `layout: 'per-record'`)

Table `sessions`, key = `SessionId` string.

```ts
interface SessionRecord {
  sessionId: string
  steps: Step[]                 // ordered; cap 200
  ports: TrackedPort[]          // ordered by firstSeenAt; cap 100
  git?: GitSnapshot             // last successful inspection
  ui: {
    expanded: boolean           // cross-device drawer state
    gitScope: 'uncommitted' | 'branch'
  }
  archivedAt?: number           // epoch ms; present while the session is archived and inside the purge grace window
  updatedAt: number
}

interface Step {
  id: string                    // 's' + 8 base36 chars
  text: string                  // 1..2000 chars, single line, trimmed
  done: boolean
  source: 'user' | 'ai'         // 'user' = pinned from selection or typed by the user
  createdAt: number
  updatedAt: number
}

interface TrackedPort {
  port: number                  // 1..65535
  protocol: 'tcp' | 'tcp6'
  host: string                  // '127.0.0.1' | '0.0.0.0' | '::' | '::1'
  pid: number
  pgid?: number
  startTime?: string            // /proc/<pid>/stat field 22 — PID-reuse guard
  processName: string           // /proc/<pid>/comm
  command: string               // bounded to 240 chars
  origin: 'job' | 'terminal' | 'worktree'
  jobId?: string
  terminalId?: string
  state: 'listening' | 'stopped'
  firstSeenAt: number
  lastSeenAt: number
  stoppedAt?: number
}

interface GitSnapshot {
  cwd: string
  isGitRepo: boolean
  isWorktree: boolean
  repoRoot?: string
  branch?: string               // 'HEAD@<7 chars>' when detached
  baseRef?: string
  uncommitted: LineCounts
  branchDelta?: LineCounts
  updatedAt: number
}

interface LineCounts { added: number; deleted: number; files: number }
```

Defaults on first touch of a session: `steps: []`, `ports: []`, `ui: { expanded: false, gitScope: 'uncommitted' }`.
Rows are plain immutable data — replace via `put`/`update`, never mutate in place.

---

## 2. HTTP API (`/api/working-note`, web composition only)

All routes: `ctx.connection.requestRejection` first (401/403), then method check (405 + `Allow`), then body validation.

| Method | Path | Body / query | 200 response |
|---|---|---|---|
| `GET` | `/api/working-note/state` | `?sessionId=` | `SessionView` |
| `GET` | `/api/working-note/stream` | `?sessionId=` | `text/event-stream` of `SessionView` frames |
| `POST` | `/api/working-note/refresh` | `{ sessionId }` | `SessionView` |
| `POST` | `/api/working-note/steps` | `{ sessionId, steps: string[], source?: 'user' }` | `{ added: number, skipped: number, view: SessionView }` |
| `PATCH` | `/api/working-note/steps/:stepId` | `{ sessionId, text?, done?, move?: -1 \| 1 }` | `SessionView` |
| `DELETE` | `/api/working-note/steps/:stepId` | `?sessionId=` | `SessionView` |
| `DELETE` | `/api/working-note/steps` | `?sessionId=&clearDone=true` | `{ removed: number, view: SessionView }` |
| `POST` | `/api/working-note/ports/kill` | `{ sessionId, port, pid }` | `KillResult` |
| `POST` | `/api/working-note/ports/kill-all` | `{ sessionId }` | `KillResult` |
| `DELETE` | `/api/working-note/ports/stopped` | `?sessionId=` | `{ removed: number, view: SessionView }` |
| `PATCH` | `/api/working-note/ui` | `{ sessionId, expanded?, gitScope? }` | `SessionView` |

```ts
interface SessionView {
  v: 1
  sessionId: string
  steps: Step[]
  ports: TrackedPort[]          // includes stopped history
  git: GitSnapshot | null
  ui: { expanded: boolean; gitScope: 'uncommitted' | 'branch' }
  archived: false | 'grace' | 'purged'
  capabilities: {
    git: boolean
    portDiscovery: 'linux' | 'macos-lsof' | 'unsupported'
    kill: boolean               // false on unsupported portDiscovery or archived
    mutate: boolean             // false when archived === 'grace'
  }
  updatedAt: number
}

type KillResult = {
  killed: { port: number; pid: number }[]
  alreadyStopped: { port: number }[]
  failed: { port: number; pid: number; reason: string }[]   // 'protected' | 'pid-reused' | 'not-owned' | 'signal-failed'
  view: SessionView
}
```

`SessionView` is the **only** payload shape: REST one-shot reads and SSE frames carry the same object, so the Client has one decoder (`src/ui/api-client.mjs`).

Error bodies: `{ code: string, message: string }`

| code | status | when |
|---|---|---|
| `workingNote/missing-session` | 400 | no/invalid `sessionId` |
| `workingNote/unknown-session` | 404 | session id not known to persistence |
| `workingNote/archived` | 409 | mutation while `archived === 'grace'` |
| `workingNote/unknown-step` | 404 | step id absent |
| `workingNote/limit` | 409 | step/port cap reached |
| `workingNote/port-not-owned` | 409 | kill target is not attributed to this session |
| `workingNote/protected` | 403 | target is the DSH host or an ancestor |
| `workingNote/unsupported` | 501 | kill/discovery not available on this platform |

---

## 3. Host service (`ctx.workingNote`)

One implementation, two callers (UI routes and the agent tool).

```ts
interface WorkingNoteService {
  view(sessionId: SessionId): Promise<SessionView>
  subscribe(sessionId: SessionId, listener: (view: SessionView) => void): () => void
  refresh(sessionId: SessionId): Promise<SessionView>

  addSteps(sessionId: SessionId, input: { steps: string[]; source: 'user' | 'ai' }): Promise<{ added: number; skipped: number; view: SessionView }>
  updateStep(sessionId: SessionId, stepId: string, patch: { text?: string; done?: boolean; move?: -1 | 1 }): Promise<SessionView>
  removeStep(sessionId: SessionId, stepId: string): Promise<SessionView>
  clearDone(sessionId: SessionId): Promise<{ removed: number; view: SessionView }>
  replaceSteps(sessionId: SessionId, input: { steps: string[]; source: 'ai'; preserveUserSteps: boolean }): Promise<{ replaced: number; keptUser: number; view: SessionView }>

  killPort(sessionId: SessionId, port: number, pid: number): Promise<KillResult>
  killAllPorts(sessionId: SessionId, options?: { reason?: string }): Promise<KillResult>
  clearStoppedPorts(sessionId: SessionId): Promise<{ removed: number; view: SessionView }>

  setUi(sessionId: SessionId, patch: { expanded?: boolean; gitScope?: 'uncommitted' | 'branch' }): Promise<SessionView>
  contextText(sessionId: SessionId): string          // '' when nothing worth sending
  disposeSession(sessionId: SessionId): Promise<void> // idempotent; releases watchers
}
```

Invariants:
- Every mutating method rejects with `workingNote/archived` when the record is archived.
- Every mutating method persists **before** notifying subscribers (durable-then-broadcast, matching `storageDomain`).
- `killAllPorts` never signals the host process or its ancestors (CONTRACTS §7).
- `disposeSession` releases memory only; the record survives.

---

## 4. Agent tool `working_note`

```ts
{
  name: 'working_note',
  description:
    'Maintain this session’s pinned working note: hands-on steps the user must perform and the ports opened for manual testing. '
    + 'Use it to record manual/QA steps you ask the human to do, and to check what they already completed. '
    + 'Steps the user pinned are tagged "user" and are never removed by set_steps unless preserve_user is false.',
  parameters: {
    action: { type: 'string', required: true, enum: ['list', 'add_steps', 'set_steps', 'toggle_step', 'remove_step', 'clear_done'] },
    steps:  { type: 'string[]', description: 'With add_steps/set_steps: one entry per step, in display order. Blank entries and duplicates are skipped.' },
    step_id:{ type: 'string', description: 'With toggle_step/remove_step: the id returned by list.' },
    done:   { type: 'boolean', description: 'With toggle_step: the target state. Omit to invert.' },
    preserve_user: { type: 'boolean', description: 'With set_steps: keep steps the user pinned, replacing only agent steps. Defaults to true.' },
  },
  output: {
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        steps: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true }, text: { type: 'string', required: true },
          done: { type: 'boolean', required: true }, source: { type: 'string', required: true, enum: ['user', 'ai'] } } } },
        ports: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          port: { type: 'integer', required: true }, processName: { type: 'string', required: true },
          origin: { type: 'string', required: true } } } },
        git: { type: 'object', additionalProperties: false, properties: {
          branch: { type: 'string' }, isWorktree: { type: 'boolean' },
          added: { type: 'integer' }, deleted: { type: 'integer' } } },
        note: { type: 'string', required: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: renderToolText(value) }],
  },
  presentCall: args => `Working note: ${args.action}`,
}
```

`renderToolText` is the bounded, human-readable summary the model reads: step list with `[x]`/`[ ]` and `(user)` markers, live ports, one git line. No raw JSON in the model-visible text.

---

## 5. Pinned runtime context (`systemPrompt.context`)

Name `working-note:pinned`, order `getContextOrder('WORKING_DIRECTORY') + 1`, `interpolate: false`, registered on `agent.ctx` from `agent/created`.

Emitted only when `injectContextToModel` and the session has ≥1 incomplete step **or** ≥1 listening port. Deterministic ordering (steps in list order, ports by number). Hard cap 1200 chars; overflow line: `… (+N more steps)`.

```text
[Pinned working note — hands-on state for this session; not a new instruction]
Worktree: dsh-6b1f02c4-9a3e (linked) · uncommitted +142/−38
Open ports: :5173 (node, job), :8000 (uvicorn, job)
Steps (2 open / 4):
- [x] Open http://127.0.0.1:5173/login and click Continue with GitHub.
- [ ] Reload the login page and retry after the cookie fix. (user)
```

Rules: no user text is re-interpreted (no interpolation, no markdown rendering), and the block never appears for a session whose record is archived.

---

## 6. Client contract

- **Namespace:** `workingNote` (`ctx.locale.register`), keys in `locale/*.json`; every visible string comes from there (no inline English in components).
- **Standard props used:** `sessionId`, `useSession`, `useProjection` (only where a projection exists), `useAccess` for `session/prompt` when inserting a summary into the composer.
- **Theming:** only `--dsw-alias-*` / `--dsw-specific-sidebar-fill`; enforced by the theme-token lint in `tests/unit/package.test.mjs`.
- **No imports** of `@deepseek-ai/dsh-client-*` packages from `client.js` (enforced by the same test); React comes from the module table.
- **Registration points:**

| Surface | Registration |
|---|---|
| Pin strip | `conversation.input.dock`, `id: 'working-note'`, `order: 2` |
| Tab body | `sidebar.right.pane.tab`, `key: 'dsh-working-note'` |
| Tab type | `ctx.sidebarRightTabs.register({ id: 'dsh-working-note', kind: 'working-note', keepMounted: true, priority: 'extension', title, guide: [ … ] })` |
| Selection fallback | `ctx.uiConversation.interactions.register({ id: 'working-note-pin', onInteraction })` with `trigger: 'contextmenu'`, plus `Alt+Shift+P` |
| Merged selection action (after P4) | `conversation.chat.text-interaction.actions`, `key: 'dsh-working-note'` |

- **Keyboard:** `Alt+Shift+P` pins the current selection in the Chat flow; `Escape` dismisses any open Working Note surface.
- **Empty/hidden states:** strip renders nothing when there is no git repo, no tracked port and no step; tab shows an empty-state card explaining the three capabilities.

---

## 7. Kill safety contract (normative)

A process may be signalled only when **all** hold:

1. `pid > 1`, `pid !== process.pid`, `pid !== process.ppid`.
2. `pid` is not an ancestor of `process.pid` (walk `/proc/<pid>/stat` ppid chain of the host).
3. The port row still attributes to this `sessionId` under §E attribution tiers.
4. `/proc/<pid>/stat` start-time equals the value stored at scan time.
5. The process still owns a socket in `LISTEN` on that port (re-read `/proc/net/tcp*` + `fd`).
6. Group signalling only when `pgid === pid` and `pgid !== process.pid`'s group.

Order: `ctx.jobs.kill(jobId)` for job-backed ports → `SIGTERM` → wait `killGraceMs` → re-run 4–5 → `SIGKILL`. Failures are reported per port in `KillResult.failed`, never silently swallowed.
