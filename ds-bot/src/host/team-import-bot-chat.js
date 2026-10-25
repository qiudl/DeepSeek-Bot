// Read-only evidence that every private Bot chat part can be opened before import.
import { readTeamImportSourceSession } from './team-import-source.js'
import { teamStateDigest } from './team-import-plan.js'

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const MAX_BOTS = 10_000
const MAX_PARTS = 10_000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = () => { throw new Error('Invalid Bot chat source') }

function partId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) invalid()
  return value
}

/** No event body or DSH header leaves this inventory. */
export async function inventorySourceBotChats(ctx, source, plan) {
  if (!object(source) || source.version !== 1 || !Number.isSafeInteger(source.revision) ||
      !object(source.bots) || Object.keys(source.bots).length > MAX_BOTS ||
      !object(source.rooms) || !object(plan?.sessions) ||
      plan.sourceRevision !== source.revision || plan.sourceDigest !== teamStateDigest(source)) {
    throw new Error('Bot chat source changed')
  }
  const forbidden = new Set()
  for (const [id, room] of Object.entries(source.rooms)) {
    if (!object(room) || room.id !== id || !object(room.sessions ?? {}) ||
        !object(room.segments ?? {})) invalid()
    forbidden.add(partId(id))
    for (const session of Object.values(room.sessions ?? {})) forbidden.add(partId(session))
    for (const parts of Object.values(room.segments ?? {})) {
      if (!Array.isArray(parts)) invalid()
      for (const part of parts) forbidden.add(partId(part?.sessionId))
    }
  }
  const owned = new Set()
  const bots = []
  for (const [id, bot] of Object.entries(source.bots).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    if (!object(bot) || bot.id !== id || !Array.isArray(bot.segments ?? [])) invalid()
    const ids = [...new Set([id, ...(bot.segments ?? []).map(part => part?.sessionId),
      bot.sessionId ?? id].map(partId))]
    if (ids.length + owned.size > MAX_PARTS || ids.some(part => forbidden.has(part) || owned.has(part))) invalid()
    for (const part of ids) owned.add(part)
    if (ids.some(part => !Object.hasOwn(plan.sessions, part))) throw new Error('Incomplete Bot chat plan')
    const parts = []
    for (const [index, sourceSessionId] of ids.entries()) {
      const { eventCount, digest } = await readTeamImportSourceSession(ctx, sourceSessionId, plan)
      parts.push({ index, sourceSessionId, eventCount, digest })
    }
    bots.push({ logicalId: `bot:${id}`, parts })
  }
  if (teamStateDigest(source) !== plan.sourceDigest) throw new Error('Bot chat source changed')
  return { sourceDigest: plan.sourceDigest, bots }
}
