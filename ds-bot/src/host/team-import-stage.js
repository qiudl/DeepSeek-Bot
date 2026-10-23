// Build an inert team-state candidate after Session IDs have been planned.
import { planTeamImport, teamStateDigest } from './team-import-plan.js'
import { normalize } from './text.js'

const BOT_FIELDS = ['name', 'role', 'instructions', 'color', 'avatar', 'createdAt', 'pinned', 'hidden']
const ROOM_FIELDS = ['name', 'named', 'mode', 'notice', 'createdAt', 'relayLimit', 'seq']
const SEGMENT_FIELDS = ['number', 'endedAt', 'tokens', 'fallback', 'note', 'noteFrom']

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function copyFields(value, fields) {
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])]))
}

/** Return only Bot and group metadata; the caller must verify Sessions and memory before activation. */
export function stageTeamImport(source, target, plan, { models = {} } = {}) {
  if (!object(plan) || !object(plan.sessions) || !object(models)) throw new Error('Invalid import plan')
  if (source.revision !== plan.sourceRevision || teamStateDigest(source) !== plan.sourceDigest) throw new Error('Source team changed')
  if (target.revision !== plan.targetRevision || teamStateDigest(target) !== plan.targetDigest) throw new Error('Target team changed')
  const checked = planTeamImport(source, target, from => plan.sessions[from])
  if (Object.keys(checked.sessions).length !== Object.keys(plan.sessions).length) throw new Error('Import plan changed')
  const session = id => {
    const mapped = plan.sessions[id]
    if (typeof mapped !== 'string') throw new Error('Missing mapped Session')
    return mapped
  }
  const botId = id => {
    if (id === undefined || id === null) return id
    if (!Object.hasOwn(source.bots, id)) throw new Error('Unknown Bot reference')
    return session(id)
  }
  const segment = part => ({ ...copyFields(part, SEGMENT_FIELDS), sessionId: session(part.sessionId) })
  const names = new Set(Object.values(target.bots).map(bot => normalize(bot.name)))
  const rooms = new Set(Object.values(target.rooms).map(room => normalize(room.name)))
  const bots = structuredClone(target.bots)
  const groups = structuredClone(target.rooms)
  for (const [id, bot] of Object.entries(source.bots)) {
    const name = normalize(bot.name)
    if (name === '' || names.has(name)) throw new Error('Bot name already exists')
    names.add(name)
    const model = models[id]
    if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) throw new Error('Invalid target model')
    bots[session(id)] = {
      ...copyFields(bot, BOT_FIELDS), id: session(id),
      ...(bot.sessionId === undefined ? {} : { sessionId: session(bot.sessionId) }),
      ...(bot.segments === undefined ? {} : { segments: bot.segments.map(segment) }),
      ...(bot.createdBy === undefined ? {} : { createdBy: botId(bot.createdBy) }),
      ...(model === undefined ? {} : { model }),
    }
  }
  for (const [id, room] of Object.entries(source.rooms)) {
    const name = normalize(room.name)
    if (name === '' || rooms.has(name)) throw new Error('Group name already exists')
    rooms.add(name)
    const sessions = Object.fromEntries(Object.entries(room.sessions ?? {}).map(([owner, value]) => [botId(owner), session(value)]))
    const segments = Object.fromEntries(Object.entries(room.segments ?? {}).map(([owner, parts]) => [botId(owner), parts.map(segment)]))
    if (!Array.isArray(room.log ?? [])) throw new Error('Invalid group log')
    const log = (room.log ?? []).map(line => {
      if (!object(line)) throw new Error('Invalid group log')
      if (line.botId !== undefined && !Object.hasOwn(source.bots, line.botId)) throw new Error('Unknown group log actor')
      return { ...structuredClone(line), ...(line.botId === undefined ? {} : { botId: botId(line.botId) }) }
    })
    groups[session(id)] = {
      ...copyFields(room, ROOM_FIELDS), id: session(id),
      members: room.members.map(botId), admin: botId(room.admin),
      log, seen: {},
      ...(room.createdBy === undefined ? {} : { createdBy: botId(room.createdBy) }),
      ...(room.sessions === undefined ? {} : { sessions }),
      ...(room.segments === undefined ? {} : { segments }),
    }
  }
  if (source.mainBotIds.length === 0) throw new Error('No source Main Bot')
  return { bots, rooms: groups, mainBotIds: source.mainBotIds.map(botId) }
}
