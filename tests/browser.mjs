/**
 * Locate a Chromium plus a playwright-core for the mockup smoke scripts.
 *
 * The wireframe checks are a developer convenience, not part of `npm test`: they
 * need a browser that the plugin itself does not depend on. Resolution therefore
 * walks the usual places (an explicit `PLAYWRIGHT_CHROMIUM` path, a local
 * `node_modules`, the DSH checkout, a global install) and returns `null` when
 * nothing is found, so the caller can skip with a clear message instead of
 * failing on a machine that never had a browser.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

/** Load `playwright-core` from the first place that has it. */
export function loadPlaywright() {
  const candidates = [
    'playwright-core',
    'playwright',
    join(homedir(), '.dsh-repo', 'node_modules', 'playwright-core'),
    // A DSH checkout next to the plugin: `DSH_CHECKOUT`, else a sibling `deepseek-harness`.
    process.env.DSH_CHECKOUT === undefined ? '' : join(process.env.DSH_CHECKOUT, 'node_modules', 'playwright-core'),
    join(homedir(), 'deepseek-harness', 'node_modules', 'playwright-core'),
    '/usr/local/lib/node_modules/playwright-core',
    '/usr/lib/node_modules/playwright-core',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      return { name: candidate, module: require(candidate) }
    } catch {
      // Try the next place.
    }
  }
  // pnpm keeps packages under a content-addressed store: find a `playwright-core`
  // nested in `.pnpm`, which is how the DSH checkout installs it.
  const checkouts = [process.env.DSH_CHECKOUT, join(homedir(), 'deepseek-harness')].filter(Boolean)
  for (const checkout of checkouts) {
    const pnpmRoot = join(checkout, 'node_modules', '.pnpm')
    if (!existsSync(pnpmRoot)) continue
    for (const entry of readdirSync(pnpmRoot)) {
      if (!entry.startsWith('playwright-core@')) continue
      const nested = join(pnpmRoot, entry, 'node_modules', 'playwright-core')
      try {
        return { name: nested, module: require(nested) }
      } catch {
        // Keep looking.
      }
    }
  }
  return null
}

/** Find a `chrome-headless-shell` (or full Chromium) executable. */
export function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM !== undefined && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) {
    return process.env.PLAYWRIGHT_CHROMIUM
  }
  const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright')
  if (!existsSync(cacheRoot)) return null
  const wanted = ['chrome-headless-shell', 'headless_shell', 'chrome']
  for (const entry of readdirSync(cacheRoot).sort().reverse()) {
    const dir = join(cacheRoot, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    for (const name of wanted) {
      try {
        const found = execFileSync('find', [dir, '-type', 'f', '-name', name], { encoding: 'utf8' })
          .split('\n').map(line => line.trim()).filter(Boolean)
        if (found.length > 0) return found[0]
      } catch {
        // `find` unavailable: fall through to `null`.
      }
    }
  }
  return null
}

/**
 * Resolve everything the smoke scripts need.
 * @returns {{ chromium: object, executablePath: string } | null} `null` when this machine cannot run them
 */
export function browserRuntime() {
  const playwright = loadPlaywright()
  const executablePath = findChromium()
  if (playwright === null || executablePath === null) return null
  return { chromium: playwright.module.chromium, executablePath }
}

/** Say why the script cannot run, then exit 0 so a missing browser is not a failure. */
export function skip(name) {
  console.log(`SKIP ${name}: needs playwright-core and a Chromium build ` +
    '(set PLAYWRIGHT_CHROMIUM to a chrome-headless-shell path, or run `npx playwright install chromium`).')
  process.exit(0)
}
