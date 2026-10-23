// Plan Session identity remapping before a selective import writes either team.
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function table(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('Invalid team Session reference')
  return value
}

function teamSessions(team) {
  if (!table(team) || team.version !== 1 || !table(team.bots) || !table(team.rooms) ||
      !Array.isArray(team.mainBotIds) || !Number.isSafeInteger(team.revision)) {
    throw new Error('Unknown team format')
  }
  const ids = new Set()
  const add = value => ids.add(sessionId(value))
  for (const [key, bot] of Object.entries(team.bots)) {
    if (!table(bot) || bot.id !== key || !Array.isArray(bot.segments ?? [])) throw new Error('Invalid Bot')
    add(bot.id)
    if (bot.sessionId !== undefined) add(bot.sessionId)
    for (const part of bot.segments ?? []) add(part?.sessionId)
  }
  for (const id of team.mainBotIds) {
    if (!Object.hasOwn(team.bots, id)) throw new Error('Unknown Main Bot')
  }
  for (const [key, room] of Object.entries(team.rooms)) {
    if (!table(room) || room.id !== key || !Array.isArray(room.members) ||
        !table(room.sessions ?? {}) || !table(room.segments ?? {})) throw new Error('Invalid group chat')
    add(room.id)
    for (const botId of room.members) {
      if (!Object.hasOwn(team.bots, botId)) throw new Error('Unknown group member')
    }
    if (room.admin !== undefined && room.admin !== null && !room.members.includes(room.admin)) {
      throw new Error('Unknown group admin')
    }
    for (const [botId, id] of Object.entries(room.sessions ?? {})) {
      if (!room.members.includes(botId)) throw new Error('Unknown group Session owner')
      add(id)
    }
    for (const [botId, parts] of Object.entries(room.segments ?? {})) {
      if (!room.members.includes(botId) || !Array.isArray(parts)) throw new Error('Invalid group segments')
      for (const part of parts) add(part?.sessionId)
    }
  }
  return [...ids].sort()
}

/** Only plans a mapping. The caller persists and verifies it before any Session is created. */
export function planTeamImport(source, target, allocate, { occupiedSessionIds = [] } = {}) {
  const sourceIds = teamSessions(source)
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
    sessions,
    mainBotIds: source.mainBotIds.map(id => sessions[id]),
    botIds: Object.keys(source.bots).map(id => sessions[id]),
    roomIds: Object.keys(source.rooms).map(id => sessions[id]),
  }
}
