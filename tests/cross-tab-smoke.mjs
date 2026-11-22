/**
 * Cross-device sync check for mockup.html.
 *
 * Each DSH client is its own browser context with its own storage; two contexts
 * in one Chromium profile do not exchange BroadcastChannel messages, and
 * `file://` pages have no shared storage partition either. Reliable automation
 * therefore drives the Host -> Client leg through the mockup's own
 * `BroadcastChannel` handler: page B posts the same `{ kind: 'state' }` frame a
 * peer device posts, and page A must repaint from it.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { browserRuntime, skip } from './browser.mjs'

const runtime = browserRuntime()
if (runtime === null) skip('cross-tab smoke')
const { chromium, executablePath } = runtime

const here = dirname(fileURLToPath(import.meta.url))
const pageUrl = 'file://' + resolve(here, '..', 'mockup.html')

const failures = []
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const deviceA = await context.newPage()
await deviceA.goto(pageUrl)
await deviceA.waitForTimeout(250)
await deviceA.click('#expandStrip')
const before = await deviceA.locator('#stepRows .step-row').count()

// Device B runs the same operations the real UI POSTs, then fans them out the
// way the Host would: one full-state frame to every subscribed device.
const deviceB = await context.newPage()
await deviceB.goto(pageUrl)
await deviceB.waitForTimeout(250)
await deviceB.click('#expandStrip')
await deviceB.fill('#addStepInput', 'Bước từ thiết bị B')
await deviceB.press('#addStepInput', 'Enter')
await deviceB.waitForTimeout(150)
await deviceA.waitForTimeout(300)

check('frame from another device repaints the view',
  (await deviceA.locator('#stepRows .step-row').count()) === before + 1)
check('same step text arrives on the other device',
  (await deviceA.locator('#stepRows .step-text').last().textContent()) === 'Bước từ thiết bị B')
check('sync appends to the event log',
  (await deviceA.locator('#evlogBody').innerText()).includes('SSE tip từ thiết bị khác'))

// Kill-all fan-out: the peer device stops the ports, this device sees them stop.
await deviceB.click('#rbKillAll')
await deviceB.waitForTimeout(150)
await deviceA.waitForTimeout(300)
check('kill-all from another device marks the same ports stopped',
  (await deviceA.locator('#portRows [data-kill-port]').count()) === 0 && (await deviceA.locator('#portRows .port-row').count()) > 0)

await browser.close()
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILED: ${failures.join('; ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
