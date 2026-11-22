/** Typed failures the Host service, the HTTP API, and the tool all share. */

/**
 * One failure carrying the HTTP status the route layer must answer with.
 */
export class WorkingNoteError extends Error {
  /**
   * @param {string} code - stable machine code, e.g. `workingNote/archived`.
   * @param {string} message - human text for the UI.
   * @param {number} status - HTTP status for the route layer.
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'WorkingNoteError'
    this.code = code
    this.status = status
  }
}

/** @param {string} sessionId */
export const missingSession = () => new WorkingNoteError('workingNote/missing-session', 'A session ID is required.', 400)
/** @param {string} sessionId */
export const unknownSession = sessionId => new WorkingNoteError('workingNote/unknown-session', `Session "${sessionId}" is not known to this Host.`, 404)
/** @param {string} sessionId */
export const archivedSession = sessionId => new WorkingNoteError('workingNote/archived', `Session "${sessionId}" is archived; its working note is read-only until the archive is undone.`, 409)
/** @param {string} stepId */
export const unknownStep = stepId => new WorkingNoteError('workingNote/unknown-step', `No step "${stepId}" in this session.`, 404)
/** @param {number} port */
export const notOwned = port => new WorkingNoteError('workingNote/port-not-owned', `Port ${port} is not attributed to this session.`, 409)
/** @param {number} port */
export const protectedTarget = port => new WorkingNoteError('workingNote/protected', `Refusing to signal the process behind port ${port}: it is the Harness itself or an ancestor.`, 403)
/** @param {number} port */
export const portUnavailable = port => new WorkingNoteError('workingNote/unknown-port', `No tracked port ${port} in this session.`, 404)
/** @param {string} what */
export const unsupported = what => new WorkingNoteError('workingNote/unsupported', `${what} is not available on this Host.`, 501)
/** @param {string} what */
export const limitReached = what => new WorkingNoteError('workingNote/limit', `This session reached its ${what} limit.`, 409)
