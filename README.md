# dsh-working-note

Pins the session's working context above the composer and keeps it in sync everywhere the session is open.

- **Worktree & git** — whether the session works in a linked worktree, the branch, and the uncommitted line delta.
- **Open ports** — every port attributed to the session (agent jobs, the session's terminals, and processes whose working directory is inside the session's checkout), with a two-press **Kill all** that never touches the Harness itself.
- **Hands-on steps** — steps the agent records for you, plus anything you highlight in the chat and pin, persisted per session.

The note lives on the Host (`ctx.storageDomain`, one record per session), so it survives page reloads and host restarts, reaches every connected device through the authenticated SSE stream, and is cleaned up with the session: idle eviction keeps it, archiving makes it read-only for the undo window, and it is removed when that window closes.

## Status

Working end to end on the Host side (storage, routes, ports, kill guard, `working_note`
tool, git inspection) with **87 automated tests**. The one thing not yet confirmed by a
human is the rendered strip and tab in a live browser — see [HANDOFF.md](HANDOFF.md) for
what is verified, what is assumed, and what remains (including the 📌 button next to
Quote).

## Where it appears

| Surface | Slot |
|---|---|
| Compact pin strip | `conversation.input.dock` (above the composer, beside Todo and Goal) |
| Full panel | right sidebar tab type `working-note` (can float with the docking kit) |
| Agent tool | `working_note` (`list`, `add_steps`, `set_steps`, `toggle_step`, `remove_step`, `clear_done`) |
| Model context | `working-note:pinned` runtime context while a step is open or a port is live |

## Install

```bash
git clone https://github.com/ailuvu-art/dsh-working-note.git
```

Then in the Harness: **Plugins → Add plugin → local directory** and pick the
clone. Restart the Harness afterwards so the Host half loads.

Any machine that should carry the plugin, including a checkout on another
computer, installs the same way: clone it, then add the clone's directory.

From a DSH agent session the same install is:

```text
plugin_manager action: install_bundle  target: <path to the clone>
```

## Configuration

Every field is editable on the plugin row in **Settings → Plugins**:

| Field | Default | Meaning |
|---|---|---|
| `portPollIntervalMs` | `4000` | Poll cadence while a client is viewing the session. |
| `gitTimeoutMs` | `5000` | Deadline for one git command. |
| `killGraceMs` | `1500` | Wait between `SIGTERM` and `SIGKILL`. |
| `archiveGraceMs` | `30000` | How long an archived session's note is kept for undo. |
| `stoppedPortTtlMs` | `600000` | How long a stopped port stays in the list. |
| `scanWorktreeCwd` | `true` | Attribute processes running inside the session's checkout. |
| `injectContextToModel` | `true` | Send pending steps and live ports as runtime context. |
| `maxStepsPerSession` | `200` | Step cap. |

## Requirements

A DeepSeek Harness build whose plugin API matches `dsh.client.inject` in
`package.json` (`ui-conversation`, `ui-sidebar-right`, `client-locale`). Git
facts need `git` on the Host; port discovery needs Linux `/proc`.

## Security notes

- Every HTTP route passes `ctx.connection.requestRejection` before reading anything.
- Signals are sent only after re-proving pid identity (start time), socket ownership, and the Harness-ancestor guard.
- Process data is read from `/proc` with the Host's own permissions; nothing is sent off the machine.

Port discovery is available on Linux (`/proc` + `ss`); on macOS only an `lsof`-based tier is planned, and unsupported platforms show an explanation instead of an empty list.

## Where it runs, and what it needs

| Piece | Needs | Missing it means |
|---|---|---|
| Pin strip, tab, `working_note` tool | a running Harness that has the bundle in its profile (a **restart** after install) | the surfaces simply do not appear |
| Port discovery | Linux `/proc` (+ optional `ss`); the Session's terminals and `DSH_SESSION_ID` for attribution | the ports card explains that discovery is unavailable instead of showing an empty list |
| Kill-all | permission to signal the Session's own processes | per-port failures are reported in the result, never silently swallowed |
| Git facts | `git` on the Host | the worktree line is absent |

## Development

```bash
npm test          # node --test tests/unit/ tests/host/  (87 tests)
npm run check     # node --check on both entries
npm run test:ui   # Playwright smoke of mockup.html (needs local Chromium)
```

`tests/unit` covers parsers and pure rules; `tests/host` boots the Host with a
plain Cordis context and exercises the real routes, the real `git` binary, and a
real child process it starts and kills.
