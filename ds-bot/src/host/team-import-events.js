// Rewrite only structural Session references in a decoded DSH event seed.
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const REFERENCE_KEY = /(?:session|room|bot)id$/iu
const TEXT_KEY = new Set(['text', 'content', 'arguments', 'title', 'name', 'note'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function checkReferences(value, targetIds, sourceIds) {
  if (Array.isArray(value)) {
    for (const item of value) checkReferences(item, targetIds, sourceIds)
    return
  }
  if (!object(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && (
      (REFERENCE_KEY.test(key) || key === 'parentSession') && SESSION_ID.test(item) && !targetIds.has(item)
      || sourceIds.has(item) && !TEXT_KEY.has(key)
    )) throw new Error('Unmapped Session reference')
    checkReferences(item, targetIds, sourceIds)
  }
}

/** Does not copy a Session header or change chat text; callers supply target cwd/preset separately. */
export function remapSessionEvents(events, sourceId, plan, { active = false } = {}) {
  if (!Array.isArray(events) || events.length > 1_000_000 || !object(plan?.sessions) ||
      !SESSION_ID.test(sourceId) || !SESSION_ID.test(plan.sessions[sourceId] ?? '')) {
    throw new Error('Invalid Session seed')
  }
  const targetIds = new Set(Object.values(plan.sessions))
  const sourceIds = new Set(Object.keys(plan.sessions))
  const mapped = structuredClone(events)
  const session = id => {
    const target = plan.sessions[id]
    if (typeof target !== 'string' || !SESSION_ID.test(target)) throw new Error('Unmapped Session reference')
    return target
  }
  const source = value => {
    if (value === undefined) return
    if (!object(value)) throw new Error('Invalid message source')
    for (const key of ['senderSessionId', 'roomId']) {
      if (value[key] !== undefined) value[key] = session(value[key])
    }
  }
  let firstAppend
  mapped.forEach((event, index) => {
    if (!object(event) || !Number.isSafeInteger(event.seq) || event.seq !== index ||
        typeof event.type !== 'string' || !Number.isFinite(event.time)) throw new Error('Invalid Session event sequence')
    if (firstAppend === undefined && event.surfaceOp === 'append') firstAppend = event.type
    if (event.type === 'session-log-deepseek/delivery-accepted') {
      if (event.data?.sessionId !== sourceId) throw new Error('Wrong delivery Session')
      event.data.sessionId = session(sourceId)
    } else if (event.type === 'user/message') {
      source(event.data?.source)
    } else if (event.type === 'agent/inbox/spliced') {
      if (!Array.isArray(event.data?.inserted)) throw new Error('Invalid inbox event')
      for (const inserted of event.data.inserted) source(inserted?.source)
    }
    checkReferences(event, targetIds, sourceIds)
  })
  if (active && firstAppend !== 'system/message') throw new Error('Active history needs a protected system message')
  return mapped
}
