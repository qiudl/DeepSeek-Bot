import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planTeamImport } from '../src/host/team-import-plan.js'
import { stageTeamImport } from '../src/host/team-import-stage.js'

const id = hex => `session-${hex.repeat(8)}-${hex.repeat(4)}-${hex.repeat(4)}-${hex.repeat(4)}-${hex.repeat(12)}`
const chief = id('a'), helper = id('b'), thanos = id('c'), old = id('d'), current = id('e')
const room = id('f'), member = id('1'), previous = id('2')

function fixture() {
  const source = {
    version: 1, revision: 8, mainBotIds: [thanos],
    bots: { [thanos]: { id: thanos, name: '灭霸Thanos', role: 'Main', instructions: 'Remember the team.',
      sessionId: current, segments: [{ sessionId: old, number: 1 }, { sessionId: thanos, number: 0 }],
      model: 'source/model', appliedModel: 'source/model', workDir: '/source/private', capabilities: ['source-secret'],
      permission: 'full', createdBy: null, createdAt: 10 } },
    rooms: { [room]: { id: room, name: 'Project', members: [thanos], admin: thanos,
      sessions: { [thanos]: member }, segments: { [thanos]: [{ sessionId: previous, number: 1 }] },
      log: [{ seq: 1, who: '灭霸Thanos', botId: thanos, text: 'Old group chat' }], seq: 1,
      createdBy: thanos, createdAt: 11, mode: 'admin', notice: 'Old notice', relays: 9 } },
  }
  const target = {
    version: 1, revision: 14, mainBotIds: [chief],
    bots: { [chief]: { id: chief, name: 'Chief' }, [helper]: { id: helper, name: '生活助理' } },
    rooms: {}, agents: {}, exchanges: [{ id: 'keep' }], prefs: { theme: 'plain' },
  }
  let next = 3
  return { source, target, plan: planTeamImport(source, target, () => id(String(next++))) }
}

test('REQ-20261023-0001 stages source Bot and group history while retaining the target team', () => {
  const { source, target, plan } = fixture()
  const originalSource = structuredClone(source), originalTarget = structuredClone(target)
  const staged = stageTeamImport(source, target, plan, { models: { [thanos]: 'target/model' } })
  const imported = staged.bots[plan.sessions[thanos]]
  assert.equal(imported.name, '灭霸Thanos')
  assert.equal(imported.sessionId, plan.sessions[current])
  assert.deepEqual(imported.segments.map(part => part.sessionId), [plan.sessions[old], plan.sessions[thanos]])
  assert.equal(imported.model, 'target/model')
  for (const key of ['workDir', 'appliedModel', 'capabilities', 'permission']) assert.equal(imported[key], undefined)
  assert.deepEqual(staged.mainBotIds, [plan.sessions[thanos]])
  assert.deepEqual(staged.bots[chief], target.bots[chief])
  assert.deepEqual(staged.bots[helper], target.bots[helper])
  const group = staged.rooms[plan.sessions[room]]
  assert.deepEqual(group.members, [plan.sessions[thanos]])
  assert.equal(group.admin, plan.sessions[thanos])
  assert.equal(group.sessions[plan.sessions[thanos]], plan.sessions[member])
  assert.equal(group.segments[plan.sessions[thanos]][0].sessionId, plan.sessions[previous])
  assert.equal(group.log[0].botId, plan.sessions[thanos])
  assert.equal(group.log[0].text, 'Old group chat')
  assert.deepEqual(group.seen, {})
  assert.equal(group.relays, undefined)
  assert.deepEqual(source, originalSource)
  assert.deepEqual(target, originalTarget)
})

test('REQ-20261023-0001 rejects stale plans, duplicate names and broken group actors', () => {
  const { source, target, plan } = fixture()
  assert.throws(() => stageTeamImport(source, { ...target, revision: 15 }, plan), /Target team changed/u)
  const edited = structuredClone(source)
  edited.bots[thanos].instructions = 'Changed without revision'
  assert.throws(() => stageTeamImport(edited, target, plan), /Source team changed/u)
  const duplicate = structuredClone(target)
  duplicate.bots[helper].name = '灭霸thanos'
  assert.throws(() => stageTeamImport(source, duplicate, plan), /Target team changed/u)
  let next = 3
  const duplicatePlan = planTeamImport(source, duplicate, () => id(String(next++)))
  assert.throws(() => stageTeamImport(source, duplicate, duplicatePlan), /Bot name already exists/u)
  const broken = structuredClone(source)
  broken.rooms[room].log[0].botId = chief
  next = 3
  const brokenPlan = planTeamImport(broken, target, () => id(String(next++)))
  assert.throws(() => stageTeamImport(broken, target, brokenPlan), /Unknown group log actor/u)
})
