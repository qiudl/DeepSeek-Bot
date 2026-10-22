import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/external-group.js'

function fixture(enabled = true, saved) {
  let service
  let exclusiveWriter = true
  let flushFails = false
  let sessionCount = 0
  let eventHandler
  let toolGuard
  let history = []
  const sent = []
  const externalOwners = new Map()
  const state = saved ? structuredClone(saved) : { externalGroup: { cycles: {}, deliveries: {}, results: [], nextResultSeq: 0 } }
  const bots = { bot_1: { id: 'bot_1', name: 'Owner Bot', memory: 'private' } }
  const rt = {
    config: { slarkExternalGroup: enabled },
    ctx: { provide(name, value) { assert.equal(name, 'dsBotSlarkExternalGroup'); service = value },
      on(name, handler) { assert.equal(name, 'session/event'); eventHandler = handler },
      tools: { guard(handler) { toolGuard = handler }, schemas: () => [{ name: 'create_bot' }] },
      workspaceRegistry: { archiveSession: async () => {} } },
    state,
    externalOwners,
    own: (table, key) => Object.hasOwn(table, key) ? table[key] : undefined,
    refresh: async () => {},
    hasExclusiveWriter: () => exclusiveWriter,
    botOf: id => Object.hasOwn(bots, id) ? bots[id] : undefined,
    createSession: async () => `session-${++sessionCount}`,
    save: async () => {
      externalOwners.clear()
      for (const cycle of Object.values(state.externalGroup.cycles)) externalOwners.set(cycle.sessionId, cycle.botId)
      saved = structuredClone(state)
    },
    deliver: async input => { sent.push(input); if (flushFails) throw Error('flush disconnected') },
    resolveAgent: async sessionId => ({ id: sessionId, ctx: { tools: { restrict: () => {} } } }),
    async *eventsBackwards() { for (const event of history) yield event },
    warn: () => {},
  }
  install(rt)
  return { get service() { return service }, get saved() { return saved }, sent, bots,
    guardedTool(name, sessionId) { return toolGuard({ name, agent: { id: sessionId } }) },
    emit(sessionId, event) { eventHandler({ id: sessionId }, event) },
    setHistory(events) { history = events },
    setExclusiveWriter(value) { exclusiveWriter = value }, setFlushFails(value) { flushFails = value } }
}

test('external group service is absent unless enabled', () => {
  assert.equal(fixture(false).service, undefined)
})

test('internal resolver returns only a current local Bot identity', async () => {
  const f = fixture()
  assert.deepEqual(await f.service.resolveLocalBot('bot_1'), {
    botId: 'bot_1', actorRef: 'deepseek-bot:bot_1', displayName: 'Owner Bot',
  })
  assert.equal(await f.service.resolveLocalBot('__proto__'), null)
  assert.equal(await f.service.resolveLocalBot('missing'), null)
  f.bots.bot_1.name = null
  assert.equal(await f.service.resolveLocalBot('bot_1'), null)
  f.bots.bot_1.name = 'Owner Bot'
  f.setExclusiveWriter(false)
  assert.equal(await f.service.resolveLocalBot('bot_1'), null)
})

const input = { schemaVersion: 1, deliveryId: '11111111-1111-4111-8111-111111111111',
  groupId: '22222222-2222-4222-8222-222222222222', botId: 'bot_1', memberCycle: 1,
  messageSeq: 7, payloadDigest: 'a'.repeat(64), text: 'Please check the plan.' }

test('external group delivery is durable before flush and replays only its receipt after restart', async () => {
  const first = fixture()
  const accepted = await first.service.deliver(input)
  assert.deepEqual(accepted, { state: 'accepted', deliveryId: input.deliveryId,
    payloadDigest: input.payloadDigest, sessionId: 'session-1' })
  assert.equal(first.sent.length, 1)
  assert.match(first.guardedTool('create_bot', accepted.sessionId), /unavailable/u)
  assert.equal(first.guardedTool('create_bot', 'private-chat'), undefined)
  assert.deepEqual(await first.service.deliver({ ...input,
    deliveryId: '33333333-3333-4333-8333-333333333333', messageSeq: 8 }), { state: 'busy' })
  const afterRestart = fixture(true, first.saved)
  assert.deepEqual(await afterRestart.service.receipt(input.deliveryId), accepted)
  assert.deepEqual(await afterRestart.service.deliver(input), accepted)
  assert.equal(afterRestart.sent.length, 0)
  assert.deepEqual(await afterRestart.service.deliver({ ...input, text: 'Run a different task.' }), { state: 'conflict' })
  assert.equal(afterRestart.sent.length, 0)
})

test('uncertain flush retains the key and never silently executes it twice', async () => {
  const first = fixture()
  first.setFlushFails(true)
  const result = await first.service.deliver(input)
  assert.equal(result.state, 'indeterminate')
  const afterRestart = fixture(true, first.saved)
  assert.deepEqual(await afterRestart.service.deliver(input), result)
  assert.equal(afterRestart.sent.length, 0)
})

test('writer loss and malformed scope cannot create external group sessions', async () => {
  const f = fixture()
  f.setExclusiveWriter(false)
  assert.deepEqual(await f.service.deliver(input), { state: 'unavailable' })
  f.setExclusiveWriter(true)
  assert.deepEqual(await f.service.deliver({ ...input, memberCycle: 0 }), { state: 'invalid' })
  assert.deepEqual(await f.service.deliver({ ...input, botId: '__proto__' }), { state: 'bot_missing' })
  assert.equal(f.sent.length, 0)
})

test('finished Bot turn enters a stable result page and revoked cycle rejects new work', async () => {
  const f = fixture()
  const accepted = await f.service.deliver(input)
  f.emit(accepted.sessionId, { type: 'user/message', data: { turn: 1,
    source: { kind: 'bot', role: 'external_group', exchangeId: input.deliveryId } } })
  f.emit(accepted.sessionId, { type: 'assistant/message', data: { turn: 1,
    message: { content: [{ type: 'text', text: 'Plan checked.' }] } } })
  f.emit(accepted.sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const page = await f.service.resultPage(input)
  assert.deepEqual(page, { state: 'ok', results: [{ id: `${input.deliveryId}:final`, deliveryId: input.deliveryId,
    groupId: input.groupId, botId: input.botId, memberCycle: input.memberCycle,
    seq: 1, status: 'completed', text: 'Plan checked.' }], next: 1 })
  assert.deepEqual(await f.service.receipt(input.deliveryId), {
    state: 'result_recorded', deliveryId: input.deliveryId,
    payloadDigest: input.payloadDigest, sessionId: accepted.sessionId,
    resultId: `${input.deliveryId}:final`,
  })
  const afterRestart = fixture(true, f.saved)
  assert.deepEqual(await afterRestart.service.resultPage(input), page)
  assert.deepEqual(await afterRestart.service.acknowledgeResult({ ...input,
    resultId: `${input.deliveryId}:final` }), { state: 'acknowledged' })
  assert.deepEqual(await afterRestart.service.resultPage(input), { state: 'ok', results: [], next: 0 })
  assert.deepEqual(await afterRestart.service.revokeCycle({ ...input, version: 1 }), { state: 'revoked' })
  assert.deepEqual(await afterRestart.service.deliver({ ...input, deliveryId: '33333333-3333-4333-8333-333333333333' }), { state: 'revoked' })
  assert.equal(afterRestart.sent.length, 0)
})

test('result page recovers a completed turn from DSH Session history after Host restart', async () => {
  const first = fixture()
  await first.service.deliver(input)
  const restarted = fixture(true, first.saved)
  restarted.setHistory([
    { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } },
    { type: 'assistant/message', data: { turn: 9, message: { content: [{ type: 'text', text: 'Recovered result.' }] } } },
    { type: 'user/message', data: { turn: 9, source: { kind: 'bot', role: 'external_group', exchangeId: input.deliveryId } } },
  ])
  const page = await restarted.service.resultPage(input)
  assert.equal(page.results[0].text, 'Recovered result.')
  assert.equal((await restarted.service.receipt(input.deliveryId)).state, 'result_recorded')
  assert.equal(restarted.sent.length, 0)
})
