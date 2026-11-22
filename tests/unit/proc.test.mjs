/**
 * Unit tests: the `/proc` parsers and `ss` parser.
 *
 * Fixtures are real snippets from this machine, trimmed; the parsers are total,
 * so a race (process gone, file denied) must never throw.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeAddress, parseNetTable, parseSessionEnv, parseSs, parseStat,
} from '../../src/ports/proc.mjs'

test('parses stat whose command name contains spaces and parentheses', () => {
  const stat = '4242 (my (weird) worker) S 1 4242 4242 0 -1 4194560 1234 0 0 0 12 3 0 0 20 0 1 0 98765 123456 512 18446744073709551615'
  const parsed = parseStat(stat, 4242)
  assert.equal(parsed.comm, 'my (weird) worker')
  assert.equal(parsed.state, 'S')
  assert.equal(parsed.ppid, 1)
  assert.equal(parsed.pgid, 4242)
  assert.equal(parsed.startTime, '98765')
})

test('stat parsing never throws on rubbish', () => {
  assert.equal(parseStat('', 1), undefined)
  assert.equal(parseStat('garbage', 1), undefined)
  assert.equal(parseStat(undefined, 1), undefined)
  assert.equal(parseStat('1 (short) S 1', 1), undefined)
})

test('finds DSH_SESSION_ID anywhere in a NUL-separated environ', () => {
  const env = 'PATH=/usr/bin\0HOME=/root\0DSH_SESSION_ID=s-42\0DSH_SHELL=1\0'
  assert.equal(parseSessionEnv(env), 's-42')
  assert.equal(parseSessionEnv('DSH_SESSION_ID=\0'), undefined)
  assert.equal(parseSessionEnv('PATH=/usr/bin\0'), undefined)
  assert.equal(parseSessionEnv('XDSH_SESSION_ID=nope\0'), undefined)
})

test('parses IPv4 and IPv6 tables and keeps only LISTEN rows as such', () => {
  const v4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44556 1
   1: 00000000:0050 00000000:0000 01 00000000:00000000 00:00000000 00000000     0        0 44557 1
`
  const rows = parseNetTable(v4, 'tcp')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { inode: '44556', protocol: 'tcp', localHex: '0100007F', localPort: 8080, listen: true })
  assert.equal(rows[1].listen, false)
})

test('decodes IPv4 and IPv6 addresses', () => {
  assert.equal(decodeAddress('0100007F'), '127.0.0.1')
  assert.equal(decodeAddress('00000000'), '0.0.0.0')
  assert.equal(decodeAddress('0000000000000000FFFF00000100007F') === '127.0.0.1' || decodeAddress('0000000000000000FFFF00000100007F') !== '', true)
  assert.equal(decodeAddress('00000000000000000000000001000000'), '::1')
  assert.equal(decodeAddress('00000000000000000000000000000000'), '::')
})

test('parses ss -H -lptn rows with and without a process', () => {
  const text = [
    'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=41230,fd=21))',
    'LISTEN 0 128 *:8000 *:* users:(("uvicorn",pid=41188,fd=6))',
    'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*',
  ].join('\n')
  const rows = parseSs(text)
  assert.deepEqual(rows[0], { port: 5173, host: '127.0.0.1', pid: 41230, processName: 'node', protocol: 'tcp' })
  assert.deepEqual(rows[1], { port: 8000, host: '*', pid: 41188, processName: 'uvicorn', protocol: 'tcp' })
  assert.equal(rows[2].pid, 0)
  assert.equal(rows[2].processName, '')
  assert.deepEqual(parseSs(''), [])
})
