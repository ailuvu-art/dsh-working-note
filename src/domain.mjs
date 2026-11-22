/**
 * The durable shape of one Session's working note and its storage domain.
 *
 * `dsh_working_note` opens through `ctx.storageDomain` with per-record layout:
 * each Session is one KV record, reads are synchronous from memory, and every
 * write is durable before it resolves. The record is plain JSON because the
 * domain validates it with zod at the durability boundary.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Domain identity opened by `ctx.storageDomain.open`. */
export const DOMAIN_NAME = 'dsh_working_note'
export const DOMAIN_VERSION = 1

/** @typedef {'user' | 'ai'} StepSource */
/** @typedef {'job' | 'terminal' | 'worktree'} PortOrigin */
/** @typedef {'listening' | 'stopped'} PortState */

/**
 * One hands-on step.
 * @typedef {object} Step
 * @property {string} id
 * @property {string} text
 * @property {boolean} done
 * @property {StepSource} source
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * One port attributed to the Session, kept as history after it stops.
 * @typedef {object} TrackedPort
 * @property {number} port
 * @property {'tcp' | 'tcp6'} protocol
 * @property {string} host
 * @property {number} pid
 * @property {number} [pgid]
 * @property {string} [startTime]
 * @property {string} processName
 * @property {string} command
 * @property {PortOrigin} origin
 * @property {string} [jobId]
 * @property {string} [terminalId]
 * @property {PortState} state
 * @property {number} firstSeenAt
 * @property {number} lastSeenAt
 * @property {number} [stoppedAt]
 */

/**
 * Last successful git inspection.
 * @typedef {object} GitSnapshot
 * @property {string} cwd
 * @property {boolean} isGitRepo
 * @property {boolean} isWorktree
 * @property {string} [repoRoot]
 * @property {string} [branch]
 * @property {string} [baseRef]
 * @property {{ added: number, deleted: number, files: number }} uncommitted
 * @property {{ added: number, deleted: number, files: number }} [branchDelta]
 * @property {number} updatedAt
 */

/**
 * One Session record.
 * @typedef {object} SessionRecord
 * @property {string} sessionId
 * @property {Step[]} steps
 * @property {TrackedPort[]} ports
 * @property {GitSnapshot} [git]
 * @property {{ expanded: boolean, gitScope: 'uncommitted' | 'branch' }} ui
 * @property {number} [archivedAt]
 * @property {number} updatedAt
 */

/** @returns {SessionRecord} the empty record of a Session. */
export function emptyRecord(sessionId, now = Date.now()) {
  return {
    sessionId,
    steps: [],
    ports: [],
    ui: { expanded: false, gitScope: 'uncommitted' },
    updatedAt: now,
  }
}

/**
 * The zod schema tree, loaded from the DSH installation. Exported as functions
 * so tests can skip validation when zod is not resolvable.
 * @returns {{ sessionRecordSchema: import('zod').ZodTypeAny, workingNoteDomain: unknown }} schemas plus the domain spec factory input
 */
export function zodShapes() {
  const mod = require('zod')
  const z = mod.z ?? mod.default ?? mod
  const lineCounts = z.object({
    added: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  })
  const step = z.object({
    id: z.string(), text: z.string(), done: z.boolean(),
    source: z.enum(['user', 'ai']),
    createdAt: z.number().int(), updatedAt: z.number().int(),
  })
  const trackedPort = z.object({
    port: z.number().int().min(1).max(65535),
    protocol: z.enum(['tcp', 'tcp6']),
    host: z.string(),
    pid: z.number().int().positive(),
    pgid: z.number().int().positive().optional(),
    startTime: z.string().optional(),
    processName: z.string(),
    command: z.string(),
    origin: z.enum(['job', 'terminal', 'worktree']),
    jobId: z.string().optional(),
    terminalId: z.string().optional(),
    state: z.enum(['listening', 'stopped']),
    firstSeenAt: z.number().int(),
    lastSeenAt: z.number().int(),
    stoppedAt: z.number().int().optional(),
  })
  const gitSnapshot = z.object({
    cwd: z.string(), isGitRepo: z.boolean(), isWorktree: z.boolean(),
    repoRoot: z.string().optional(), branch: z.string().optional(), baseRef: z.string().optional(),
    uncommitted: lineCounts, branchDelta: lineCounts.optional(),
    updatedAt: z.number().int(),
  })
  const sessionRecordSchema = z.object({
    sessionId: z.string(),
    steps: z.array(step),
    ports: z.array(trackedPort),
    git: gitSnapshot.optional(),
    ui: z.object({ expanded: z.boolean(), gitScope: z.enum(['uncommitted', 'branch']) }),
    archivedAt: z.number().int().optional(),
    updatedAt: z.number().int(),
  })
  return { sessionRecordSchema, _: { z, step, trackedPort, gitSnapshot } }
}

/**
 * Build the `defineDomain` spec for this plugin.
 * @returns the domain spec object accepted by `ctx.storageDomain.open`.
 */
export function workingNoteDomainSpec() {
  const storageDomain = require('@deepseek-ai/dsh-storage-domain')
  const { sessionRecordSchema } = zodShapes()
  return storageDomain.defineDomain({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    layout: 'per-record',
    tables: { sessions: storageDomain.domainTable(sessionRecordSchema) },
  })
}
