// Plan Session identity remapping before a selective import writes either team.
import { createHash } from 'node:crypto'
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function table(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('Invalid team Session reference')
  return value
}

export function teamStateDigest(state) {
  const canonical = JSON.stringify(state, (_key, value) => table(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, 'en')))
    : value)
  if (typeof canonical !== 'string') throw new Error('Unknown team format')
  return createHash('sha256').update(canonical).digest('hex')
}

function teamSessions(team, { includeAgents = true } = {}) {
  if (!table(team) || team.version !== 1 || !table(team.bots) || !table(team.rooms) ||
      !Array.isArray(team.mainBotIds) || !Number.isSafeInteger(team.revision)) {
    throw new Error('Unknown team format')
  }
  const ids = new Set()
  const owners = new Map()
  const add = (value, owner, include = true) => {
    const id = sessionId(value)
    if (owners.has(id) && owners.get(id) !== owner) throw new Error('Session belongs to multiple chats')
    owners.set(id, owner)
    if (include) ids.add(id)
  }
  for (const [key, bot] of Object.entries(team.bots)) {
    if (!table(bot) || bot.id !== key || !Array.isArray(bot.segments ?? [])) throw new Error('Invalid Bot')
    const owner = `bot:${key}`
    add(bot.id, owner)
    if (bot.sessionId !== undefined) add(bot.sessionId, owner)
    for (const part of bot.segments ?? []) add(part?.sessionId, owner)
  }
  for (const id of team.mainBotIds) {
    if (!Object.hasOwn(team.bots, id)) throw new Error('Unknown Main Bot')
  }
  for (const [key, room] of Object.entries(team.rooms)) {
    if (!table(room) || room.id !== key || !Array.isArray(room.members) ||
        !table(room.sessions ?? {}) || !table(room.segments ?? {})) throw new Error('Invalid group chat')
    add(room.id, `room:${key}`)
    for (const botId of room.members) {
      if (!Object.hasOwn(team.bots, botId)) throw new Error('Unknown group member')
    }
    if (room.admin !== undefined && room.admin !== null && !room.members.includes(room.admin)) {
      throw new Error('Unknown group admin')
    }
    for (const [botId, id] of Object.entries(room.sessions ?? {})) {
      if (!room.members.includes(botId)) throw new Error('Unknown group Session owner')
      add(id, `member:${key}:${botId}`)
    }
    for (const [botId, parts] of Object.entries(room.segments ?? {})) {
      if (!room.members.includes(botId) || !Array.isArray(parts)) throw new Error('Invalid group segments')
      for (const part of parts) add(part?.sessionId, `member:${key}:${botId}`)
    }
  }
  if (team.agents !== undefined && !table(team.agents)) throw new Error('Invalid DSH Agents')
  for (const agent of Object.values(team.agents ?? {})) {
    if (!table(agent) || !Array.isArray(agent.sessions)) throw new Error('Invalid DSH Agent')
    for (const id of agent.sessions) add(id, `agent:${agent.id}`, includeAgents)
  }
  return [...ids].sort()
}

/** Only plans a mapping. The caller persists and verifies it before any Session is created. */
export function planTeamImport(source, target, allocate, { occupiedSessionIds = [] } = {}) {
  const sourceIds = teamSessions(source, { includeAgents: false })
  const occupied = new Set(teamSessions(target))
  for (const id of occupiedSessionIds) occupied.add(sessionId(id))
  if (typeof allocate !== 'function') throw new Error('Missing Session ID allocator')
  const sessions = {}
  for (const from of sourceIds) {
    const to = sessionId(allocate(from))
    if (occupied.has(to)) throw new Error('Duplicate target Session ID')
    occupied.add(to)
    sessions[from] = to
  }
  return {
    sourceRevision: source.revision,
    targetRevision: target.revision,
    sourceDigest: teamStateDigest(source),
    targetDigest: teamStateDigest(target),
    sessions,
    mainBotIds: source.mainBotIds.map(id => sessions[id]),
    botIds: Object.keys(source.bots).map(id => sessions[id]),
    roomIds: Object.keys(source.rooms).map(id => sessions[id]),
  }
}
