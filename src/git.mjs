/**
 * Git / worktree inspector.
 *
 * Reads the Session's checkout through the Host's subprocess service with a
 * literal argv array, so the Session's sandbox policy applies and no shell
 * interpolates a path. It reports whether the checkout is a linked worktree,
 * which branch is out, and two line deltas: uncommitted work against `HEAD`,
 * and the branch against its base.
 *
 * Parsing is exported separately from the runner, so the wire formats are unit
 * tested without spawning Git.
 */

/** Bytes one git command may produce before its output is truncated. */
const MAX_OUTPUT = 4 * 1024 * 1024
/** Untracked files inspected for their line counts. */
const MAX_UNTRACKED = 200
/** Bytes of one untracked file counted before it is treated as binary/large. */
const MAX_UNTRACKED_BYTES = 512 * 1024

/**
 * Parse `git diff --numstat -z`.
 *
 * One entry is `<added>\t<deleted>\t<path>\0`; a rename writes an empty path
 * field and then the old and new names as further NUL-separated parts. Binary
 * files carry `-` for both counts and contribute a file with zero lines.
 * @param {string} text - the command's standard output.
 * @returns {{ added: number, deleted: number, files: number }}
 */
export function parseNumstat(text) {
  const counts = { added: 0, deleted: 0, files: 0 }
  if (typeof text !== 'string' || text === '') return counts
  const parts = text.split('\0')
  for (let i = 0; i < parts.length; i += 1) {
    const chunk = parts[i]
    if (chunk === '' || chunk === '\n') continue
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(chunk)
    if (match === null) continue
    counts.files += 1
    if (match[3] === '' && parts[i + 1] === '') i += 2
    if (match[1] !== '-') counts.added += Number(match[1])
    if (match[2] !== '-') counts.deleted += Number(match[2])
  }
  return counts
}

/**
 * Count the added lines of a file git does not track.
 * @param {string} content - the file's text.
 * @returns {number} added lines; a trailing newline starts no extra line.
 */
export function countNewFileLines(content) {
  if (typeof content !== 'string' || content === '') return 0
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * @param {object} ctx - Cordis context (reads `subprocess` and, optionally, `fs`).
 * @param {object} config - resolved plugin configuration.
 */
export function createGitInspector(ctx, config) {
  /** @type {string | null | undefined} */
  let gitPath

  /**
   * Run one git command in a plain directory.
   * @param {string} cwd
   * @param {string[]} argv - arguments after `git`.
   * @returns {Promise<{ ok: boolean, text: string }>}
   */
  async function git(cwd, argv, signal) {
    const subprocess = ctx.get?.('subprocess')
    if (subprocess === undefined) return { ok: false, text: '' }
    if (gitPath === undefined) {
      gitPath = await subprocess.resolveExecutable('git', undefined, signal).catch(() => null)
    }
    if (gitPath === null) return { ok: false, text: '' }
    const deadline = new AbortController()
    const link = signal === undefined ? undefined : AbortSignal.any?.([signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(), config.gitTimeoutMs)
    timer.unref?.()
    try {
      const handle = subprocess.spawn({
        argv: [gitPath, ...argv],
        cwd,
        signal: link ?? deadline.signal,
        graceMs: Math.min(config.gitTimeoutMs, 5_000),
        env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: MAX_OUTPUT },
          stderr: { maxBytes: 64 * 1024 },
        },
      })
      const outcome = await handle.done.catch(() => ({ exitCode: 1 }))
      const read = handle.collected.stdout?.readFrom(0)
      return { ok: outcome.exitCode === 0, text: read?.text ?? '' }
    } catch {
      return { ok: false, text: '' }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Inspect one directory.
   * @param {string} cwd - the Session's effective directory.
   * @param {AbortSignal} [signal] - plugin/session lifetime.
   * @returns {Promise<import('./record-types.mjs').GitSnapshot>}
   */
  async function inspect(cwd, signal) {
    const stamp = Date.now()
    const base = {
      cwd,
      isGitRepo: false,
      isWorktree: false,
      uncommitted: { added: 0, deleted: 0, files: 0 },
      updatedAt: stamp,
    }
    const top = await git(cwd, ['rev-parse', '--show-toplevel'], signal)
    if (!top.ok) return base
    const [gitDir, commonDir, head] = await Promise.all([
      git(cwd, ['rev-parse', '--absolute-git-dir'], signal),
      git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal),
      git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal),
    ])
    const isWorktree = gitDir.ok && commonDir.ok
      && trimSlash(gitDir.text) !== trimSlash(commonDir.text)
    let branch
    if (head.ok && head.text.trim() !== '') {
      branch = head.text.trim()
    } else {
      const short = await git(cwd, ['rev-parse', '--short', 'HEAD'], signal)
      if (short.ok && short.text.trim() !== '') branch = `HEAD@${short.text.trim()}`
    }
    const snapshot = { ...base, isGitRepo: true, isWorktree, repoRoot: trimSlash(top.text) }
    if (branch !== undefined) snapshot.branch = branch
    snapshot.uncommitted = await workingTreeDelta(cwd, signal)
    const baseRef = await resolveBase(cwd, isWorktree, signal)
    if (baseRef !== undefined) {
      snapshot.baseRef = baseRef.ref
      snapshot.branchDelta = await deltaAgainst(cwd, baseRef.commit, signal)
    }
    return snapshot
  }

  /**
   * Uncommitted delta: tracked changes against `HEAD` (or the index on an unborn
   * branch) plus the line counts of untracked text files.
   * @param {string} cwd
   * @param {AbortSignal} [signal]
   */
  async function workingTreeDelta(cwd, signal) {
    const tracked = await git(cwd, ['diff', '--numstat', '-z', 'HEAD'], signal)
    const staged = tracked.ok ? undefined : await git(cwd, ['diff', '--cached', '--numstat', '-z'], signal)
    const counts = tracked.ok ? parseNumstat(tracked.text) : parseNumstat(staged?.text ?? '')
    const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], signal)
    if (!untracked.ok) return counts
    const paths = untracked.text.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED)
    const fs = ctx.get?.('fs')
    for (const rel of paths) {
      counts.files += 1
      if (fs === undefined) { counts.added += 1; continue }
      try {
        const target = await fs.resolve(`${cwd}/${rel}`, { signal })
        const text = await fs.readText(target, signal)
        if (typeof text === 'string' && !text.includes('\0') && Buffer.byteLength(text) <= MAX_UNTRACKED_BYTES) {
          counts.added += countNewFileLines(text)
        }
      } catch {
        counts.added += 1
      }
    }
    return counts
  }

  /**
   * Base to compare the branch with: the worktree's recorded base when the
   * Session's own worktree service wrote one, otherwise the default branch.
   * @param {string} cwd
   * @param {boolean} isWorktree
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ ref: string, commit: string } | undefined>}
   */
  async function resolveBase(cwd, isWorktree, signal) {
    if (isWorktree) {
      const described = await git(cwd, ['config', '--get', 'dsh.worktree.base'], signal)
      if (described.ok && described.text.trim() !== '') {
        const verify = await git(cwd, ['rev-parse', '--verify', '--quiet', `${described.text.trim()}^{commit}`], signal)
        if (verify.ok) return { ref: 'worktree base', commit: verify.text.trim() }
      }
    }
    const symref = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], signal)
    const candidates = symref.ok && symref.text.trim() !== ''
      ? [symref.text.trim(), 'origin/main', 'main']
      : ['origin/main', 'origin/master', 'main', 'master']
    for (const ref of candidates) {
      const verified = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], signal)
      if (!verified.ok) continue
      const merge = await git(cwd, ['merge-base', 'HEAD', ref], signal)
      if (merge.ok && merge.text.trim() !== '') return { ref, commit: merge.text.trim() }
    }
    return undefined
  }

  /**
   * Delta of the working tree against one commit (branch delta by default).
   * @param {string} cwd
   * @param {string} commit
   * @param {AbortSignal} [signal]
   */
  async function deltaAgainst(cwd, commit, signal) {
    const diff = await git(cwd, ['diff', '--numstat', '-z', commit], signal)
    return diff.ok ? parseNumstat(diff.text) : { added: 0, deleted: 0, files: 0 }
  }

  return { inspect }
}

/** @param {string} text */
function trimSlash(text) {
  return text.trim().replace(/\/+$/, '')
}
