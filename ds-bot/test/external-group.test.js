import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/external-group.js'

function fixture(enabled = true) {
  let service
  let exclusiveWriter = true
  const bots = { bot_1: { id: 'bot_1', name: 'Owner Bot', memory: 'private' } }
  const rt = {
    config: { slarkExternalGroup: enabled },
    ctx: { provide(name, value) { assert.equal(name, 'dsBotSlarkExternalGroup'); service = value } },
    refresh: async () => {},
    hasExclusiveWriter: () => exclusiveWriter,
    botOf: id => Object.hasOwn(bots, id) ? bots[id] : undefined,
  }
  install(rt)
  return { get service() { return service }, bots, setExclusiveWriter(value) { exclusiveWriter = value } }
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
