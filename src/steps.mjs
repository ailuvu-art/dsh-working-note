/**
 * Pure step operations and input normalisation.
 *
 * Everything the Host, the tool, and the UI agree on about a step list lives
 * here: bullet stripping, dedupe, ordering, caps, and the rule that a replace
 * never silently drops a row the user pinned. No I/O, no clock beyond the one
 * passed in.
 */

/** @typedef {import('./domain.mjs').Step} Step */

/** Bullet or list numbering at the start of a pasted line. */
const BULLET = /^\s*(?:[-*+•]|\d+[.)]|\(\d+\)|\[\s?[xX ]?\s?\])\s+/

/**
 * Normalise one pasted or typed line into a step text.
 * @param {string} raw - the raw line.
 * @returns {string} the trimmed, bullet-free text; empty when the line is blank.
 */
export function normaliseStepText(raw) {
  let text = String(raw ?? '')
  // Repeated markers ("- [ ] 1. ...") collapse to nothing.
  for (let i = 0; i < 3; i += 1) {
    const next = text.replace(BULLET, '')
    if (next === text) break
    text = next
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 2000)
}

/**
 * Split a pasted block into candidate lines.
 * @param {string} block - a multi-line paste.
 * @returns {string[]} non-blank normalised lines.
 */
export function splitLines(block) {
  return String(block ?? '')
    .split(/\r?\n/)
    .map(normaliseStepText)
    .filter(text => text !== '')
}

let counter = 0
/**
 * Mint a step id. Stable within one Host process and unique across records.
 * @param {number} now - clock for the readable suffix.
 * @returns {string} `s<base36 time><base36 counter>`.
 */
export function nextStepId(now = Date.now()) {
  counter = (counter + 1) % 1_000_000
  return `s${now.toString(36)}${counter.toString(36).padStart(4, '0')}`
}

const sameText = (a, b) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

/**
 * Append steps, skipping blanks and duplicates of an existing row.
 * @param {Step[]} steps - current list (not mutated).
 * @param {string[]} texts - raw candidate texts (each may itself be multi-line).
 * @param {{ source: 'user' | 'ai', now?: number, limit?: number }} options
 * @returns {{ steps: Step[], added: number, skipped: number }} the new list and counts.
 */
export function addSteps(steps, texts, { source, now = Date.now(), limit = 200 }) {
  const next = [...steps]
  let added = 0
  let skipped = 0
  for (const raw of texts ?? []) {
    for (const text of splitLines(raw)) {
      if (next.some(step => sameText(step.text, text))) { skipped += 1; continue }
      if (next.length >= limit) { skipped += 1; continue }
      next.push({ id: nextStepId(now), text, done: false, source, createdAt: now, updatedAt: now })
      added += 1
    }
  }
  return { steps: next, added, skipped }
}

/**
 * Replace the list while keeping rows the user pinned (default behaviour).
 * @param {Step[]} steps - current list.
 * @param {string[]} texts - the replacement texts.
 * @param {{ source?: 'ai', now?: number, limit?: number, preserveUserSteps?: boolean }} options
 * @returns {{ steps: Step[], replaced: number, keptUser: number, added: number, skipped: number }}
 */
export function replaceSteps(steps, texts, { now = Date.now(), limit = 200, preserveUserSteps = true } = {}) {
  const kept = preserveUserSteps ? steps.filter(step => step.source === 'user') : []
  const { steps: merged, added, skipped } = addSteps(kept, texts, { source: 'ai', now, limit })
  return { steps: merged, replaced: steps.length - kept.length, keptUser: kept.length, added, skipped }
}

/**
 * Apply one patch to a step.
 * @param {Step[]} steps - current list.
 * @param {string} stepId - target id.
 * @param {{ text?: string, done?: boolean, move?: -1 | 1 }} patch
 * @param {number} now - clock for `updatedAt`.
 * @returns {{ steps: Step[], found: boolean }} the new list.
 */
export function patchStep(steps, stepId, patch, now = Date.now()) {
  const index = steps.findIndex(step => step.id === stepId)
  if (index < 0) return { steps, found: false }
  const next = [...steps]
  let step = next[index]
  if (typeof patch.text === 'string') {
    const text = normaliseStepText(patch.text)
    if (text !== '') step = { ...step, text, updatedAt: now }
  }
  if (typeof patch.done === 'boolean') step = { ...step, done: patch.done, updatedAt: now }
  next[index] = step
  if (patch.move === -1 || patch.move === 1) {
    const target = index + patch.move
    if (target >= 0 && target < next.length) {
      next.splice(target, 0, next.splice(index, 1)[0])
    }
  }
  return { steps: next, found: true }
}

/**
 * Remove one step.
 * @param {Step[]} steps - current list.
 * @param {string} stepId - target id.
 * @returns {{ steps: Step[], removed: number }} the new list.
 */
export function removeStep(steps, stepId) {
  const next = steps.filter(step => step.id !== stepId)
  return { steps: next, removed: steps.length - next.length }
}

/**
 * Remove every completed step.
 * @param {Step[]} steps - current list.
 * @returns {{ steps: Step[], removed: number }}
 */
export function clearDone(steps) {
  const next = steps.filter(step => !step.done)
  return { steps: next, removed: steps.length - next.length }
}
