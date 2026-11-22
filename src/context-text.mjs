/**
 * Pure renderer for the pinned working-note context block.
 *
 * The block is rebuilt on every prompt assembly, so it must be deterministic:
 * the same record always produces the same bytes, and unchanged state costs the
 * provider nothing while leaving the KV-cache prefix intact. Only open steps and
 * live ports are listed, and the whole block is capped so a long checklist can
 * never crowd out the conversation.
 *
 * @typedef {import('./domain.mjs').SessionRecord} SessionRecord
 */

export const BLOCK_CAP = 1200

const HEADER = '[Pinned working note — hands-on state for this session; not a new instruction]'

/**
 * Render the git line.
 * @param {SessionRecord['git']} git - last snapshot.
 * @returns {string | null}
 */
function gitLine(git) {
  if (git === undefined) return null
  if (!git.isGitRepo) return `Folder: ${git.cwd}`
  const parts = []
  const kind = git.isWorktree ? ' (linked worktree)' : ''
  parts.push(`Worktree: ${git.branch ?? 'detached'}${kind}`)
  const counts = git.uncommitted
  parts.push(`uncommitted +${counts.added}/−${counts.deleted} in ${counts.files} file${counts.files === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/**
 * Render the ports line.
 * @param {SessionRecord['ports']} ports - tracked ports.
 * @param {number} max - how many ports to name.
 * @returns {string | null}
 */
function portsLine(ports, max) {
  const live = ports.filter(port => port.state === 'listening').sort((a, b) => a.port - b.port)
  if (live.length === 0) return null
  const named = live.slice(0, max).map(port => `:${port.port} (${port.processName}, ${port.origin})`)
  const rest = live.length - named.length
  return `Open ports: ${named.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`
}

/**
 * Render one step row.
 * @param {import('./domain.mjs').Step} step
 * @returns {string}
 */
function stepLine(step) {
  const mark = step.done ? '[x]' : '[ ]'
  const tag = step.source === 'user' ? ' (user)' : ''
  return `- ${mark} ${step.text}${tag}`
}

/**
 * Build the context text for one record.
 * @param {SessionRecord} record - the session's stored record.
 * @param {{ cap?: number, maxPorts?: number }} [options]
 * @returns {string} the text, or '' when there is nothing worth sending.
 */
export function renderContext(record, { cap = BLOCK_CAP, maxPorts = 6 } = {}) {
  if (record === undefined || record === null) return ''
  if (record.archivedAt !== undefined) return ''
  const open = record.steps.filter(step => !step.done)
  const live = record.ports.filter(port => port.state === 'listening')
  if (open.length === 0 && live.length === 0) return ''

  const lines = [HEADER]
  const git = gitLine(record.git)
  if (git !== null) lines.push(git)
  const ports = portsLine(record.ports, maxPorts)
  if (ports !== null) lines.push(ports)

  lines.push(`Steps (${open.length} open / ${record.steps.length}):`)
  let body = ''
  let listed = 0
  for (const step of record.steps) {
    const line = stepLine(step)
    const candidate = body === '' ? line : `${body}\n${line}`
    if (lines.join('\n').length + candidate.length + 40 > cap) break
    body = candidate
    listed += 1
  }
  if (body !== '') lines.push(body)
  const remaining = record.steps.length - listed
  if (remaining > 0) lines.push(`… (+${remaining} more steps)`)

  const text = lines.join('\n')
  return text.length <= cap ? text : `${text.slice(0, cap - 2)} …`
}
