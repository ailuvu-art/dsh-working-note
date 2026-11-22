/**
 * Persistence adapter between the service and `ctx.storageDomain`.
 *
 * The domain handle is either the real one opened from `ctx.storageDomain`
 * (`{ table(name) }` with synchronous `get`/`entries` and async `put`/`delete`),
 * or a plain in-memory table supplied by tests. Writes are serialised per
 * Session by the caller; this module only owns the record lifecycle and the
 * batching of the cross-Subagent save path.
 *
 * @typedef {import('./domain.mjs').SessionRecord} SessionRecord
 * @typedef {{ get: (k: string) => SessionRecord | undefined, entries: () => IterableIterator<[string, SessionRecord]>, put: (k: string, v: SessionRecord) => Promise<void>, delete: (k: string) => Promise<unknown>, size: number }} Table
 */

/** @returns {Table} a table backed by a Map, for tests and for a Host without a domain. */
export function memoryTable() {
  const map = new Map()
  return {
    get: key => map.get(key),
    entries: () => map.entries(),
    put: async (key, value) => { map.set(key, value) },
    delete: async (key) => map.delete(key),
    get size() { return map.size },
  }
}

/**
 * Wrap a domain handle from `ctx.storageDomain.open`.
 * @param {{ table: (name: string) => Table, close: () => Promise<void> }} domain
 * @returns {{ table: Table, close: () => Promise<void> }}
 */
export function fromDomain(domain) {
  return { table: domain.table('sessions'), close: () => domain.close() }
}
