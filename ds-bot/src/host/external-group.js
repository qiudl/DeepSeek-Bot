// Internal service for a Host adapter that has already authenticated the Slark
// Account and DSH Profile. Browser clients do not receive this service.
import { createHash } from 'node:crypto'
import { SOURCE_KIND, TEAM_TOOLS } from './constants.js'
import { textOf } from './text.js'
const BOT_ID = /^[A-Za-z0-9_-]{1,200}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const DIGEST = /^[0-9a-f]{64}$/u

export function install(rt) {
  if (rt.config.slarkExternalGroup !== true) return
  let pending = Promise.resolve()
  const serialize = action => {
    const next = pending.then(action)
    pending = next.catch(() => {})
    return next
  }
  const writer = async () => {
    await rt.refresh()
    return rt.hasExclusiveWriter()
  }
  const validBot = botId => {
    if (typeof botId !== 'string' || !BOT_ID.test(botId)) return null
    const bot = rt.botOf(botId)
    return bot?.id === botId && typeof bot.name === 'string' && bot.name.trim() !== '' ? bot : null
  }
  const cycleKey = input => `${input.groupId}:${input.botId}:${input.memberCycle}`
  const fingerprint = input => createHash('sha256').update(JSON.stringify([
    input.groupId, input.botId, input.memberCycle, input.messageSeq, input.text,
  ])).digest('hex')
  const receipt = record => record === undefined ? { state: 'missing' }
    : { state: record.state, deliveryId: record.deliveryId,
      groupId: record.groupId, botId: record.botId, memberCycle: record.memberCycle,
      payloadDigest: record.payloadDigest, sessionId: record.sessionId,
      ...(record.state === 'result_recorded' ? { resultId: `${record.deliveryId}:final` } : {}) }
  const live = new Map()
  const turnKey = (sessionId, turn) => `${sessionId}:${turn}`
  const recordResult = async (deliveryId, raw, status) => {
    const record = rt.own(rt.state.externalGroup.deliveries, deliveryId)
    if (record === undefined || record.acknowledged === true ||
      rt.state.externalGroup.results.some(result => result.deliveryId === deliveryId)) return
    const seq = ++rt.state.externalGroup.nextResultSeq
    rt.state.externalGroup.results.push({ id: `${deliveryId}:final`, deliveryId, groupId: record.groupId,
      botId: record.botId, memberCycle: record.memberCycle, seq, status, text: raw.slice(0, 100_000) })
    record.state = 'result_recorded'
    await rt.save()
  }
  rt.ctx.tools.guard(exec => rt.externalOwners.has(exec.agent?.id) && TEAM_TOOLS.includes(exec.name)
    ? 'DS Bot team tools are unavailable in a Slark group Session.' : undefined)
  const restrictTeamTools = async sessionId => {
    const agent = await rt.resolveAgent(sessionId)
    if (typeof agent.ctx?.tools?.restrict !== 'function' || typeof rt.ctx.tools?.schemas !== 'function') return
    const served = new Set(rt.ctx.tools.schemas(agent).map(schema => schema.name))
    const deny = TEAM_TOOLS.filter(name => served.has(name))
    if (deny.length > 0) agent.ctx.tools.restrict({ deny })
  }
  const recoverResult = async record => {
    if (record.acknowledged === true ||
      rt.state.externalGroup.results.some(result => result.deliveryId === record.deliveryId) ||
      typeof rt.eventsBackwards !== 'function') return
    const turns = new Map()
    try {
      for await (const event of rt.eventsBackwards(record.sessionId, AbortSignal.timeout(15_000), Infinity)) {
        const turn = event.data?.turn
        if (!Number.isSafeInteger(turn)) continue
        let entry = turns.get(turn)
        if (entry === undefined) turns.set(turn, entry = { texts: [] })
        if (event.type === 'turn/end') entry.reason = event.data?.reason?.kind
        if (event.type === 'assistant/message') {
          const text = textOf(event.data?.message?.content)
          if (text !== '') entry.texts.push(text)
        }
        if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND &&
          event.data.source.role === 'external_group' && event.data.source.exchangeId === record.deliveryId) {
          if (entry.reason !== undefined) await recordResult(record.deliveryId,
            entry.texts.reverse().join('\n\n'), entry.reason === 'completed' ? 'completed' : 'stopped')
          return
        }
      }
    } catch (error) {
      rt.warn('ds-bot: external group result history was not read: %s', error)
    }
  }
  rt.ctx.on?.('session/event', (session, event) => {
    const id = session?.id
    const turn = event.data?.turn
    if (typeof id !== 'string' || !Number.isSafeInteger(turn)) return
    const key = turnKey(id, turn)
    if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND &&
      event.data.source.role === 'external_group') {
      live.set(key, { deliveryId: event.data.source.exchangeId, texts: [] })
      return
    }
    const current = live.get(key)
    if (current === undefined) return
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') current.texts.push(text)
    }
    if (event.type === 'turn/end') {
      live.delete(key)
      const status = event.data?.reason?.kind === 'completed' ? 'completed' : 'stopped'
      void serialize(async () => {
        if (!await writer()) return
        await recordResult(current.deliveryId, current.texts.join('\n\n'), status)
      }).catch(error => rt.warn('ds-bot: external group result was not saved: %s', error))
    }
  })

  rt.ctx.provide('dsBotSlarkExternalGroup', {
    async listLocalBots({ afterBotId = '', limit = 50 } = {}) {
      if (afterBotId !== '' && (typeof afterBotId !== 'string' || !BOT_ID.test(afterBotId)))
        throw Error('invalid_bot_roster_page')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw Error('invalid_bot_roster_page')
      if (!await writer()) return null
      const ids = Object.keys(rt.state.bots ?? {}).sort()
      const candidates = ids.filter(id => id > afterBotId).map(id => validBot(id))
        .filter(bot => bot !== null && Buffer.byteLength(bot.name, 'utf8') <= 512)
      const page = candidates.slice(0, limit)
      return { bots: page.map(bot => ({ botId: bot.id,
        actorRef: `deepseek-bot:${bot.id}`, displayName: bot.name })),
      nextCursor: candidates.length > limit ? page.at(-1).id : null }
    },
    async resolveLocalBot(botId) {
      if (!await writer()) return null
      const bot = validBot(botId)
      if (bot === null) return null
      return { botId, actorRef: `deepseek-bot:${botId}`, displayName: bot.name }
    },
    async deliver(input) {
      return serialize(async () => {
        if (input?.schemaVersion !== 1 || !UUID.test(input.deliveryId ?? '') ||
          !UUID.test(input.groupId ?? '') || !BOT_ID.test(input.botId ?? '') ||
          !Number.isSafeInteger(input.memberCycle) || input.memberCycle < 1 ||
          !Number.isSafeInteger(input.messageSeq) || input.messageSeq < 1 ||
          !DIGEST.test(input.payloadDigest ?? '') || typeof input.text !== 'string' ||
          input.text.length === 0 || input.text.length > 100_000) return { state: 'invalid' }
        if (!await writer()) return { state: 'unavailable' }
        const contentDigest = fingerprint(input)
        const existing = rt.own(rt.state.externalGroup.deliveries, input.deliveryId)
        if (existing !== undefined) {
          return existing.payloadDigest === input.payloadDigest && existing.groupId === input.groupId &&
            existing.botId === input.botId && existing.memberCycle === input.memberCycle &&
            existing.messageSeq === input.messageSeq && existing.contentDigest === contentDigest
            ? receipt(existing) : { state: 'conflict' }
        }
        const bot = validBot(input.botId)
        if (bot === null) return { state: 'bot_missing' }
        const key = cycleKey(input)
        let cycle = rt.own(rt.state.externalGroup.cycles, key)
        if (cycle?.revoked) return { state: 'revoked' }
        for (const prior of Object.values(rt.state.externalGroup.deliveries)) {
          if (prior.groupId !== input.groupId || prior.botId !== input.botId ||
            prior.memberCycle !== input.memberCycle || prior.state === 'result_recorded') continue
          await recoverResult(prior)
          if (prior.state !== 'result_recorded') return { state: 'busy' }
        }
        if (cycle === undefined) {
          const sessionId = await rt.createSession(`${bot.name} · Slark group`)
          cycle = { groupId: input.groupId, botId: input.botId, memberCycle: input.memberCycle, sessionId, revoked: false }
          rt.state.externalGroup.cycles[key] = cycle
          try { await rt.save() } catch (error) { delete rt.state.externalGroup.cycles[key]; throw error }
        }
        await restrictTeamTools(cycle.sessionId)
        const record = { deliveryId: input.deliveryId, groupId: input.groupId, botId: input.botId,
          memberCycle: input.memberCycle, messageSeq: input.messageSeq, payloadDigest: input.payloadDigest,
          contentDigest, sessionId: cycle.sessionId, state: 'indeterminate' }
        rt.state.externalGroup.deliveries[input.deliveryId] = record
        try { await rt.save() } catch (error) { delete rt.state.externalGroup.deliveries[input.deliveryId]; throw error }
        try {
          await rt.deliver({ toId: input.botId, sessionId: cycle.sessionId, role: 'external_group',
            exchangeId: input.deliveryId, text: input.text })
          record.state = 'accepted'
          await rt.save()
        } catch {
          // A failed or interrupted flush may already be in the DSH Session. Keep its
          // stable key for reconciliation; replaying here could run the task twice.
          record.state = 'indeterminate'
          await rt.save().catch(() => {})
        }
        return receipt(record)
      })
    },
    async receipt({ deliveryId, groupId, botId, memberCycle } = {}) {
      return serialize(async () => {
        if (!UUID.test(deliveryId ?? '') || !UUID.test(groupId ?? '') ||
          !BOT_ID.test(botId ?? '') || !Number.isSafeInteger(memberCycle) ||
          memberCycle < 1) return { state: 'invalid' }
        if (!await writer()) return { state: 'unavailable' }
        const record = rt.own(rt.state.externalGroup.deliveries, deliveryId)
        if (record !== undefined && (record.groupId !== groupId || record.botId !== botId ||
          record.memberCycle !== memberCycle)) return { state: 'missing' }
        if (record !== undefined) await recoverResult(record)
        return receipt(record)
      })
    },
    // Host-only, bounded inventory for an owner's per-delivery leave decision.
    // An unobserved completion remains pending until receipt/result recovery proves it terminal.
    async inFlightPage({ groupId, botId, memberCycle, afterDeliveryId = '', limit = 50 } = {}) {
      return serialize(async () => {
        if (!UUID.test(groupId ?? '') || !BOT_ID.test(botId ?? '') ||
          !Number.isSafeInteger(memberCycle) || memberCycle < 1 ||
          (afterDeliveryId !== '' && !UUID.test(afterDeliveryId)) ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return { state: 'invalid' }
        if (!await writer()) return { state: 'unavailable' }
        const rows = Object.values(rt.state.externalGroup.deliveries)
          .filter(record => record.groupId === groupId && record.botId === botId &&
            record.memberCycle === memberCycle && record.deliveryId > afterDeliveryId &&
            record.state !== 'result_recorded')
          .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId))
        const page = rows.slice(0, limit)
        return { state: 'ok', deliveries: page.map(record => ({
          deliveryId: record.deliveryId, messageSeq: record.messageSeq,
          state: record.state, payloadDigest: record.payloadDigest,
        })), nextCursor: rows.length > limit ? page.at(-1).deliveryId : null }
      })
    },
    async resultPage({ groupId, botId, memberCycle, after = 0, limit = 50 }) {
      return serialize(async () => {
        if (!UUID.test(groupId ?? '') || !BOT_ID.test(botId ?? '') ||
          !Number.isSafeInteger(memberCycle) || memberCycle < 1 ||
          !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return { state: 'invalid' }
        if (!await writer()) return { state: 'unavailable' }
        for (const record of Object.values(rt.state.externalGroup.deliveries)) {
          if (record.groupId === groupId && record.botId === botId && record.memberCycle === memberCycle &&
            record.state !== 'result_recorded') await recoverResult(record)
        }
        const rows = rt.state.externalGroup.results.filter(result => result.groupId === groupId &&
          result.botId === botId && result.memberCycle === memberCycle && result.seq > after).slice(0, limit)
        return { state: 'ok', results: rows, next: rows.at(-1)?.seq ?? after }
      })
    },
    async acknowledgeResult({ groupId, botId, memberCycle, deliveryId, resultId }) {
      return serialize(async () => {
        if (!UUID.test(groupId ?? '') || !BOT_ID.test(botId ?? '') ||
          !Number.isSafeInteger(memberCycle) || memberCycle < 1 ||
          !UUID.test(deliveryId ?? '') || resultId !== `${deliveryId}:final`) return { state: 'invalid' }
        if (!await writer()) return { state: 'unavailable' }
        const record = rt.own(rt.state.externalGroup.deliveries, deliveryId)
        if (record === undefined || record.groupId !== groupId || record.botId !== botId ||
          record.memberCycle !== memberCycle || record.state !== 'result_recorded') return { state: 'missing' }
        if (record.acknowledged === true) return { state: 'acknowledged' }
        record.acknowledged = true
        rt.state.externalGroup.results = rt.state.externalGroup.results.filter(result => result.id !== resultId)
        await rt.save()
        return { state: 'acknowledged' }
      })
    },
    async revokeCycle({ groupId, botId, memberCycle, version, stopInFlight = false }) {
      return serialize(async () => {
        if (!UUID.test(groupId ?? '') || !BOT_ID.test(botId ?? '') ||
          !Number.isSafeInteger(memberCycle) || memberCycle < 1 ||
          !Number.isSafeInteger(version) || version < 1 || typeof stopInFlight !== 'boolean') return { state: 'invalid' }
        if (!await writer()) return { state: 'unavailable' }
        const cycle = rt.own(rt.state.externalGroup.cycles, cycleKey({ groupId, botId, memberCycle }))
        if (cycle === undefined) return { state: 'missing' }
        if (cycle.revoked && cycle.revocationVersion > version) return { state: 'revoked' }
        if (cycle.revoked && cycle.revocationVersion === version &&
          Boolean(cycle.stopInFlight) !== stopInFlight) return { state: 'conflict' }
        if (!cycle.revoked || cycle.revocationVersion < version) {
          cycle.revoked = true
          cycle.revocationVersion = version
          cycle.stopInFlight = stopInFlight || cycle.stopInFlight === true
          await rt.save()
        }
        if (cycle.stopInFlight === true && cycle.stopCompleted !== true) {
          await rt.ctx.workspaceRegistry.archiveSession(cycle.sessionId, { stopActivity: true })
          cycle.stopCompleted = true
          await rt.save()
        }
        return { state: 'revoked' }
      })
    },
  })
}
