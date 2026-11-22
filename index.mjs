/**
 * Host entry for dsh-working-note.
 *
 * Wires the session-scoped working note into the running Harness: a
 * schema-validated KV record per Session, a service face shared by the HTTP API
 * and the `working_note` agent tool, the pinned runtime context, and the archive
 * lifecycle that cleans everything up with the Session.
 *
 * Plain ESM on purpose: the bundle needs no build step, so a local edit plus a
 * page/plugin reload is the whole iteration loop.
 */

import { createRequire } from 'node:module'
import { resolveConfig, DEFAULT_CONFIG } from './src/config.mjs'
import { installHost } from './src/host.mjs'

const require = createRequire(import.meta.url)

/** Stable Loader identity; also the row id users see in Settings. */
export const name = 'working-note'

/** Only the services without which the plugin cannot work. */
export const inject = ['storageDomain']

export { resolveConfig, DEFAULT_CONFIG }

/** Schemastery schema when the package is resolvable (it always is inside DSH). */
export let Config
try {
  const schemastery = require('@deepseek-ai/schemastery')
  const z = schemastery.default ?? schemastery
  Config = z.object({
    portPollIntervalMs: z.number().min(250).default(4000),
    gitTimeoutMs: z.number().min(250).default(5000),
    killGraceMs: z.number().min(0).default(1500),
    archiveGraceMs: z.number().min(0).default(30000),
    stoppedPortTtlMs: z.number().min(0).default(600000),
    scanWorktreeCwd: z.boolean().default(true),
    injectContextToModel: z.boolean().default(true),
    maxStepsPerSession: z.number().min(1).default(200),
  })
} catch {
  // Outside a DSH install (tests): `resolveConfig` is the validator.
  Config = undefined
}

/**
 * Activate the plugin on the Host context.
 * @param {object} ctx - Cordis context carrying `storageDomain` and, in the web
 * composition, `connection`, `webServer`, `tools`, `systemPrompt`.
 * @param {object} [rawConfig] - the patch row's config.
 * @returns the installed host handle.
 */
export function apply(ctx, rawConfig = {}) {
  return installHost(ctx, resolveConfig(rawConfig))
}

/**
 * Build and install every Host contribution.
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - resolved configuration from {@link resolveConfig}.
 * @returns the host handle.
 */
export function createWorkingNoteHost(ctx, config = resolveConfig({})) {
  return installHost(ctx, config)
}
