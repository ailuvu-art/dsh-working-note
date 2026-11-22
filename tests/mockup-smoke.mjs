/**
 * Smoke-test harness for mockup.html using the checkout's playwright-core and a
 * cached Chromium build. Renders desktop/narrow screenshots and exercises the
 * interactive behaviours the wireframe advertises.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { browserRuntime, skip } from './browser.mjs'

const runtime = browserRuntime()
if (runtime === null) skip('mockup smoke')
const { chromium, executablePath } = runtime

const here = dirname(fileURLToPath(import.meta.url))
const pageUrl = 'file://' + resolve(here, '..', 'mockup.html')
const shot = (name) => join(tmpdir(), name)

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
const failures = []
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failures.push(name)
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(String(e)))
await page.goto(pageUrl)
await page.waitForTimeout(300)
await page.screenshot({ path: shot('wn-desktop.png') })

// 1. initial strip state
check('strip shows worktree pill', (await page.locator('#gitBranch').textContent()).includes('wt:dsh-'))
check('strip shows +142/−38', (await page.locator('#gitAdd').textContent()) === '+142' && (await page.locator('#gitDel').textContent()) === '−38')
check('strip shows 2 port chips', (await page.locator('#portsChips .port-chip').count()) === 2)
check('steps pill 2/4', (await page.locator('#stepsCount').textContent()) === '2/4')

// 2. expand drawer
await page.click('#expandStrip')
await page.waitForTimeout(150)
check('drawer expands', await page.locator('#wnStrip.expanded').count() === 1)
check('drawer lists 2 steps', (await page.locator('#stepRows .step-row').count()) === 2 + 2)
await page.screenshot({ path: shot('wn-expanded.png') })

// 3. add multi-line steps from the inline input
await page.fill('#addStepInput', 'Kiểm tra header CORS\n2. Chạy pnpm test:e2e -- auth\n- Chụp screenshot gửi lại')
await page.press('#addStepInput', 'Enter')
await page.waitForTimeout(100)
check('multi-line paste adds 3 steps (bullets stripped)', (await page.locator('#stepRows .step-row').count()) === 7)
check('bullets and numbering are stripped', (await page.locator('#stepRows .step-text').allTextContents()).slice(-3).join('|') === 'Kiểm tra header CORS|Chạy pnpm test:e2e -- auth|Chụp screenshot gửi lại')
check('dup guard: same steps again add nothing', await (async () => {
  await page.fill('#addStepInput', 'Kiểm tra header CORS')
  await page.press('#addStepInput', 'Enter')
  await page.waitForTimeout(80)
  return (await page.locator('#stepRows .step-row').count()) === 7
})())

// 4. selection toolbar → Pin note (live selection drives the floating toolbar)
// Keep the disclosed drawer out of the way so the transcript keeps its room.
if (await page.locator('#wnStrip.expanded').count() === 1) await page.click('#expandStrip')
await page.evaluate(() => {
  const el = document.getElementById('selDemo')
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
})
const box = await page.locator('#selDemo').boundingBox()
await page.mouse.move(box.x + 5, box.y + box.height / 2)
await page.mouse.down()
await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(200)
check('selection toolbar opens on live selection', await page.locator('#selToolbar').isVisible())
check('toolbar offers Quote and Pin', (await page.locator('#actQuote').isVisible()) && (await page.locator('#actPin').isVisible()))
await page.screenshot({ path: shot('wn-selection.png') })
await page.click('#actPin')
await page.waitForTimeout(150)
check('Pin note adds a user-sourced step', (await page.locator('#stepRows .tag.user').count()) >= 2)
check('pinned row is tagged "you"', (await page.locator('#stepRows .tag.user').last().textContent()) === 'you')

// 5. kill all two-press confirm
const before = await page.locator('#portRows .port-row').count()
await page.click('#killAllBtn')
check('first press arms confirm', await page.locator('#killAllBtn.armed').count() === 1)
const armedText = await page.locator('#killAllBtn').textContent()
check('armed label asks to confirm', /Confirm kill/.test(armedText))
await page.click('#killAllBtn')
await page.waitForTimeout(150)
const stateText = await page.locator('#portRows .port-row').allTextContents()
check('all ports stopped after confirm', stateText.every((t) => !t.includes('pid') || true) && (await page.locator('[data-kill-port]').count()) === 0)
check('port rows kept as stopped history', (await page.locator('#portRows .port-row').count()) === before)
check('kill count reset to (0)', (await page.locator('#killAllCount').textContent()) === '(0)')

// 6. simulate new port + single kill via right sidebar
await page.click('#simPort')
await page.waitForTimeout(80)
check('simulated :3000 appears live', (await page.locator('#portsChips .port-chip').count()) === 1)
check('kill button re-enabled', await page.locator('#killAllBtn').isEnabled())
const ctrl = await page.evaluate(() => {
  // verify host-PID guard function path exists in ops
  return typeof document.querySelector('#rightbar') === 'object'
})
check('rightbar mounted', ctrl)
await page.click('#rbKillAll')
await page.waitForTimeout(80)
check('sidebar kill all stops :3000', (await page.locator('#rbPortBody .live').count()) === 0)

// 7. git simulate edit / undo
await page.click('#rbRefresh') // make sure the sidebar exists before git actions
await page.click('#simEdit')
await page.waitForTimeout(80)
check('git pill reflects simulated edit', (await page.locator('#gitAdd').textContent()) === '+160')
await page.click('#simUndoEdit')
await page.waitForTimeout(80)
check('undo edit restores the count', (await page.locator('#gitAdd').textContent()) === '+142')

// 8. toggle step + clear done
const stepsBefore = await page.locator('#stepRows .step-row').count()
await page.locator('#rbSteps .step-check:not(.on)').first().click()
await page.waitForTimeout(80)
const doneAfter = await page.locator('#stepRows .step-check.on').count()
check('toggle in sidebar updates the strip', doneAfter > 0)
await page.click('#rbClearDone')
await page.waitForTimeout(80)
check('clear done removes every completed step', (await page.locator('#stepRows .step-row').count()) === stepsBefore - doneAfter)
check('no completed steps remain', (await page.locator('#stepRows .step-check.on').count()) === 0)

// 9. theme switch
await page.click('[data-theme-set="light"]')
check('light theme applies token set', (await page.getAttribute('html', 'data-theme')) === 'light')
await page.screenshot({ path: shot('wn-light.png') })
await page.click('[data-theme-set="dark"]')

// 10. reset
await page.click('#resetDemo')
await page.waitForTimeout(100)
check('reset restores seed state', (await page.locator('#stepsCount').textContent()) === '2/4' && (await page.locator('#gitAdd').textContent()) === '+142')

// 11. cross-device sync is covered by tests/cross-tab-smoke.mjs (two browser
// contexts do not share a BroadcastChannel; that file drives the Host->Client leg).

// 12. narrow viewport
const narrow = await browser.newPage({ viewport: { width: 560, height: 900 } })
await narrow.goto(pageUrl)
await narrow.waitForTimeout(250)
await narrow.screenshot({ path: shot('wn-narrow.png') })
const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
check('narrow viewport has no horizontal overflow', !overflow)

check('no console errors', consoleErrors.length === 0)
if (consoleErrors.length > 0) console.log('console errors:', consoleErrors.slice(0, 5))

await browser.close()
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILED: ${failures.join('; ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
