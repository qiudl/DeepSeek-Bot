import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planTeamImport } from '../src/host/team-import-plan.js'

const id = hex => `session-${hex.repeat(8)}-${hex.repeat(4)}-${hex.repeat(4)}-${hex.repeat(4)}-${hex.repeat(12)}`
const chief = id('a'), helper = id('b'), thanos = id('c'), old = id('d'), current = id('e')
const room = id('f'), member = id('1'), previous = id('2')

const source = {
  version: 1, revision: 11, mainBotIds: [thanos],
  bots: { [thanos]: { id: thanos, sessionId: current, segments: [{ sessionId: old }, { sessionId: thanos }] } },
  rooms: { [room]: { id: room, members: [thanos], admin: thanos,
    sessions: { [thanos]: member }, segments: { [thanos]: [{ sessionId: previous }] } } },
}
const target = {
  version: 1, revision: 12, mainBotIds: [chief],
  bots: { [chief]: { id: chief }, [helper]: { id: helper } }, rooms: {},
}

test('REQ-20261023-0001 maps every Bot, room and historical Session without changing either team', () => {
  const originalSource = structuredClone(source), originalTarget = structuredClone(target)
  let next = 3
  const plan = planTeamImport(source, target, () => id(String(next++)))
  assert.equal(Object.keys(plan.sessions).length, 6)
  assert.deepEqual(plan.mainBotIds, [plan.sessions[thanos]])
  assert.deepEqual(plan.botIds, [plan.sessions[thanos]])
  assert.deepEqual(plan.roomIds, [plan.sessions[room]])
  for (const sourceId of [thanos, old, current, room, member, previous]) {
    assert.ok(plan.sessions[sourceId])
  }
  assert.deepEqual(source, originalSource)
  assert.deepEqual(target, originalTarget)
})

test('REQ-20261023-0001 rejects collisions and broken group references before writing', () => {
  assert.throws(() => planTeamImport(source, target, () => chief), /Duplicate target Session ID/u)
  assert.throws(() => planTeamImport(source, target, () => id('3'),
    { occupiedSessionIds: [id('3')] }), /Duplicate target Session ID/u)
  assert.throws(() => planTeamImport(source, target, () => id('3')), /Duplicate target Session ID/u)
  const broken = structuredClone(source)
  broken.rooms[room].members = [helper]
  assert.throws(() => planTeamImport(broken, target, () => id('3')), /Unknown group member/u)
})

test('REQ-20261023-0001 includes ordinary DSH Agent Sessions in the target occupancy check', () => {
  const withAgent = structuredClone(target)
  withAgent.agents = { agent: { id: 'agent', sessions: [id('3')] } }
  let next = 3
  assert.throws(() => planTeamImport(source, withAgent, () => id(String(next++))), /Duplicate target Session ID/u)
})

test('REQ-20261023-0001 does not plan an ordinary DSH Agent as a Bot team chat', () => {
  const withAgent = structuredClone(source)
  withAgent.agents = { agent: { id: 'agent', sessions: [id('9')] } }
  let next = 3
  const plan = planTeamImport(withAgent, target, () => id(String(next++)))
  assert.equal(plan.sessions[id('9')], undefined)
})

test('REQ-20261023-0001 rejects a source Session owned by two different chats', () => {
  const shared = structuredClone(source)
  shared.rooms[room].sessions[thanos] = current
  let next = 3
  assert.throws(() => planTeamImport(shared, target, () => id(String(next++))), /Session belongs to multiple chats/u)
})
