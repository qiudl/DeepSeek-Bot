// Current-team Bot selectors only; Session IDs never come from a remote request.
import { createHash } from 'node:crypto'
import { projectTextBotChatPart } from './team-remote-bot-chat.js'

const SCHEMA = 'dsh-remote-bot-read/v1'
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const LOGICAL_ID = /^bot:([A-Za-z0-9][A-Za-z0-9._-]{0,122})$/u
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const MAX_PARTS = 10_000
const MAX_RESULT_BYTES = 60 * 1024
const row = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const error = (code, message) => Object.assign(new Error(message), { code })
const invalid = () => { throw error('bot/invalid', 'Invalid remote Bot chat request') }
const stale = () => { throw error('bot/stale', 'Remote Bot chat changed') }
const incomplete = () => { throw error('bot/incomplete', 'Source Bot chat incomplete') }

export function parseRemoteBotChatRead(value) {
  if (!row(value) || !exact(value, ['schema_version', 'kind', 'logical_id', 'part', 'limit',
    ...(Object.hasOwn(value, 'cursor') ? ['cursor'] : [])]) ||
      value.schema_version !== SCHEMA || value.kind !== 'bot-chat' ||
      typeof value.logical_id !== 'string' || !LOGICAL_ID.test(value.logical_id) ||
      !Number.isSafeInteger(value.part) || value.part < 0 || value.part >= MAX_PARTS ||
      !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 32 * 1024 ||
      (value.cursor !== undefined && (typeof value.cursor !== 'string' || !CURSOR.test(value.cursor)))) invalid()
  return { logicalId: value.logical_id, part: value.part, limit: value.limit,
    cursor: value.cursor }
}

function partsOf(state, logicalId) {
  const id = logicalId.slice(4)
  const bot = state?.bots?.[id]
  if (!row(bot) || bot.id !== id || !Array.isArray(bot.segments ?? []) ||
      !Number.isSafeInteger(state.revision) || state.revision < 0) invalid()
  const ids = [...new Set([id, ...(bot.segments ?? []).map(part => part?.sessionId),
    bot.sessionId ?? id])]
  if (ids.length < 1 || ids.length > MAX_PARTS || ids.some(part => !SESSION_ID.test(part))) invalid()
  const selected = new Set(ids)
  for (const [otherId, other] of Object.entries(state.bots)) {
    if (otherId === id) continue
    if (!row(other) || !Array.isArray(other.segments ?? [])) invalid()
    const otherParts = [otherId, other.sessionId ?? otherId,
      ...(other.segments ?? []).map(part => part?.sessionId)]
    if (otherParts.some(part => selected.has(part))) invalid()
  }
  for (const [roomId, room] of Object.entries(state.rooms ?? {})) {
    if (!row(room) || !row(room.sessions ?? {}) || !row(room.segments ?? {})) invalid()
    const roomParts = [roomId, ...Object.values(room.sessions ?? {}),
      ...Object.values(room.segments ?? {}).flatMap(parts => {
        if (!Array.isArray(parts)) invalid()
        return parts.map(part => part?.sessionId)
      })]
    if (roomParts.some(part => selected.has(part))) invalid()
  }
  return ids
}

function cursorOffset(value, revision, part, eventDigest, rowsDigest) {
  if (value === undefined) return 0
  let decoded
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value || bytes.length > 384) invalid()
    decoded = JSON.parse(bytes.toString('utf8'))
  } catch { invalid() }
  if (!row(decoded) || !exact(decoded, ['r', 'p', 'e', 'd', 'o']) ||
      !Number.isSafeInteger(decoded.r) || !Number.isSafeInteger(decoded.p) ||
      typeof decoded.e !== 'string' || !DIGEST.test(decoded.e) ||
      typeof decoded.d !== 'string' || !DIGEST.test(decoded.d) ||
      !Number.isSafeInteger(decoded.o) || decoded.o < 0) invalid()
  if (decoded.r !== revision || decoded.p !== part ||
      decoded.e !== eventDigest || decoded.d !== rowsDigest) stale()
  return decoded.o
}

export async function projectRemoteBotChat(state, request, readSession, now = Date.now) {
  const { logicalId, part, limit, cursor } = parseRemoteBotChatRead(request)
  const ids = partsOf(state, logicalId)
  if (part >= ids.length || typeof readSession !== 'function') invalid()
  let source, projected
  try {
    source = await readSession(ids[part])
    projected = projectTextBotChatPart(source.events, source.digest)
  } catch (cause) {
    if (cause?.message === 'Bot chat source changed') stale()
    incomplete()
  }
  if (source.eventCount !== projected.eventCount) incomplete()
  const bytes = Buffer.from(JSON.stringify(projected.rows), 'utf8')
  if (createHash('sha256').update(bytes).digest('hex') !== projected.rowsDigest) incomplete()
  const offset = cursorOffset(cursor, state.revision, part, projected.eventDigest, projected.rowsDigest)
  if (offset > bytes.length) stale()
  const content = bytes.subarray(offset, Math.min(offset + limit, bytes.length))
  const next = offset + content.length < bytes.length
    ? Buffer.from(JSON.stringify({ r: state.revision, p: part, e: projected.eventDigest,
      d: projected.rowsDigest, o: offset + content.length })).toString('base64url') : null
  const result = { logical_id: logicalId, part, part_count: ids.length,
    team_revision: state.revision, event_digest: projected.eventDigest,
    rows_digest: projected.rowsDigest, complete: true, total_bytes: bytes.length,
    offset, content_base64: content.toString('base64'), next_cursor: next,
    source: 'authority', last_confirmed_at: new Date(now()).toISOString() }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES) invalid()
  return result
}
