# Implementation Plan — `dsh-working-note`

> Spec: [SPEC.md](SPEC.md) · Contracts: [CONTRACTS.md](CONTRACTS.md) · Approved mockup: [mockup.html](mockup.html) · API recipes: [references/dsh-plugin-recipes.md](references/dsh-plugin-recipes.md)

**Approach:** author the bundle as a **plain-ESM Node package** (`index.mjs`, `client.js`, `src/*.mjs`) — the same shape as the working `dsh-favicon-status` bundle already in this profile. Host services are reached through Cordis (`ctx.*`), never imported from `@deepseek-ai/*`, so no dependency list, no build step, and HMR-friendly iteration.

**Definition of done (whole epic):** the bundle installs into the `web` profile, the pin strip and sidebar tab render live data, cross-device sync works through the Host, `Kill all` stops only this session's ports, the `working_note` tool edits steps without touching user rows, archive/undo/purge follow the session, and every A/B-tier test passes.

---

## 0. Status board

| Phase | State | Gate |
|---|---|---|
| P0 Scaffold + storage + lifecycle | ✅ done | `tests/unit/{steps,context-text,service,package}.test.mjs`, `tests/host/boot.test.mjs` — 72 tests green |
| P1 Git/worktree inspector | ✅ verified | `tests/unit/git-numstat.test.mjs` + `tests/host/git.test.mjs` (real repo, real linked worktree, both deltas, non-repo fallback) |
| P2 Port monitor + Kill all | ✅ verified | `/proc`/attribution/kill unit tests + `tests/host/ports.test.mjs`: a real child carrying `DSH_SESSION_ID` is attributed to its Session only, killed on request, escalated to SIGKILL when it ignores SIGTERM, and the Harness pid is never attributed |
| P3 Host API + client UI (strip, tab, contextmenu/Alt+Shift+P) | 🟡 code verified, live render unconfirmed | Host side is covered by `tests/host/api.test.mjs` and the client bundle by `package.test.mjs`. The restarted Harness (2026-11-21 11:43) now serves this build and exposes the `working_note` tool, the session's working note holds the 6 steps this agent wrote through the tool, and `conversation.input.dock` reports no `working-note` occupant from the live Client — while the same `apply` registers the dock id, tab type, tab body/title and gesture against a stub. Either the page has not loaded the new bundle yet, or a host-side client-module registration is failing without reaching inspect. Diagnosis needs one browser check. |
| P4 Core slot + merged selection toolbar | ☐ **needs restart** | the additive action seat is a release-level change: it needs a DSH rebuild and a Host restart, which the running Host (started 2026-11-19) cannot pick up. Until then the plugin uses the shipped `contextmenu` + `Alt+Shift+P` pin, which needs no core change |
| P5 Model integration (tool + context) | ✅ implemented, ⚠ tool call untested live | `working_note` appears in the live Host tool catalog and is covered by `tests/host/boot.test.mjs`; no real model call has exercised it yet |
| P6 Install + live verification | 🟡 installed, UI unverified | `plugin_manager` → `application: applied`; the bundle is in the profile's `dsh.profile.bundles` and its routes answer 401 without a browser credential; the running Host is a static build whose `/plugins` route serves only installed rows, so a live UI probe needs a Harness restart. The client bundle activates cleanly against the real registration surface (stub-run of `apply` reports every registration, no error). C1–C6 and the UX review remain |

Each phase ends with: `node --test tests/` green, `plugin_manager` application `applied`, and this board updated.

---

## 1. File map

```text
dsh-working-note/
├── package.json                  # bundle + dsh.bundle/dsh.client, no deps
├── cordis.patch.yml              # row id: working-note (+ default config)
├── index.mjs                     # Host entry: apply(), Config, service, tool, routes, context
├── client.js                     # Client entry: __ModuleLoader__.load({ id, factory })
├── src/
│   ├── domain.mjs                # defineDomain spec + record schema (zod from dsh install)
│   ├── steps.mjs                 # pure step ops: add/dedupe/bullet-strip/toggle/move/remove/clear
│   ├── context-text.mjs          # pure: deterministic pinned-context renderer
│   ├── git.mjs                   # git inspector (ctx.subprocess argv only)
│   ├── ports/
│   │   ├── proc.mjs              # /proc parsers: stat, environ, fd, net/tcp*
│   │   ├── ss.mjs                # `ss -H -lptn` parser + fallback
│   │   ├── attribution.mjs       # session ownership tiers + self-protection guard
│   │   └── scan.mjs              # composition: active sessions -> tracked ports
│   ├── kill.mjs                  # SIGTERM -> SIGKILL with PID-reuse re-verification
│   ├── lifecycle.mjs             # archive/unarchive/purge/reconcile wiring
│   ├── api.mjs                   # /api/working-note/* routes + SSE hub
│   ├── tool.mjs                  # working_note defineTool (injected by index.mjs)
│   └── ui/                       # browser-only components (plain functions receiving h)
│       ├── strip.mjs             # Pin Strip (conversation.input.dock)
│       ├── tab.mjs               # Working Note tab (sidebar.right.pane.tab)
│       ├── selection.mjs         # contextmenu + Alt+Shift+P fallback
│       └── api-client.mjs        # fetch + EventSource wrapper (reconnect, abort)
├── locale/{en,vi,zh}.json        # meta.title/description + UI keys
├── icon.svg                      # original 36x36 artwork
├── README.md
├── references/dsh-plugin-recipes.md
├── SPEC.md · PLAN.md · CONTRACTS.md · mockup.html
└── tests/
    ├── unit/*.test.mjs           # A-tier (node --test, no runtime)
    ├── host/*.test.mjs           # B-tier (boot shipped Host composition)
    ├── mockup-smoke.mjs          # approved-interaction regression (playwright-core)
    └── cross-tab-smoke.mjs       # Host->Client sync leg (playwright-core)
```

---

## 2. Tasks

### P0 — Scaffold, storage, lifecycle (≈1 session)

| ID | Task | Notes |
|---|---|---|
| T0.1 | Write `package.json`, `cordis.patch.yml`, `index.mjs` skeleton, `locale/{en,vi,zh}.json` (`meta.title`/`meta.description` + UI keys), `icon.svg`, `README.md` | icon: one dominant "pin + checklist" subject, 36×36, flat fills (see verification checklist) |
| T0.2 | `src/domain.mjs` + open/close of `dsh_working_note` (`layout: 'per-record'`) | record shape → CONTRACTS §1 |
| T0.3 | `src/steps.mjs` pure operations + `tests/unit/steps.test.mjs` | dedupe, bullet strip, `preserveUserSteps` on replace, cap |
| T0.4 | Host service object `workingNote` registered as `ctx.reflect.provide('workingNote', svc)` so the tool/API/UI share one implementation | Single-operation rule from user-actions practice |
| T0.5 | `src/lifecycle.mjs`: `session/disposed`, `workspace/session-archived`, `workspace/session-unarchiving`, purge timer, startup reconcile (via `ctx.get('sessionQuery')` + `workspaceRegistry`) | B1 |
| T0.6 | Archive read-only enforcement in the service (mutations rejected when `archivedAt` set) | returns `workingNote/archived` |

### P1 — Git / worktree inspector (≈0.5 session)

| ID | Task | Notes |
|---|---|---|
| T1.1 | `src/git.mjs`: resolve cwd → `rev-parse --show-toplevel`, `--git-dir`, `--git-common-dir`, `symbolic-ref --short HEAD`, `merge-base` with base | argv only, `GIT_OPTIONAL_LOCKS=0`, bounded output, `timeoutMs` |
| T1.2 | `--numstat -z` parsing (binary `-`, renames) + untracked line counting (bounded) | `tests/unit/git-numstat.test.mjs` |
| T1.3 | Unborn-HEAD and non-repo fallbacks; cache per session with `gitTimeoutMs` | A5 |
| T1.4 | Refresh triggers: `working-directory/change`, debounced `tools/result` (800 ms), SSE-subscriber interval | no polling without a viewer |

### P2 — Port monitor + Kill all (≈1 session)

| ID | Task | Notes |
|---|---|---|
| T2.1 | `src/ports/proc.mjs`: parse `stat` (ppid/pgid/starttime), `environ` (`DSH_SESSION_ID`), `net/tcp*` hex, fd→socket inode | fixtures from this machine |
| T2.2 | `src/ports/ss.mjs`: primary source when `ss` exists, `/proc/net` fallback | |
| T2.3 | `src/ports/attribution.mjs`: tier 1 terminals → descendants, tier 2 `DSH_SESSION_ID`, tier 3 worktree-cwd (config-gated); protection guard | A6 |
| T2.4 | `src/ports/scan.mjs`: merge into tracked rows, keep stopped history, TTL prune, persist | |
| T2.5 | `src/kill.mjs`: re-verify before signal, `ctx.jobs.kill` for job-backed ports, SIGTERM → grace → SIGKILL, structured result | B4 |
| T2.6 | `killAllPorts` + single `killPort` exposed on the service | B3, B5 |
| T2.7 | macOS `lsof` adapter (best-effort) + `discoveryUnsupported` state for Windows/missing tools | §9.7 |

### P3 — Host API + Client UI (≈1.5 sessions)

| ID | Task | Notes |
|---|---|---|
| T3.1 | `src/api.mjs`: routes from SPEC §8.2, every one behind `ctx.connection.requestRejection`, 400/404/405 matrix, JSON errors | B6 |
| T3.2 | SSE hub: per-session subscriber sets, full-state frames, 15 s ping, close on abort/dispose | B7 |
| T3.3 | `src/ui/api-client.mjs`: EventSource with backoff reconnect; abort on unmount | |
| T3.4 | `src/ui/strip.mjs`: collapsed row (git pill → toggles scope + opens tab, port chips, two-press `Kill all`, steps pill, expand, pop-out) | mockup parity |
| T3.5 | Drawer: port rows (open/copy/kill, stopped state), step rows (toggle, inline edit, move, delete, `ai`/`you` tag), textarea bulk add with multi-line split, footer actions; drawer `max-height` + scroll, step clamp 2 lines | regression from mockup |
| T3.6 | `src/ui/tab.mjs` + `sidebarRightTabs` type (`keepMounted: true`) + guide entry; full-width layout from SPEC §7.3 | C1, C2 |
| T3.7 | Theme tokens only (`--dsw-alias-*`), light/dark, 390 px layout | A2 |
| T3.8 | Locale keys for every visible string (`workingNote` namespace) | |

### P4 — Core slot + merged selection (≈0.5 session)

| ID | Task | Files |
|---|---|---|
| T4.1 | Add additive `conversation.chat.text-interaction.actions` list slot (session scope) to `ui-chat`'s slot map, rendered inside the existing selection surface next to Quote | `packages/client/ui-chat/src/client/contract/slots.ts`, `ChatView.tsx` |
| T4.2 | Publish the selection surface to consumers (stable `{ trigger, dismiss, readText, clearSelection }`, re-rendered as `ChatView` already does) | `ChatView.tsx` |
| T4.3 | Refactor `message-quotes` Quote button to register as an action instead of a hard-coded element | `packages/session/message-quotes/src/client/*` |
| T4.4 | Working Note registers `📌 Pin note` + overflow (split into steps) action; applies to Quote selection **and** contextmenu trigger | `src/ui/selection.mjs` |
| T4.5 | Rebuild Web bundle, refresh page, confirm existing quote behaviour unchanged | C3 |

### P5 — Model integration (≈0.5 session)

| ID | Task | Notes |
|---|---|---|
| T5.1 | `src/tool.mjs`: `working_note` with actions `list/add_steps/set_steps/toggle_step/remove_step/clear_done`; bounded output; `presentCall` | CONTRACTS §4 |
| T5.2 | `preserveUserSteps` default true; reject `set_steps` that would drop user rows unless `preserve_user: false` | |
| T5.3 | `src/context-text.mjs` + `agent.ctx.systemPrompt.context` registration (agent scope, `interpolate: false`), gated by `injectContextToModel`, empty when nothing pending | A7, B8 |
| T5.4 | Context refreshes after tool/mutation events without waking the agent | context is read at next assembly |

### P6 — Install + verify (≈0.5 session)

| ID | Task | Notes |
|---|---|---|
| T6.1 | `plugin_manager install_bundle` → read `application`, then `cordis_inspect_query` for config row, service, tool, slot occupants | |
| T6.2 | Run C1–C6 from SPEC §11.3 with a scoped test repo + `node -e` listener; clean up every spawned process | |
| T6.3 | UI/UX expert review subagent; fix substantiated issues | |
| T6.4 | Replace `meta.detail` preview only if a real screenshot is obtainable; otherwise omit and say so | |

---

## 3. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `/proc` reading denied or slow on some systems | ports hidden | bound every read (<2 ms/file), skip `EACCES`, cap process walk (`maxScanProcesses`), fall back to `ss` |
| `ss` not installed | no ports on containers | `/proc/net/tcp*` + fd join is the primary parser; `ss` only enriches |
| Killing a PID reused by another process | data loss for unrelated work | start-time match + socket re-verification + host-ancestor guard (A6) |
| `Kill all` reaching the DSH host | the harness dies mid-work | tier-3 worktree attribution is opt-in by config; host PID/ancestors hard-blocked; two-press confirm; B5 asserts `:3080` alive |
| Context bloat / KV-cache churn | token cost | stable ordering, only `[ ]` steps + live ports, hard cap (e.g. 1.2 kB), `interpolate: false` |
| Core slot change breaks Quote | regression in DSH UI | T4.3 keeps Quote registered through the new seat; mockup-smoke + ui-chat/ui-conversation tests rerun |
| Archive purge racing Undo | data loss | purge timer started only after confirm (SPEC §5.2), B1 covers undo window |
| Client bundle edited without rebuild | stale UI | plain `client.js` (no build) + HMR receiver; document refresh requirement |

---

## 4. Open questions (defaults chosen — override any time)

1. **Branch delta:** show uncommitted by default, branch delta behind the pill toggle (default taken from mockup).
2. **Third attribution tier** (`scanWorktreeCwd`): on by default; it is the reason servers started from an external IDE terminal still appear.
3. **`reachable` hosts:** ports on `0.0.0.0` are shown with a "LAN" hint but their URL still uses `127.0.0.1`.
4. **Purge grace:** 30 s; only changed through config.
5. **Cap:** 200 steps per session, 100 port rows.
6. **Windows:** ports section disabled with an explanation (SPEC §9.7).

---

## 5. Verification matrix (what proves each requirement)

| Requirement (from SPEC §1) | Evidence |
|---|---|
| Persist across reloads & host restarts | B-tier `http.test.mjs` reopen; C1 reload |
| Sync across devices | `tests/cross-tab-smoke.mjs`; C1 two browsers |
| Clean up follows session | B-tier `lifecycle.test.mjs`; C5 archive → undo → purge |
| Worktree + added/deleted | A5 units; B2 temp worktree; C3 |
| Ports + Kill all | A6–A8 units; B3–B5; C2 |
| Steps by AI and by highlight | B8 tool; `mockup-smoke` selection flow; C4 |
| Theme/locale/390 px | A2 token lint; C6 |
| "Following DSH best practices" | recipes doc + C6 console clean + no primitives import |

---

## 6. Session log (append as work proceeds)

| Date | Phase | Outcome | Evidence |
|---|---|---|---|
| 2026-11-21 | Planning | SPEC frozen after mockup approval; PLAN + CONTRACTS + recipes written; mockup smoke suites green (35 + 4 checks) | `tests/mockup-smoke.mjs`, `tests/cross-tab-smoke.mjs` |
| 2026-11-21 | P0–P3 | Bundle authored as plain ESM: storage domain wrapper + memory fallback, service with durable-then-publish, steps/context/git/`/proc` parsers, attribution + kill guard, scanner, HTTP+SSE API, `working_note` tool, client bundle (pin strip, tab, contextmenu/`Alt+Shift+P` pin). 72 automated tests green (`node --test tests/unit/ tests/host/`). Fixed on the way: 404-vs-405 routing split, `/proc` IO default, agent-context scope. | test output above |
| 2026-11-21 | P6 (install) | `plugin_manager install_bundle` → `application: applied`, package linked into the `web` profile; `working_note` appears in the live Host tool catalog; `GET /api/working-note/state` and `POST /steps` answer 401 without a browser credential (the auth gate is live). | this session |
| 2026-11-21 | Verification (B-tier) | Added real-git and real-process integration tests: `tests/host/git.test.mjs` (worktree detection, uncommitted and branch deltas, non-repo fallback) and `tests/host/ports.test.mjs` (session attribution, Harness protection, SIGTERM kill, SIGKILL escalation). Suite is now **77 tests, all green** (`node --test tests/unit/ tests/host/`, ~20 s). Client `apply` wrapped so a registration failure prints `[working-note] activation failed` instead of staying silent. | test run above |
| 2026-11-21 | Round 2 | Docs and ergonomics only: README now states what each surface needs to run and what a missing dependency shows instead (restart after install, `/proc`, `git`); `npm test` / `npm run check` / `npm run test:ui` scripts added. Suite re-run: **77/77**. Live status unchanged — the Harness at `pid 188426` still predates the bundle, so the UI cannot be exercised from this side. | `npm test`, mockup suites |
| 2026-11-21 | Round 3 | Fixed a real correctness gap the cross-device scenario exposes: two clients patching the same note at once could silently drop one change (both read the same record before either write landed). `src/service.mjs` now serialises every write per Session through a chain that keeps call order, isolates rejected writes, and drops itself when drained. Proven by a new concurrency test plus a negative control showing the naive path loses a write. Suite: **78/78**. | `tests/unit/service.test.mjs` |
| 2026-11-21 | Round 4 | Harness restarted (`pid 284376`, 11:43) and it serves this build: `working_note` is in the live tool catalog, and tool calls **succeed** on the live service — `set_steps` persisted all 6 steps into the session's working note (the tool's own output shows them stored). Two small hardening changes: `resolveConfig` now ignores and reports undeclared patch fields instead of failing, and two tests pin the patch row against the code defaults. Suite: **82/82**. Live Client still shows no `working-note` occupant in `conversation.input.dock`, so the rendered UI is not yet confirmed. | inspect queries, tool results, `npm test` |
| 2026-11-21 | Round 5 — root cause | The user reported no visible change after restart. Diagnosed and fixed the real defect: `client.js` returned the plugin face from inside the factory instead of exporting it, so the client entry had no `apply` and the Loader left it inactive — no strip, no tab, while the Host half (tool, routes) worked. The face is now a module-level `const face` returned by the factory; `package.test.mjs` pins `Object.keys(exports) === ['apply','inject']`. The old test passed only because it read the return value directly. Suite: **82/82**. Fix reaches the browser on a page reload (client bundle files are re-read by the HMR watcher; no Harness restart needed). | user report, `node --check`, test run |
| 2026-11-21 | Round 6 — real activation fixes | The browser console from the user pinned two activation failures my stub had hidden: (1) `ctx.uiConversation` was read without being in `inject`, and (2) `locale.register` refused the second registration of the same namespace during an HMR replacement. Fixed by declaring `sidebarRight` + `uiConversation` in `inject` and opening the tab through the declared controller, registering the dictionaries as one map inside a guarded effect that treats "already has locale" as reuse, and adding a static audit test that compares every `ctx.<service>` the bundle reads with its `inject` list. The activation stub now throws exactly like Cordis on an undeclared property. A strict-context simulation of `apply` completes with no undeclared access. Suite: **83/83**. | user console, test run |
| 2026-11-21 | Round 7 — render crash | The strip mounted (activation fixed) but crashed the slot with `Cannot read properties of null (reading 'uncommitted')`: `PinStrip` computed `git.uncommitted` before its null guard. Fixed by an explicit "no frame yet → render nothing" branch (and a visible notice when the load itself failed, where a dead `? null : null` branch used to swallow it), plus defensive reads of `capabilities`/`ports`/`steps`/`ui` for a frame from another Host release. Added `tests/unit/render.test.mjs`, which renders both surfaces with null, full, partial and field-less snapshots; the suite is **83/83**. | user console, render test |
| 2026-11-21 | Verification gaps | Not yet verified: the rendered strip/tab in the browser (no image-capable model here; the running Host is a static build that predates the bundle, so the plugin only appears after a Harness restart), a real model call through `working_note`, archive → undo → purge against a live Session, the macOS tier, and the UI/UX review. | — |
- Fix: React error 185 (max update depth) in dock + sidebar tab — `store.snapshot` returned a new object per call; now cached in `store.current`, replaced only on publish; store kept cached after detach. Regression test in `tests/unit/render.test.mjs`. 85/85 pass. Awaiting user hard-reload confirmation.
- Fix: `Cannot read properties of null (reading 'uncommitted')` in PinStrip — git frames without `uncommitted`/`branchDelta` were dereferenced unguarded. Added `formatCounts` field validation + `statRow()` helper; strip and panel now degrade to `—`. Render test covers 4 null-counter shapes. 85/85 pass. Awaiting user hard-reload confirmation.
- Fix (root cause of the git pill never showing data): `createGitInspector` was never wired into the Host — `applyGit` had no caller, so every frame had `git: null` and the strip's git path was dead code. Wired into the `ports:proc` probe (one git inspection per scan tick over the Session's own checkout) and into `POST /refresh` via `host.refreshGit`; `host.log` exposed for source diagnostics. New `tests/host/git-wiring.test.mjs` fails if the wiring is removed. 87/87 pass. Requires a DSH restart (user restarts it themselves).
- Published to GitHub: https://github.com/ailuvu-art/dsh-working-note (public, MIT). Made the smoke harness and docs machine-independent (`tests/browser.mjs` resolves playwright/Chromium or skips; absolute paths removed); `private: true` dropped and `repository`/`homepage`/`bugs` added. A clean clone passes 87/87.
