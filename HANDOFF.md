# Handoff — continue `dsh-working-note` on another machine

> Read this first, then [PLAN.md](PLAN.md) (status board + session log), [SPEC.md](SPEC.md) (frozen behaviour), [CONTRACTS.md](CONTRACTS.md) (wire + service contracts).
> Everything below is either **verified** (with the command or file that proves it) or explicitly marked **assumed / unverified**. Do not upgrade an assumption to a fact without a test.

- Repo: <https://github.com/ailuvu-art/dsh-working-note> (public, MIT), branch `main`.
- It is a **DeepSeek Harness (DSH) plugin bundle**: plain ESM, no build step, no runtime dependencies.

---

## 1. What the plugin is

Pins the session's working context above the chat composer and syncs it to every connected device.

| Surface | Slot / API | State |
|---|---|---|
| Pin strip (worktree, branch, +/− lines, port chips, `Kill all`, steps pill) | `conversation.input.dock`, id `working-note` | built |
| Full panel (git card, ports table, steps list) | `sidebar.right.pane.tab` + `.title`, key `dsh-working-note`; tab type `working-note` | built |
| Agent tool `working_note` (`list`, `add_steps`, `set_steps`, `toggle_step`, `remove_step`, `clear_done`) | `ctx.tools` | built, works live |
| Model context `working-note:pinned` | `agent.ctx.systemPrompt.context` | built |
| Pin highlighted chat text | `uiConversation.interactions` (`contextmenu` trigger) + `Alt+Shift+P` | built |
| Pin via the **selection toolbar next to Quote** | `conversation.chat.text-interaction` (keyed by plugin id) | **not built — see §5 P4** |

---

## 2. Get it running on the new machine

```bash
# 1. clone
git clone https://github.com/ailuvu-art/dsh-working-note.git
cd dsh-working-note

# 2. sanity check without any Harness
npm test        # 87 tests, ~20 s: tests/unit + tests/host
npm run check   # node --check on both entry points

# 3. inspect the wireframe (optional, needs a Chromium; skips cleanly without one)
npm run test:ui
```

Then install into the Harness you are running:

```text
plugin_manager action: install_bundle   target: <absolute path to the clone>
```

**Restart the Harness afterwards.** The Host half (`index.mjs`, `src/*.mjs`) is only loaded at startup; changing it without a restart is the single most common reason "nothing happens". Client-only changes (`client.js`, `locale/*.json`) reach the browser on a hard reload (**Ctrl+Shift+R**) and do not need a restart.

Verified: `npm test` on a fresh clone of `main` → 87/87 pass; `plugin_manager install_bundle` → `application: applied`.

Requirements: Linux for port discovery (`/proc`), `git` on the Host for the worktree facts, and a DSH build that exposes `ui-conversation`, `ui-sidebar-right`, `client-locale` (declared in `package.json` → `dsh.client.inject`).

---

## 3. What is done (verified)

| Area | Evidence |
|---|---|
| Storage on `ctx.storageDomain` (`dsh_working_note`, per-record, zod at the boundary) with memory fallback | `tests/unit/service.test.mjs` |
| Per-session write queue — concurrent writes from two devices never lose a change | `tests/unit/service.test.mjs` (plus a negative control proving the naive path loses one) |
| Auth on every route (`ctx.connection.requestRejection`), 400/404/405 matrix, SSE stream | `tests/host/api.test.mjs` |
| Git: worktree detection, uncommitted + branch deltas, non-repo fallback | `tests/host/git.test.mjs`, `tests/unit/git-numstat.test.mjs` (real `git`) |
| Git is wired into the scan loop (this was broken; see §4) | `tests/host/git-wiring.test.mjs` — fails if the wiring is removed |
| Ports: `/proc` scan, attribution (terminal → `DSH_SESSION_ID` → worktree cwd), never attributes the Harness itself | `tests/unit/{proc,attribution}.test.mjs`, `tests/host/ports.test.mjs` |
| Kill guard: start-time PID-reuse check, socket re-verify, ancestor guard, SIGTERM → grace → SIGKILL | `tests/unit/kill.test.mjs`, `tests/host/ports.test.mjs` (real child that ignores SIGTERM) |
| Steps model: `ai`/`you` sources, `set_steps` preserves user rows, cap, duplicate detection | `tests/unit/steps.test.mjs` |
| Client activation contract (face export, `inject` audit, duplicate-locale HMR) | `tests/unit/package.test.mjs` |
| Both surfaces render every frame shape (null, full, partial, field-less) | `tests/unit/render.test.mjs` |
| Theme-token lint (no literal colours, no `@deepseek-ai/*` client imports) | `tests/unit/package.test.mjs` |

**87 automated tests green** with `node --test tests/unit/ tests/host/`.

---

## 4. Problems found and fixed (read this — it explains the odd-looking code)

Each of these was a real defect found *after* the code "looked done". They are the reason several hunks look defensive.

1. **Client never activated.** `client.js` returned the plugin face from *inside* the factory instead of exporting it, so the entry had no `apply` and the Loader left it inactive — while the Host half worked fine. Fix: module-level `const face` returned by the factory; `package.test.mjs` pins `Object.keys(exports) === ['apply','inject']`.
2. **Undeclared service access.** Reading `ctx.uiConversation` / `ctx.sidebarRight` without listing them in `inject` throws in Cordis. Fix: both declared; a static audit test now compares every `ctx.<service>` the bundle reads against `inject`, and the test stub throws exactly like Cordis.
3. **Duplicate locale registration on HMR.** `locale.register` refuses a second registration of the same namespace. Fix: register once as a map inside a guarded effect; "already has locale" is treated as reuse.
4. **React error 185 (maximum update depth).** `store.snapshot` returned a new object per call, so `useSyncExternalStore` re-rendered forever and crashed both slots. Fix: snapshot cached in `store.current`, replaced only on publish; store kept cached after detach. Regression test in `render.test.mjs`.
5. **`Cannot read properties of null (reading 'uncommitted')`.** `PinStrip` computed `git.uncommitted` before its null guard. Fix: explicit "no frame yet → render nothing" branch, `formatCounts` validates fields, and a `statRow()` helper degrades to `—`. Covers frames from another Host release.
6. **Root cause of "git never shows up": `createGitInspector` was never wired into the Host.** `applyGit` had no caller, so every frame carried `git: null` and the strip's git path was dead code (bug 5 was just the visible symptom). Fix: one git inspection per port-scan tick (`src/ports/install.mjs`) and on `POST /refresh` (`host.refreshGit`); `host.log` exposed for source diagnostics.
7. **UI smoke scripts were machine-specific.** Hard-coded `playwright-core` and Chromium paths in one developer's home directory. Fix: `tests/browser.mjs` resolves both (or `SKIP`s cleanly).

> When you change `client.js`, keep the store snapshot **referentially stable** and keep every `view.*` read defensive. Bugs 4 and 5 were both contract violations of that rule, and both surfaced only in the browser.

---

## 5. What remains

### P4 — Pin from the selection toolbar (next up, ~0.5 session)

**The PLAN's original P4 plan is out of date — do not follow it.** It assumed core changes (`conversation.chat.text-interaction.actions`, refactoring `message-quotes`). Core already provides everything needed, verified in the DSH source:

- Slot `conversation.chat.text-interaction` is `kind: 'keyed'`, `scope: 'session'`, **keyed by plugin id** (`packages/client/ui-chat/src/client/contract/slots.ts:431`).
- `ctx.uiConversation.interactions.register({ id, onInteraction })`: call `request.open()` on a `selection` trigger to select **your** keyed surface (`packages/client/ui-conversation/lib/types/client/contract/text-interaction.d.ts`).
- The surface component receives `{ dismiss, readText, clearSelection, inputActions, useSession, t }`; the model to copy is `QuoteSelection.tsx` in `packages/session/message-quotes/src/client/`.
- **No core file needs to change, so no DSH rebuild is needed.**

Gap in the current bundle: `client.js` registers `working-note-pin` but only handles `request.trigger === 'contextmenu'`. It needs a `'selection'` branch + a keyed slot renderer.

Sketch (adapt to the bundle's conventions, keep the `h()` style and theme tokens):

```js
ctx.effect(() => interactions.register({
  id: 'working-note-pin',
  onInteraction(request) {
    if (request.trigger === 'selection') { request.open(); return }   // show the 📌 button
    if (request.trigger !== 'contextmenu') return
    /* existing pin path */
  },
}), 'working-note: pin interaction')

ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({
  name: 'conversation.chat.text-interaction', key: 'working-note-pin', locale: NS,
}, (props) => { /* button: readText() → addSteps → clearSelection(); dismiss() */ }))
```

Acceptance: selecting text in chat shows **both** 📌 and Quote, side by side; 📌 pins a step (tagged `you`) and dismisses; Quote still works; multi-line selections split into steps. Add a render test for the new surface and an `inject` audit pass.

### P6 — Live verification (C1–C6, never confirmed end to end)

Nobody has watched all of these work in a real browser against a real Harness. This is the highest-value remaining work.

| ID | Check |
|---|---|
| C1 | Strip appears above the composer once the plugin is installed **and** the Harness restarted |
| C2 | Sidebar tab opens from the strip and shows live ports + steps |
| C3 | Selection pin: highlight → right-click / `Alt+Shift+P` / 📌 (after P4) produces a `you` step |
| C4 | `Kill all` stops only this session's ports, two-press confirm, Harness process untouched |
| C5 | Cross-device: two browsers show the same note; a change on one appears on the other |
| C6 | Archive → read-only → undo → purge after `archiveGraceMs` (30 s default) |
| C7 | A real model call through the `working_note` tool (persisted via a tool call, but never asserted in a test) |

### Smaller open items

- **macOS port discovery**: only Linux `/proc` is implemented. macOS shows "unsupported" instead of a list. `src/ports/ss.mjs` exists for diagnosis only.
- **UX review** by a design-focused pass was never done (visual hierarchy, 390 px width, light/dark).
- **Plugin icon / `meta.detail` preview**: no real screenshot has been captured; the icon is a placeholder SVG.
- Docs hygiene: `PLAN.md` §2 (P4 tasks) and any text mentioning `conversation.chat.text-interaction.actions` are stale — update them as you finish P4.

---

## 6. Working agreements that make this project go smoothly

- **Verify, don't assume.** Use `cordis_inspect_list` / `cordis_inspect_query` (Provider methods for services, tools, slots, configs) before writing plugin code against an API.
- **The browser is the only proof for UI work.** Stub tests pass on code that crashes in React; two of the seven bugs above were invisible to a passing suite. Ask the user for console output when something does not render.
- **Client vs Host.** `client.js` + locales → hard reload. `index.mjs` / `src/**` → Harness restart. Say which one a change needs.
- **Never touch the Harness process** without asking; the user prefers to restart it themselves.
- **When you finish a phase**: `npm test` green → update the `PLAN.md` status board and append a session-log row with the evidence → commit with a message that says what changed and why.
- **Keep tests honest**: after adding a regression test, revert the fix and confirm the test actually fails. Three tests in this project initially passed for the wrong reason.

---

## 7. File map

```text
index.mjs              Host entry (name 'working-note', inject ['storageDomain'], Config, apply → installHost)
client.js              whole client bundle: API client, store, strip, panel, gestures, styles, locale dicts
cordis.patch.yml       config row installed into the profile (every field is editable in Settings → Plugins)
locale/{en,vi,zh}.json flat keys under the `workingNote` namespace
src/host.mjs           installHost: service, scanner, lifecycle, model wiring, API, kill/all
src/service.mjs        per-session records, write queue, applyScan/applyGit, archive/undo/purge, toView
src/api.mjs            HTTP + SSE routes under /api/working-note/*
src/git.mjs            git inspection (worktree, branch, both deltas)
src/ports/{proc,ss,attribution,scan,kill,install}.mjs   port discovery, attribution, guarded kill, mount
src/scanner.mjs        poll loop; probes only while a client is watching
src/tool.mjs           the `working_note` agent tool
src/context-text.mjs   the `working-note:pinned` runtime context text
src/domain.mjs         record types + zod schema; src/store.mjs storageDomain wrapper
tests/unit/*.test.mjs  parsers, rules, service, client contract, render
tests/host/*.test.mjs  boots the Host: routes, real git, real child process, git wiring
tests/browser.mjs      resolves playwright + Chromium, or skips
```

---

## 8. Kickoff prompt

Paste this into a fresh DSH session on the new machine:

```text
Repo: https://github.com/ailuvu-art/dsh-working-note (public, branch main).
Plugin for DeepSeek Harness: pins session context above the composer — worktree/git
diff, open ports + Kill all, and hands-on steps — synced across devices.

Read, in this order: HANDOFF.md, PLAN.md (status board + session log), SPEC.md,
CONTRACTS.md. Then run `npm test` (expect 87/87) and `npm run check`.

Context: the plugin is installed in the profile and the Host half works (tool
`working_note` is live and has persisted steps). 87 automated tests pass. Host bugs
found and fixed are listed in HANDOFF.md §4 — read them before touching client.js.

Do this, in order:
1. Install into this machine's Harness: `plugin_manager action: install_bundle`
   with target = the clone path, then tell me to restart the Harness (I restart it
   myself; do not kill it).
2. Live verification C1–C6 from HANDOFF.md §5, plus C7 (a real `working_note` tool
   call). I have the browser — ask me for console output or screenshots when you
   cannot confirm something from the Host side. Report each as pass/fail with the
   evidence, and fix what fails.
3. Then implement P4 (HANDOFF.md §5): pin from the selection toolbar next to Quote,
   using the already-shipped `conversation.chat.text-interaction` keyed slot and the
   `selection` text-interaction trigger. No core DSH change is needed — do not
   follow the stale P4 tasks in PLAN.md §2.

Rules: verify with cordis_inspect_* before coding against an API; every fix needs a
test that fails without it; update the PLAN.md status board and session log and
commit as you go. Answer in Vietnamese.
```

---

## 9. Environment notes from the previous machine

Not required, but if something behaves oddly these were the facts:

- The Harness ran as `pnpm dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host 127.0.0.1:3080`, profile `web` at `$HOME/.dsh-repo/profiles/web`, bundle linked by `link:` in `dsh.profile.bundles`.
- GitHub pushes worked over HTTPS with a `gh` token; the machine had **no usable SSH key** even though `gh` was configured for SSH. The repo's `origin` is HTTPS.
- A shell in that session could not authenticate to `/api/working-note/*` (401) or `/plugins` (404) — expected: those routes are behind `ctx.connection.requestRejection` and need a browser credential. Probe them from the browser, not from bash.
