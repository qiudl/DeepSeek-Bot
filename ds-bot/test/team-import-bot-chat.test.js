import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { inventorySourceBotChats } from '../src/host/team-import-bot-chat.js'
import { teamStateDigest } from '../src/host/team-import-plan.js'

const a = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const b = 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const c = 'session-cccccccc-cccc-cccc-cccc-cccccccccccc'
const d = 'session-dddddddd-dddd-dddd-dddd-dddddddddddd'
const source = { version: 1, revision: 4, mainBotIds: [a], rooms: {}, bots: {
  [a]: { id: a, sessionId: c, segments: [{ sessionId: a }, { sessionId: b }] },
} }
const plan = { sourceRevision: source.revision, sourceDigest: teamStateDigest(source),
  sessions: { [a]: d, [b]: d.replaceAll('d', 'e'), [c]: d.replaceAll('d', 'f') } }
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

test('REQ-20261023-0001 inventories every Bot chat part without returning raw events', async () => {
  const opened = []
  const events = id => [{ seq: 0, type: 'system/message', data: { cwd: '/private/source' } },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: `secret ${id}` }] } }]
  const ctx = { sessionPersistence: {
    stat: async id => ({ header: { id }, revision: 'r1', eventCount: 2, sizeBytes: 100 }),
    open: async (id, access) => { opened.push([id, access]); return { access, id, header: { id },
      read: async () => ({ events: events(id) }), close: async () => {} } },
  } }
  const result = await inventorySourceBotChats(ctx, source, plan)
  assert.deepEqual(result, { sourceDigest: plan.sourceDigest, bots: [{ logicalId: `bot:${a}`,
    parts: [a, b, c].map((id, index) => ({ index, sourceSessionId: id,
      eventCount: 2, digest: sha(events(id)) })) }] })
  assert.deepEqual(opened, [a, b, c].map(id => [id, 'read']))
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(JSON.stringify(result).includes('/private/source'), false)
})

test('REQ-20261023-0001 rejects incomplete or changed Bot chat inventories', async () => {
  const ctx = { sessionPersistence: { stat: async id => ({ header: { id }, revision: 'r1',
    eventCount: 1, sizeBytes: 100 }), open: async id => ({ access: 'read', id,
    header: { id }, read: async () => ({ events: [{ seq: 0 }] }), close: async () => {} }) } }
  await assert.rejects(inventorySourceBotChats(ctx, source, { ...plan, sessions: { [a]: d } }),
    /Incomplete Bot chat plan/u)
  await assert.rejects(inventorySourceBotChats(ctx, source, { ...plan, sourceDigest: '0'.repeat(64) }),
    /changed/u)
  await assert.rejects(inventorySourceBotChats(ctx, { ...source,
    bots: { [a]: { ...source.bots[a], segments: [{ sessionId: 'not-a-session' }] } } }, plan),
  /changed|Invalid/u)
  const missing = { sessionPersistence: { ...ctx.sessionPersistence,
    stat: async id => id === b ? null : ctx.sessionPersistence.stat(id) } }
  await assert.rejects(inventorySourceBotChats(missing, source, plan), /missing/u)

  const aliased = { ...source, rooms: { [b]: { id: b, sessions: {}, segments: {} } } }
  await assert.rejects(inventorySourceBotChats(ctx, aliased, { ...plan,
    sourceDigest: teamStateDigest(aliased) }), /Invalid Bot chat source/u)

  const changing = { ...ctx, sessionPersistence: { ...ctx.sessionPersistence,
    open: async id => ({ access: 'read', id, header: { id },
      read: async () => { source.revision++; return { events: [{ seq: 0 }] } },
      close: async () => {} }) } }
  await assert.rejects(inventorySourceBotChats(changing, source, plan), /changed/u)
  source.revision--
})
