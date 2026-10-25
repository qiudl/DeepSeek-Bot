import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/external-group.js'

test('REQ-20261023-0001 keeps the installed Slark group adapter behind its opt-in', async () => {
  let service
  let writer = true
  const rt = {
    config: { slarkExternalGroup: true },
    state: { externalGroup: { cycles: {}, deliveries: {}, results: [], nextResultSeq: 0 } },
    externalOwners: new Map(),
    refresh: async () => {},
    exclusiveWriter: () => writer,
    botOf: id => id === 'chief' ? { id, name: 'Chief' } : undefined,
    ctx: { tools: { guard() {} }, on() {}, provide(name, value) {
      assert.equal(name, 'dsBotSlarkExternalGroup')
      service = value
    } },
  }
  install(rt)
  assert.equal(typeof service?.deliver, 'function')
  assert.deepEqual(await service.resolveLocalBot('chief'), {
    botId: 'chief', actorRef: 'deepseek-bot:chief', displayName: 'Chief',
  })
  assert.equal(await service.resolveLocalBot('../other'), null)
  assert.deepEqual(await service.deliver({ schemaVersion: 1 }), { state: 'invalid' })
  writer = false
  assert.equal(await service.resolveLocalBot('chief'), null)

  service = undefined
  install({ ...rt, config: { slarkExternalGroup: false } })
  assert.equal(service, undefined)
})
