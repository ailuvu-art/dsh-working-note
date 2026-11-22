/**
 * GNU `ss` adapter: the preferred socket-to-process source when it exists.
 *
 * `ss` is only an accelerator. The `/proc/net/tcp*` join in `proc.mjs` is the
 * primary source, so a container without `ss` (or a BusyBox build) changes
 * nothing but latency.
 */

import { parseSs } from './proc.mjs'

/**
 * @param {object} ctx - Cordis context (reads `subprocess`).
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ available: () => Promise<boolean>, scan: () => Promise<ReturnType<typeof parseSs>> }}
 */
export function createSsAdapter(ctx, { timeoutMs = 3000 } = {}) {
  let resolved

  /**
   * Run `ss -H -lptn`.
   * @returns {Promise<ReturnType<typeof parseSs>>}
   */
  async function scan() {
    const subprocess = ctx.get?.('subprocess')
    if (subprocess === undefined) return []
    if (resolved === undefined) {
      resolved = await subprocess.resolveExecutable('ss', undefined).catch(() => null)
    }
    if (resolved === null) return []
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    timer.unref?.()
    try {
      const handle = subprocess.spawn({
        argv: [resolved, '-H', '-lptn'],
        cwd: '/',
        signal: deadline.signal,
        graceMs: 500,
        env: { LC_ALL: 'C' },
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1024 * 1024 },
          stderr: { maxBytes: 16 * 1024 },
        },
      })
      const outcome = await handle.done.catch(() => ({ exitCode: 1 }))
      if (outcome.exitCode !== 0) return []
      return parseSs(handle.collected.stdout?.readFrom(0).text ?? '')
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    available: async () => {
      const subprocess = ctx.get?.('subprocess')
      if (subprocess === undefined) return false
      if (resolved === undefined) {
        resolved = await subprocess.resolveExecutable('ss', undefined).catch(() => null)
      }
      return resolved !== null
    },
    scan,
  }
}
