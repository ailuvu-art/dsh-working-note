/** `index.mjs` body: configuration resolution and host installation. */

/** Key the resolved config carries when the patch row named fields it does not declare. */
export const FOREIGN_MARK = Symbol('workingNote.foreignConfig')

/** Resolved configuration with every default applied. */
export const DEFAULT_CONFIG = Object.freeze({
  portPollIntervalMs: 4000,
  gitTimeoutMs: 5000,
  killGraceMs: 1500,
  archiveGraceMs: 30000,
  stoppedPortTtlMs: 600000,
  scanWorktreeCwd: true,
  injectContextToModel: true,
  maxStepsPerSession: 200,
})

const NUMBER_FIELDS = [
  ['portPollIntervalMs', 250],
  ['gitTimeoutMs', 250],
  ['killGraceMs', 0],
  ['archiveGraceMs', 0],
  ['stoppedPortTtlMs', 0],
  ['maxStepsPerSession', 1],
]

const BOOLEAN_FIELDS = ['scanWorktreeCwd', 'injectContextToModel']

/** Fields a Host patch layer does not route here; seeing one is worth a log line. */
const FOREIGN_FIELDS = ['props', 'description', 'optional', 'patches']

/**
 * Validate a patch-layer config into the resolved shape.
 *
 * Kept independent of Schemastery so the Host loads before any package
 * resolution and tests can call it directly; the patch row remains the
 * user-facing surface and `Config` validates before this runs.
 * @param {object} [raw] - the row's `config` object (possibly partial).
 * @returns {object} the frozen resolved configuration.
 */
export function resolveConfig(raw = {}) {
  const out = { ...DEFAULT_CONFIG }
  for (const [field, min] of NUMBER_FIELDS) {
    const value = raw[field]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < min) {
      throw new Error(`dsh-working-note: config.${field} must be an integer >= ${min}, got ${JSON.stringify(value)}`)
    }
    out[field] = value
  }
  for (const field of BOOLEAN_FIELDS) {
    const value = raw[field]
    if (value === undefined) continue
    if (typeof value !== 'boolean') {
      throw new Error(`dsh-working-note: config.${field} must be a boolean, got ${JSON.stringify(value)}`)
    }
    out[field] = value
  }
  // Unknown fields are ignored, never fatal: a row the Host passes through from
  // another layer (or a future release's field) must not stop activation. The
  // caller's logger reports them so a misrouted config is still diagnosable.
  const foreign = Object.keys(raw).filter(key => !(key in DEFAULT_CONFIG))
  if (foreign.length > 0) out[FOREIGN_MARK] = foreign
  return Object.freeze(out)
}
