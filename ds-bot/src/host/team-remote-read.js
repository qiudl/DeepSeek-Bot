// A Profile-local projection for the Slark Host. No browser route uses this service.
const SCHEMA = 'dsh-remote-bot-read/v1'
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/u
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u
const MAX_RESULT_BYTES = 128 * 1024

const row = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const invalid = () => Object.assign(new Error('Invalid remote Bot team request'), { code: 'bot/invalid' })

function readCursor(value, revision) {
  if (value === undefined) return 0
  if (typeof value !== 'string' || !CURSOR.test(value)) throw invalid()
  let decoded
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value || bytes.length > 256) throw invalid()
    decoded = JSON.parse(bytes.toString('utf8'))
  } catch { throw invalid() }
  if (!row(decoded) || !exact(decoded, ['revision', 'offset']) ||
      !Number.isSafeInteger(decoded.revision) || decoded.revision !== revision ||
      !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) {
    throw Object.assign(new Error('Remote Bot team cursor is stale'), { code: 'bot/stale' })
  }
  return decoded.offset
}

export function parseRemoteTeamRead(value) {
  if (!row(value) || value.schema_version !== SCHEMA || value.kind !== 'team' ||
      Object.keys(value).some(key => !['schema_version', 'kind', 'cursor', 'limit'].includes(key)) ||
      (Object.hasOwn(value, 'limit') && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100)) ||
      (Object.hasOwn(value, 'cursor') && (typeof value.cursor !== 'string' || !CURSOR.test(value.cursor)))) throw invalid()
  return { limit: value.limit ?? 50, cursor: value.cursor }
}

/** One bounded roster page, with no model, path, instruction, permission or secret fields. */
export function projectRemoteTeam(state, request, now = Date.now) {
  if (!row(state) || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !row(state.bots) || !row(state.rooms) || !Array.isArray(state.mainBotIds)) throw invalid()
  if (Object.keys(state.bots).length + Object.keys(state.rooms).length > 10_000) throw invalid()
  const { limit, cursor } = parseRemoteTeamRead(request)
  const offset = readCursor(cursor, state.revision)
  const bots = Object.entries(state.bots).map(([key, bot]) => {
    if (!row(bot) || bot.id !== key || !ID.test(key) ||
        typeof bot.name !== 'string' || Buffer.byteLength(bot.name, 'utf8') > 512 ||
        typeof bot.role !== 'string' || Buffer.byteLength(bot.role, 'utf8') > 1024) throw invalid()
    return { kind: 'bot', logical_id: `bot:${bot.id}`, name: bot.name,
      role: bot.role, main: state.mainBotIds.includes(bot.id) }
  })
  const known = new Set(bots.map(bot => bot.logical_id))
  if (!state.mainBotIds.every(id => typeof id === 'string' && known.has(`bot:${id}`))) throw invalid()
  const rooms = Object.entries(state.rooms).map(([key, room]) => {
    if (!row(room) || room.id !== key || !ID.test(key) ||
        typeof room.name !== 'string' || Buffer.byteLength(room.name, 'utf8') > 512 ||
        !Array.isArray(room.members) || room.members.length > 100 ||
        !room.members.every(id => typeof id === 'string' && known.has(`bot:${id}`))) throw invalid()
    return { kind: 'room', logical_id: `room:${room.id}`, name: room.name,
      members: room.members.map(id => `bot:${id}`) }
  })
  const items = [...bots, ...rooms].sort((a, b) => a.logical_id < b.logical_id ? -1 : a.logical_id > b.logical_id ? 1 : 0)
  if (offset > items.length) throw Object.assign(new Error('Remote Bot team cursor is stale'), { code: 'bot/stale' })
  const next = offset + limit
  const value = { team_revision: state.revision,
    next_cursor: next < items.length ? Buffer.from(JSON.stringify({ revision: state.revision, offset: next })).toString('base64url') : null,
    items: items.slice(offset, next), source: 'authority', last_confirmed_at: new Date(now()).toISOString() }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RESULT_BYTES) throw invalid()
  return value
}

export function install(rt) {
  rt.ctx.effect(() => rt.ctx.provide('dsBotSlarkRemoteRead', {
    async read(request, signal) {
      signal?.throwIfAborted()
      await rt.refresh()
      signal?.throwIfAborted()
      if (!rt.exclusiveWriter()) throw Object.assign(new Error('Bot team authority unavailable'), { code: 'bot/read-only' })
      return projectRemoteTeam(rt.state, request)
    },
  }), 'ds-bot: remote read')
}
