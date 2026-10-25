// A Profile-local projection for the Slark Host. No browser route uses this service.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createGroupHistory } from './group-history.js'
import { readBoundedSourceSession } from './team-import-source.js'
import { projectRemoteBotChat, projectRemoteBotChatAttachments } from './team-remote-bot-chat-page.js'
const SCHEMA = 'dsh-remote-bot-read/v1'
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/u
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u
const MAX_RESULT_BYTES = 60 * 1024
const MEMORY_CHUNK_BYTES = 32 * 1024
const MEMORY_FILE_BYTES = 1_000_000
const MEMORY_TOTAL_BYTES = 64_000_000
const MEMORY_FILE = /^(?:MEMORY|[\p{L}\p{N}][\p{L}\p{N}_-]{0,47})\.md$/u
const DIGEST = /^[0-9a-f]{64}$/u

const row = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const invalid = () => Object.assign(new Error('Invalid remote Bot team request'), { code: 'bot/invalid' })
const stale = () => Object.assign(new Error('Remote Bot group history changed'), { code: 'bot/stale' })
const incomplete = () => Object.assign(new Error('Source group history incomplete'), { code: 'bot/incomplete' })

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

export function parseRemoteMemoryRead(value) {
  if (!row(value) || value.schema_version !== SCHEMA || value.kind !== 'memory' ||
      typeof value.logical_id !== 'string' ||
      value.logical_id !== 'team' && !/^(?:bot|room):[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/u.test(value.logical_id) ||
      Object.keys(value).some(key => !['schema_version', 'kind', 'logical_id', 'cursor', 'limit'].includes(key)) ||
      (Object.hasOwn(value, 'limit') && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100)) ||
      (Object.hasOwn(value, 'cursor') && (typeof value.cursor !== 'string' || !CURSOR.test(value.cursor)))) throw invalid()
  return { logicalId: value.logical_id, cursor: value.cursor }
}

export function parseRemoteGroupHistoryRead(value) {
  if (!row(value) || value.schema_version !== SCHEMA || value.kind !== 'group-history' ||
      typeof value.logical_id !== 'string' || !/^room:[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/u.test(value.logical_id) ||
      Object.keys(value).some(key => !['schema_version', 'kind', 'logical_id', 'cursor', 'limit'].includes(key)) ||
      (Object.hasOwn(value, 'limit') && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 32 * 1024)) ||
      (Object.hasOwn(value, 'cursor') && (typeof value.cursor !== 'string' || !CURSOR.test(value.cursor)))) throw invalid()
  return { roomId: value.logical_id.slice(5), limit: value.limit ?? 32 * 1024, cursor: value.cursor }
}

function groupCursor(value, room) {
  if (value === undefined) return 0
  let decoded
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value || bytes.length > 256) throw invalid()
    decoded = JSON.parse(bytes.toString('utf8'))
  } catch { throw invalid() }
  if (!row(decoded) || !exact(decoded, ['seq', 'digest', 'offset']) ||
      !Number.isSafeInteger(decoded.seq) || !DIGEST.test(decoded.digest) ||
      !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw invalid()
  if (decoded.seq !== room.seq || decoded.digest !== room.historyJournal?.digest) throw stale()
  return decoded.offset
}

/** One committed byte slice; the receiver verifies JSONL records after reassembly. */
export function projectRemoteGroupHistory(state, home, request, now = Date.now, history) {
  const { roomId, limit, cursor } = parseRemoteGroupHistoryRead(request)
  const room = state?.rooms?.[roomId]
  if (!row(room) || room.id !== roomId || !Number.isSafeInteger(room.seq) || room.seq < 0) throw invalid()
  const offset = groupCursor(cursor, room)
  let page
  if (room.seq === 0 && room.historyJournal === undefined && (room.log?.length ?? 0) === 0) {
    if (offset !== 0) throw stale()
    page = { complete: true, seq: 0, digest: createHash('sha256').update('').digest('hex'),
      totalBytes: 0, content: Buffer.alloc(0) }
  } else {
    if (!row(room.historyJournal)) throw incomplete()
    try { page = (history ?? createGroupHistory(home, () => false)).readChunk(room, offset, limit) }
    catch { throw incomplete() }
  }
  const next = offset + page.content.length < page.totalBytes
    ? Buffer.from(JSON.stringify({ seq: page.seq, digest: page.digest,
      offset: offset + page.content.length })).toString('base64url') : null
  const result = { logical_id: `room:${roomId}`, seq: page.seq, digest: page.digest,
    complete: page.complete, total_bytes: page.totalBytes, offset,
    content_base64: page.content.toString('base64'), next_cursor: next,
    source: 'authority', last_confirmed_at: new Date(now()).toISOString() }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES) throw invalid()
  return result
}

async function regularDirectory(path) {
  try {
    if (!(await lstat(path)).isDirectory()) throw invalid()
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function memoryFiles(home, logicalId) {
  const root = join(home, 'memory')
  const [kind, id] = logicalId === 'team' ? ['team'] : logicalId.split(':')
  const parent = kind === 'team' ? root : join(root, kind === 'bot' ? 'bots' : 'groups')
  const dir = kind === 'team' ? join(root, 'team') : join(parent, id)
  if (!await regularDirectory(root) || !await regularDirectory(parent) || !await regularDirectory(dir)) return []
  const names = await readdir(dir, { withFileTypes: true })
  if (names.length > 41 || names.some(entry => !entry.isFile() || !MEMORY_FILE.test(entry.name) ||
      entry.name !== 'MEMORY.md' && entry.name !== entry.name.toLowerCase())) throw invalid()
  const files = []
  let total = 0
  for (const name of names.map(entry => entry.name).sort()) {
    const handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MEMORY_FILE_BYTES || total + stat.size > MEMORY_TOTAL_BYTES) throw invalid()
      const content = await handle.readFile()
      if (content.length !== stat.size) throw Object.assign(new Error('Memory changed during read'), { code: 'bot/stale' })
      total += content.length
      files.push({ name, content, sha256: createHash('sha256').update(content).digest('hex') })
    } finally { await handle.close() }
  }
  return files
}

function memoryCursor(value, digest) {
  if (value === undefined) return { index: 0, offset: 0 }
  let decoded
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value || bytes.length > 256) throw invalid()
    decoded = JSON.parse(bytes.toString('utf8'))
  } catch { throw invalid() }
  if (!row(decoded) || !exact(decoded, ['digest', 'index', 'offset']) || !DIGEST.test(decoded.digest) ||
      !Number.isSafeInteger(decoded.index) || decoded.index < 0 ||
      !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw invalid()
  if (decoded.digest !== digest) throw Object.assign(new Error('Remote Bot memory cursor is stale'), { code: 'bot/stale' })
  return decoded
}

/** One binary-safe chunk of a logical memory scope, bound to its complete file digest. */
export async function projectRemoteMemory(state, home, request, now = Date.now) {
  const { logicalId, cursor } = parseRemoteMemoryRead(request)
  const [kind, id] = logicalId.split(':')
  if (logicalId !== 'team' && (kind === 'bot' ? state?.bots?.[id]?.id !== id :
    kind === 'room' ? state?.rooms?.[id]?.id !== id : true)) throw invalid()
  const files = await memoryFiles(home, logicalId)
  const hash = createHash('sha256')
  for (const file of files) hash.update(file.name).update('\0').update(file.sha256).update('\0')
  const digest = hash.digest('hex')
  const { index, offset } = memoryCursor(cursor, digest)
  if (index > files.length || index === files.length && offset !== 0) throw Object.assign(new Error('Remote Bot memory cursor is stale'), { code: 'bot/stale' })
  const file = files[index]
  if (file && offset >= file.content.length && offset !== 0) throw Object.assign(new Error('Remote Bot memory cursor is stale'), { code: 'bot/stale' })
  const end = file === undefined ? 0 : Math.min(offset + MEMORY_CHUNK_BYTES, file.content.length)
  const next = file === undefined ? null : end < file.content.length ? { digest, index, offset: end } :
    index + 1 < files.length ? { digest, index: index + 1, offset: 0 } : null
  const result = { logical_id: logicalId, scope_revision: digest,
    next_cursor: next === null ? null : Buffer.from(JSON.stringify(next)).toString('base64url'),
    item: file === undefined ? null : { file: file.name, offset, total_bytes: file.content.length,
      sha256: file.sha256, content_base64: file.content.subarray(offset, end).toString('base64') },
    source: 'authority', last_confirmed_at: new Date(now()).toISOString() }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES) throw invalid()
  return result
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
  const confirmed = new Date(now()).toISOString()
  const page = end => ({ team_revision: state.revision,
    next_cursor: end < items.length ? Buffer.from(JSON.stringify({ revision: state.revision, offset: end })).toString('base64url') : null,
    items: items.slice(offset, end), source: 'authority', last_confirmed_at: confirmed })
  const fits = value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_RESULT_BYTES
  let end = Math.min(offset + limit, items.length)
  let value = page(end)
  if (!fits(value)) {
    let lower = offset, upper = end
    while (lower + 1 < upper) {
      const middle = Math.floor((lower + upper) / 2)
      if (fits(page(middle))) lower = middle
      else upper = middle
    }
    if (lower === offset) throw invalid()
    end = lower
    value = page(end)
  }
  return value
}

export function install(rt) {
  const history = createGroupHistory(rt.home, () => false)
  rt.ctx.effect(() => rt.ctx.provide('dsBotSlarkRemoteRead', {
    async read(request, signal) {
      signal?.throwIfAborted()
      await rt.refresh()
      signal?.throwIfAborted()
      if (!rt.exclusiveWriter()) throw Object.assign(new Error('Bot team authority unavailable'), { code: 'bot/read-only' })
      if (request?.kind === 'team') return projectRemoteTeam(rt.state, request)
      if (request?.kind === 'memory') return projectRemoteMemory(rt.state, rt.home, request)
      if (request?.kind === 'group-history') {
        const committed = JSON.parse(await readFile(rt.statePath, 'utf8'))
        signal?.throwIfAborted()
        const result = projectRemoteGroupHistory(committed, rt.home, request, Date.now, history)
        if (!rt.exclusiveWriter()) throw Object.assign(new Error('Bot team authority unavailable'), { code: 'bot/read-only' })
        return result
      }
      if (request?.kind === 'bot-chat') {
        const committed = JSON.parse(await readFile(rt.statePath, 'utf8'))
        signal?.throwIfAborted()
        const result = await projectRemoteBotChat(committed, request,
          id => readBoundedSourceSession(rt.ctx, id))
        signal?.throwIfAborted()
        if (!rt.exclusiveWriter()) throw Object.assign(new Error('Bot team authority unavailable'), { code: 'bot/read-only' })
        return result
      }
      if (request?.kind === 'bot-chat-attachments') {
        const committed = JSON.parse(await readFile(rt.statePath, 'utf8'))
        signal?.throwIfAborted()
        const result = await projectRemoteBotChatAttachments(committed, request,
          id => readBoundedSourceSession(rt.ctx, id))
        signal?.throwIfAborted()
        if (!rt.exclusiveWriter()) throw Object.assign(new Error('Bot team authority unavailable'), { code: 'bot/read-only' })
        return result
      }
      throw invalid()
    },
  }), 'ds-bot: remote read')
}
