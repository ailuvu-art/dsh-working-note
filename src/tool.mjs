/**
 * The `working_note` agent tool.
 *
 * Follows the tool-design rules: the description states what the tool does and
 * returns, parameter rules live on the parameters, and the result text is
 * bounded — a step list, the live ports, and one git line. The model never sees
 * raw JSON.
 *
 * The tool calls the same service methods the UI routes call, so there is one
 * implementation of every operation.
 */

/**
 * @param {object} ctx - Cordis context with `tools`.
 * @param {object} host - installed host handle.
 */
export function registerWorkingNoteTool(ctx, host) {
  const tools = ctx.get?.('tools')
  if (tools?.register === undefined) return
  tools.register({
    name: 'working_note',
    description:
      'Maintain this session’s pinned working note: hands-on steps the user must perform, and the ports opened for manual testing. '
      + 'Use it to record the manual or QA steps you ask the human to do, and to check what they already completed. '
      + 'Steps the user pinned are tagged "you" and survive set_steps unless preserve_user is false.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'add_steps', 'set_steps', 'toggle_step', 'remove_step', 'clear_done'],
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'With add_steps/set_steps: one entry per step, in display order. Blank entries and duplicates are skipped.',
        },
        step_id: { type: 'string', description: 'With toggle_step/remove_step: the id listed by the tool.' },
        done: { type: 'boolean', description: 'With toggle_step: the target state. Omit to invert.' },
        preserve_user: {
          type: 'boolean',
          description: 'With set_steps: keep steps the user pinned, replacing only agent steps. Defaults to true.',
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    presentCall: (args) => `Working note: ${String(args?.action ?? 'list')}`,
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.header?.id ?? exec?.agent?.id
      if (typeof sessionId !== 'string') throw new Error('working_note needs a session')
      const service = host.service
      const text = (value) => renderToolText(value, service.view(sessionId))
      const action = args?.action
      const steps = Array.isArray(args?.steps) ? args.steps : []
      if (action === 'list') return text('Current working note.')
      if (action === 'add_steps') {
        if (steps.length === 0) throw new Error('add_steps needs at least one step')
        const result = await service.addSteps(sessionId, { steps, source: 'ai' })
        return text(`Added ${result.added} step${result.added === 1 ? '' : 's'}${result.skipped > 0 ? `, skipped ${result.skipped} duplicate or blank` : ''}.`)
      }
      if (action === 'set_steps') {
        const preserve = args?.preserve_user !== false
        const result = await service.replaceSteps(sessionId, { steps, preserveUserSteps: preserve })
        return text(`Replaced ${result.replaced} agent step${result.replaced === 1 ? '' : 's'}; kept ${result.keptUser} pinned by the user.`)
      }
      if (action === 'toggle_step' || action === 'remove_step') {
        const stepId = args?.step_id
        if (typeof stepId !== 'string' || stepId === '') throw new Error(`${action} needs step_id`)
        const row = service.record(sessionId)?.steps.find(step => step.id === stepId)
        if (row === undefined) throw new Error(`No step ${stepId} in this session`)
        if (action === 'remove_step') {
          await service.removeStep(sessionId, stepId)
          return text(`Removed step ${stepId}.`)
        }
        const next = typeof args?.done === 'boolean' ? args.done : !row.done
        await service.updateStep(sessionId, stepId, { done: next })
        return text(`${next ? 'Completed' : 'Reopened'} step ${stepId}.`)
      }
      if (action === 'clear_done') {
        const result = await service.clearDone(sessionId)
        return text(`Cleared ${result.removed} completed step${result.removed === 1 ? '' : 's'}.`)
      }
      throw new Error(`Unknown action ${String(action)}`)
    },
  })
}

/**
 * Bounded, human-readable summary for the model.
 * @param {string} headline - what the call did.
 * @param {object} view - the session view.
 * @returns {string}
 */
export function renderToolText(headline, view) {
  const lines = [headline]
  if (view.git !== null && view.git !== undefined) {
    const git = view.git
    if (git.isGitRepo) {
      const counts = git.uncommitted
      lines.push(`Git: ${git.branch ?? 'detached'}${git.isWorktree ? ' (worktree)' : ''} · +${counts.added}/−${counts.deleted} in ${counts.files} files`)
    } else {
      lines.push(`Git: not a repository (${git.cwd})`)
    }
  }
  const live = (view.ports ?? []).filter(port => port.state === 'listening')
  lines.push(live.length === 0
    ? 'Ports: none listening'
    : `Ports: ${live.map(port => `:${port.port} ${port.processName} (${port.origin})`).join(', ')}`)
  const steps = view.steps ?? []
  const open = steps.filter(step => !step.done).length
  lines.push(`Steps: ${open} open / ${steps.length}`)
  for (const step of steps.slice(0, 20)) {
    lines.push(`- ${step.done ? '[x]' : '[ ]'} ${step.text}${step.source === 'user' ? ' (user)' : ''}  [${step.id}]`)
  }
  if (steps.length > 20) lines.push(`… (+${steps.length - 20} more steps)`)
  return lines.join('\n')
}
