import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageImportedAgent } from '../src/host/team-import-agent.js'
import { createTeamImportJournal } from '../src/host/team-import-journal.js'

const sourceId = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const targetId = 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const plan = { sessions: { [sourceId]: targetId } }
const events = [{ seq: 0, type: 'system/message', time: 1, surfaceOp: 'append', data: { text: 'System' } }]
const historicalEvents = [{ seq: 0, type: 'session-log-deepseek/delivery-accepted', time: 1,
  data: { sessionId: sourceId } }]

function fixture({ failAt } = {}) {
  const calls = []
  const session = { id: targetId, snapshotEvents: () => [...events, { seq: 1, type: 'session/end-seed' }] }
  const workspace = { path: '/target/team', attachSession: async id => { calls.push(`attach:${id}`); if (failAt === 'attach') throw new Error('attach failed') } }
  const journal = {
    reserve: async record => { calls.push(`reserve:${record.targetId}`); if (failAt === 'reserve') throw new Error('pending import') },
    complete: async id => { calls.push(`complete:${id}`) },
    fail: async id => { calls.push(`fail:${id}`) },
  }
  const ctx = {
    agentPresets: { list: async () => [{ id: 'standard' }], mount: async (_scope, preset) => { calls.push(`preset:${preset}`) } },
    agents: { create: async input => { calls.push(`create:${input.sessionId}`); await input.setup({}); return { agent: { session } } } },
    sessionTitle: { rename: async (_session, title) => { calls.push(`title:${title}`) } },
    sessionController: { selectModel: async input => {
      calls.push(`model:${input.provider}/${input.model}`)
      if (failAt === 'model') throw new Error('model unavailable')
    } },
    sessions: { flush: async value => { assert.equal(value, session); calls.push('flush') } },
  }
  return { ctx, workspace, journal, calls }
}

test('REQ-20261023-0001 stages a seeded Agent only after durable reservation', async () => {
  const { ctx, workspace, journal, calls } = fixture()
  const result = await stageImportedAgent(ctx, { sourceId, plan, events, workspace, title: '灭霸Thanos',
    model: { provider: 'mock', model: 'mock' }, journal })
  assert.equal(result, targetId)
  assert.deepEqual(calls, [
    `reserve:${targetId}`, `create:${targetId}`, 'preset:standard', `attach:${targetId}`,
    'title:灭霸Thanos', 'model:mock/mock', 'flush', `complete:${targetId}`,
  ])
})

test('REQ-20261023-0001 stages a pre-surface historical Agent without model or Workspace exposure', async () => {
  const { ctx, workspace, journal, calls } = fixture()
  ctx.agents.create = async input => {
    calls.push(`create:${input.sessionId}`)
    await input.setup({})
    return { agent: { session: { id: targetId, snapshotEvents: () => [
      { ...historicalEvents[0], data: { sessionId: targetId } },
      { seq: 1, type: 'session/end-seed' },
    ] } } }
  }
  ctx.sessions.flush = async () => { calls.push('flush') }
  await stageImportedAgent(ctx, { sourceId, plan, events: historicalEvents, workspace,
    title: 'Historical', historyOnly: true, journal })
  assert.deepEqual(calls, [
    `reserve:${targetId}`, `create:${targetId}`, 'preset:standard', 'title:Historical', 'flush', `complete:${targetId}`,
  ])
})

test('REQ-20261023-0001 historical staging rejects an explicit model binding', async () => {
  const { ctx, workspace, journal, calls } = fixture()
  await assert.rejects(stageImportedAgent(ctx, { sourceId, plan, events: historicalEvents, workspace,
    title: 'Historical', historyOnly: true, model: { provider: 'mock', model: 'mock' }, journal }),
  /Incomplete target Agent settings/u)
  assert.deepEqual(calls, [])
})

test('REQ-20261023-0001 stops before creating a Session when reservation fails', async () => {
  const { ctx, workspace, journal, calls } = fixture({ failAt: 'reserve' })
  await assert.rejects(stageImportedAgent(ctx, { sourceId, plan, events, workspace, title: 'Bot',
    model: { provider: 'mock', model: 'mock' }, journal }), /pending import/u)
  assert.deepEqual(calls, [`reserve:${targetId}`])
})

test('REQ-20261023-0001 records a failed partial stage for explicit recovery', async () => {
  const { ctx, workspace, journal, calls } = fixture({ failAt: 'attach' })
  await assert.rejects(stageImportedAgent(ctx, { sourceId, plan, events, workspace, title: 'Bot',
    model: { provider: 'mock', model: 'mock' }, journal }), /attach failed/u)
  assert.deepEqual(calls.slice(-2), [`attach:${targetId}`, `fail:${targetId}`])
  assert.equal(calls.some(call => call.startsWith('complete:')), false)
})

test('REQ-20261023-0001 unavailable target model leaves an Agent stage for review', async () => {
  const { ctx, workspace, journal, calls } = fixture({ failAt: 'model' })
  await assert.rejects(stageImportedAgent(ctx, { sourceId, plan, events, workspace, title: 'Bot',
    model: { provider: 'mock', model: 'mock' }, journal }), /model unavailable/u)
  assert.deepEqual(calls.slice(-2), ['model:mock/mock', `fail:${targetId}`])
  assert.equal(calls.some(call => call.startsWith('complete:')), false)
})

test('REQ-20261023-0001 keeps a completed Agent stage idempotent across restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-agent-stage-'))
  try {
    const { ctx, workspace, calls } = fixture()
    const journal = createTeamImportJournal(root)
    const withDigests = { ...plan, sourceDigest: 'a'.repeat(64), targetDigest: 'b'.repeat(64) }
    const options = { sourceId, plan: withDigests, events, workspace, title: 'Bot',
      model: { provider: 'mock', model: 'mock' }, journal }
    await stageImportedAgent(ctx, options)
    const firstCalls = calls.length
    assert.equal((await journal.read(targetId)).status, 'staged')
    await assert.rejects(stageImportedAgent(ctx, { ...options, journal: createTeamImportJournal(root) }), /already reserved/u)
    assert.equal(calls.length, firstCalls)
  } finally { await rm(root, { recursive: true, force: true }) }
})
