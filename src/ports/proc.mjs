/**
 * `/proc` parsers used by the port monitor and the kill guard.
 *
 * Every reader is total: a missing file, a permission denial, or a process
 * that exited between two reads yields `undefined` rather than throwing, so one
 * racing process can never break a scan.
 */

import { readFile, readdir, readlink } from 'node:fs/promises'

/** @typedef {{ pid: number, ppid: number, pgid: number, state: string, comm: string, startTime: string }} ProcStat */

/**
 * Parse `/proc/<pid>/stat`.
 *
 * The command name sits in parentheses and may itself contain spaces and
 * parentheses, so the fields after it are counted from the LAST `)`.
 * @param {string} text - the file's content.
 * @param {number} pid - the process the file belongs to.
 * @returns {ProcStat | undefined}
 */
export function parseStat(text, pid) {
  if (typeof text !== 'string') return undefined
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close <= open) return undefined
  const comm = text.slice(open + 1, close)
  const rest = text.slice(close + 2).trim().split(/\s+/)
  // rest[0] is field 3 (state); ppid=4, pgrp=5, starttime=22.
  if (rest.length < 20) return undefined
  return {
    pid,
    comm,
    state: rest[0],
    ppid: Number(rest[1]),
    pgid: Number(rest[2]),
    startTime: rest[19],
  }
}

/**
 * Read the session id a process inherited from the Harness shell environment.
 * @param {string} raw - `/proc/<pid>/environ` content (NUL separated).
 * @returns {string | undefined}
 */
export function parseSessionEnv(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  const match = /(?:^|\0)DSH_SESSION_ID=([^\0]+)/.exec(raw)
  return match?.[1]
}

/**
 * Parse one `/proc/net/tcp` or `/proc/net/tcp6` table.
 * @param {string} text - the table's content.
 * @returns {{ inode: string, localPort: number, localHex: string, listen: boolean, protocol: 'tcp' | 'tcp6' }[]}
 */
export function parseNetTable(text, protocol) {
  const out = []
  if (typeof text !== 'string') return out
  const lines = text.split('\n').slice(1)
  for (const line of lines) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) continue
    const local = fields[1] ?? ''
    const state = fields[3] ?? ''
    const inode = fields[9] ?? ''
    const [localHex, portHex] = local.split(':')
    if (localHex === undefined || portHex === undefined) continue
    out.push({
      inode,
      protocol,
      localHex,
      localPort: Number.parseInt(portHex, 16),
      listen: state === '0A',
    })
  }
  return out
}

/**
 * Decode a `/proc/net/tcp*` local address into a printable host.
 * @param {string} localHex
 * @returns {string}
 */
export function decodeAddress(localHex) {
  if (typeof localHex !== 'string') return '0.0.0.0'
  if (localHex.length === 8) {
    const bytes = []
    for (let i = 6; i >= 0; i -= 2) bytes.push(Number.parseInt(localHex.slice(i, i + 2), 16))
    return bytes.join('.')
  }
  if (localHex.length === 32) {
    const words = []
    for (let i = 0; i < 32; i += 8) {
      const word = localHex.slice(i, i + 8)
      const bytes = []
      for (let j = 6; j >= 0; j -= 2) bytes.push(word.slice(j, j + 2))
      words.push(bytes.join(''))
    }
    const joined = words.join('')
    if (joined === '00000000000000000000000000000001' || /^0{24}0+1$/.test(joined)) return '::1'
    if (/^0+$/.test(joined)) return '::'
    return '::'
  }
  return '0.0.0.0'
}

/**
 * Parse `ss -H -lptn` output.
 *
 * Columns are `State Recv-Q Send-Q Local:Port Peer:Port Process`; the process
 * column carries `users:(("name",pid=123,fd=4),…)`. Rows without a process are
 * kept with `pid: 0` so the caller can decide; the monitor drops them.
 * @param {string} text - standard output.
 * @returns {{ port: number, host: string, pid: number, processName: string, protocol: 'tcp' | 'tcp6' }[]}
 */
export function parseSs(text) {
  const out = []
  if (typeof text !== 'string') return out
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const fields = trimmed.split(/\s+/)
    const local = fields[3] ?? ''
    const lastColon = local.lastIndexOf(':')
    if (lastColon < 0) continue
    const host = local.slice(0, lastColon).replace(/^\[|\]$/g, '') || '*'
    const port = Number(local.slice(lastColon + 1))
    if (!Number.isInteger(port) || port <= 0) continue
    const users = /\(\("([^"]+)",pid=(\d+)/.exec(trimmed)
    out.push({
      port,
      host,
      pid: users === null ? 0 : Number(users[2]),
      processName: users === null ? '' : users[1],
      protocol: host.includes(':') ? 'tcp6' : 'tcp',
    })
  }
  return out
}

/** One process row the monitor needs; `undefined` fields mean "unreadable". */
/**
 * @typedef {object} ProcEntry
 * @property {number} pid
 * @property {string} comm
 * @property {number} ppid
 * @property {number} pgid
 * @property {string} startTime
 * @property {string | undefined} sessionId
 * @property {string | undefined} cwd
 * @property {string[]} socketInodes
 * @property {number} uid
 */

/**
 * Read one process directory.
 * @param {number} pid
 * @param {object} [io] - injectable readers (tests pass plain functions).
 * @returns {Promise<ProcEntry | undefined>}
 */
export async function readProcEntry(pid, io = defaultIo) {
  const statText = await io.readFile(`/proc/${pid}/stat`).catch(() => undefined)
  const stat = parseStat(statText, pid)
  if (stat === undefined) return undefined
  const [environ, cwd, fds, owner] = await Promise.all([
    io.readFile(`/proc/${pid}/environ`).catch(() => undefined),
    io.readlink(`/proc/${pid}/cwd`).catch(() => undefined),
    io.readdir(`/proc/${pid}/fd`).catch(() => []),
    io.readFile(`/proc/${pid}/status`).catch(() => undefined),
  ])
  const inodes = []
  for (const fd of fds) {
    if (!/^\d+$/.test(fd)) continue
    const link = await io.readlink(`/proc/${pid}/fd/${fd}`).catch(() => undefined)
    const match = link === undefined ? undefined : /^socket:\[(\d+)\]$/.exec(link)
    if (match !== null && match !== undefined) inodes.push(match[1])
  }
  return {
    pid,
    comm: stat.comm,
    ppid: stat.ppid,
    pgid: stat.pgid,
    startTime: stat.startTime,
    sessionId: parseSessionEnv(environ),
    cwd,
    socketInodes: inodes,
    uid: readUid(owner),
  }
}

/**
 * Every numeric directory under `/proc`.
 * @param {object} [io]
 * @returns {Promise<number[]>}
 */
export async function listPids(io = defaultIo) {
  const names = await io.readdir('/proc').catch(() => [])
  return names.filter(name => /^\d+$/.test(name)).map(Number)
}

/**
 * Read a short command preview from `/proc/<pid>/cmdline`.
 * @param {number} pid
 * @param {object} [io]
 * @param {number} [max] - maximum characters kept.
 * @returns {Promise<string>}
 */
export async function readCmdline(pid, io = defaultIo, max = 240) {
  const raw = await io.readFile(`/proc/${pid}/cmdline`).catch(() => '')
  const text = String(raw).split('\0').filter(Boolean).join(' ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Read `/proc/net/tcp` and `/proc/net/tcp6`.
 * @param {object} [io]
 * @returns {Promise<{ inode: string, localPort: number, localHex: string, listen: boolean, protocol: 'tcp' | 'tcp6' }[]>}
 */
export async function readNetTables(io = defaultIo) {
  const [v4, v6] = await Promise.all([
    io.readFile('/proc/net/tcp').catch(() => ''),
    io.readFile('/proc/net/tcp6').catch(() => ''),
  ])
  return [...parseNetTable(v4, 'tcp'), ...parseNetTable(v6, 'tcp6')]
}

/**
 * Effective uid of a `/proc/<pid>/status` body (`Uid:` real effective saved fs).
 * @param {string | undefined} text
 * @returns {number}
 */
function readUid(text) {
  if (typeof text !== 'string') return -1
  const match = /^Uid:\s+(\d+)/m.exec(text)
  return match === null ? -1 : Number(match[1])
}

/** Default file IO; tests replace it with a fixture. */
const defaultIo = {
  readFile: (path) => readFile(path, 'utf8'),
  readdir: (path) => readdir(path),
  readlink: (path) => readlink(path),
}

export { defaultIo }
