// Read a source Session through DSH's public persistence service, without write ownership.
import { createHash } from 'node:crypto'

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const MAX_EVENTS = 100_000
const MAX_BYTES = 64_000_000

/** The caller must run in the source Profile; no raw persistence paths are accepted. */
export async function readTeamImportSourceSession(ctx, id, plan) {
  if (typeof id !== 'string' || !SESSION_ID.test(id) ||
      !plan?.sessions || !Object.hasOwn(plan.sessions, id) ||
      typeof plan.sessions[id] !== 'string' || !SESSION_ID.test(plan.sessions[id]) ||
      !ctx?.sessionPersistence ||
      !['stat', 'open'].every(method => typeof ctx.sessionPersistence[method] === 'function')) {
    throw new Error('Invalid source Session reader')
  }
  const persistence = ctx.sessionPersistence
  const before = await persistence.stat(id)
  if (!before || before.header?.id !== id ||
      (before.sizeBytes !== undefined && before.sizeBytes > MAX_BYTES) ||
      (before.eventCount !== undefined && before.eventCount > MAX_EVENTS)) {
    throw new Error('Source Session missing or too large')
  }
  const handle = await persistence.open(id, 'read')
  let events
  try {
    if (handle.access !== 'read' || handle.id !== id || handle.header?.id !== id) {
      throw new Error('Source Session reader is not read-only')
    }
    const result = await handle.read(0, MAX_EVENTS + 1)
    if (!Array.isArray(result?.events) || result.events.length > MAX_EVENTS) {
      throw new Error('Source Session has too many events')
    }
    events = result.events
  } finally { await handle.close() }
  const after = await persistence.stat(id)
  if (!after || after.revision !== before.revision ||
      (after.eventCount !== undefined && after.eventCount !== events.length)) {
    throw new Error('Source Session changed during read')
  }
  const serialized = JSON.stringify(events)
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) {
    throw new Error('Source Session too large')
  }
  return { events, eventCount: events.length,
    digest: createHash('sha256').update(serialized).digest('hex') }
}
