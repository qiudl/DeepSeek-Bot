import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTeamImportJournal } from '../src/host/team-import-journal.js'
import { inventoryTeamMemory } from '../src/host/team-import-memory.js'
import { stageTeamMemory } from '../src/host/team-import-memory-stage.js'
import { planTeamImport } from '../src/host/team-import-plan.js'
import { assertCompleteSourceGroupLogs, verifyTeamImportStage } from '../src/host/team-import-preflight.js'
import { stageTeamImport } from '../src/host/team-import-stage.js'

const id = hex => `session-${hex.repeat(8)}-${hex.repeat(4)}-${hex.repeat(4)}-${hex.repeat(4)}-${hex.repeat(12)}`
const bot = id('a'), old = id('b'), current = id('c'), chief = id('d')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-preflight-'))
  const sourceMemoryRoot = join(root, 'source')
  const targetMemoryRoot = join(root, 'target')
  const memoryStageRoot = join(root, 'private', 'memory')
  await mkdir(join(sourceMemoryRoot, 'bots', bot), { recursive: true })
  await mkdir(targetMemoryRoot)
  await mkdir(join(root, 'private'))
  await writeFile(join(sourceMemoryRoot, 'bots', bot, 'MEMORY.md'), '# Fact\n')
  const source = { version: 1, revision: 4, mainBotIds: [bot],
    bots: { [bot]: { id: bot, name: '灭霸Thanos', sessionId: current,
      segments: [{ sessionId: bot }, { sessionId: old }] } }, rooms: {} }
  const target = { version: 1, revision: 5, mainBotIds: [chief],
    bots: { [chief]: { id: chief, name: 'Chief' } }, rooms: {} }
  let next = 1
  const plan = planTeamImport(source, target, () => id(String(next++)))
  const candidate = stageTeamImport(source, target, plan)
  const journal = createTeamImportJournal(join(root, 'journal'))
  for (const [sourceId, targetId] of Object.entries(plan.sessions)) {
    await journal.reserve({ sourceId, targetId, mode: sourceId === current ? 'active' : 'history',
      eventDigest: 'e'.repeat(64), sourceDigest: plan.sourceDigest, targetDigest: plan.targetDigest,
      ...(sourceId === current ? { systemMessageId: '11111111-1111-4111-8111-111111111111' } : {}) })
    await journal.complete(targetId)
  }
  const manifest = await inventoryTeamMemory(sourceMemoryRoot, source, plan)
  await stageTeamMemory({ sourceRoot: sourceMemoryRoot, targetRoot: targetMemoryRoot,
    stageRoot: memoryStageRoot, source, plan, manifest })
  return { root, source, target, plan, candidate, journal, sourceMemoryRoot, memoryStageRoot,
    verifySession: async () => true }
}

test('REQ-20261023-0001 checks every planned Session and staged memory before activation', async () => {
  const data = await fixture()
  try {
    const observed = []
    const result = await verifyTeamImportStage({ ...data, verifySession: async item => {
      observed.push(item)
      return true
    } })
    assert.deepEqual(result, { sessions: 3, memoryFiles: 1 })
    assert.deepEqual(observed.filter(item => item.mode === 'active').map(item => item.sourceId), [current])
    assert.equal(observed.find(item => item.mode === 'active').systemMessageId,
      '11111111-1111-4111-8111-111111111111')
    assert.equal(observed.filter(item => item.mode === 'history').length, 2)
  } finally { await rm(data.root, { recursive: true, force: true }) }
})

test('REQ-20261023-0001 refuses stale state, incomplete Sessions and changed staged bytes', async () => {
  const data = await fixture()
  try {
    await assert.rejects(verifyTeamImportStage({ ...data, target: { ...data.target, revision: 6 } }), /Target team changed/u)
    await assert.rejects(verifyTeamImportStage({ ...data, candidate: { ...data.candidate, mainBotIds: [chief] } }), /Team candidate changed/u)
    await assert.rejects(verifyTeamImportStage({ ...data, verifySession: async () => false }), /Session verification failed/u)
    await assert.rejects(verifyTeamImportStage({ ...data, journal: { read: async id => {
      const record = await data.journal.read(id)
      if (record.mode === 'active') delete record.systemMessageId
      return record
    } } }), /Session stage incomplete/u)
    const targetId = data.plan.sessions[old]
    await assert.rejects(verifyTeamImportStage({ ...data, journal: { read: async id => ({
      ...await data.journal.read(id), ...(id === targetId ? { status: 'needs-review' } : {}),
    }) } }), /Session stage incomplete/u)
    const marker = join(data.memoryStageRoot, 'manifest.json')
    const original = await readFile(marker)
    await writeFile(marker, JSON.stringify({ ...JSON.parse(original), status: 'pending' }))
    await assert.rejects(verifyTeamImportStage(data), /Memory stage incomplete/u)
    await writeFile(marker, original)
    await writeFile(join(data.memoryStageRoot, 'files', 'bots', data.plan.sessions[bot], 'MEMORY.md'), '# Altered\n')
    await assert.rejects(verifyTeamImportStage(data), /Staged memory changed/u)
  } finally { await rm(data.root, { recursive: true, force: true }) }
})

test('REQ-20261023-0001 rejects a group cache that has already rolled off old chat', async () => {
  const data = await fixture()
  try {
    const roomId = id('e')
    const line = { seq: 61, who: 'User', text: 'latest only' }
    const incomplete = { ...data.source, rooms: { [roomId]: {
      id: roomId, seq: 61, log: [line], members: [bot], sessions: {}, segments: {},
    } } }
    assert.throws(() => assertCompleteSourceGroupLogs(incomplete), /group chat history incomplete/u)
    await assert.rejects(verifyTeamImportStage({ ...data, source: incomplete }), /group chat history incomplete/u)
    const complete = { ...incomplete, rooms: { [roomId]: {
      ...incomplete.rooms[roomId], seq: 1, log: [{ ...line, seq: 1 }],
    } } }
    assert.doesNotThrow(() => assertCompleteSourceGroupLogs(complete))
    assert.doesNotThrow(() => assertCompleteSourceGroupLogs({ ...complete, rooms: { [roomId]: {
      id: roomId, members: [bot], sessions: {}, segments: {},
    } } }))
    assert.throws(() => assertCompleteSourceGroupLogs({ ...complete, rooms: { [roomId]: {
      ...complete.rooms[roomId], log: [{ ...line, seq: 2 }],
    } } }), /group chat history incomplete/u)
    assert.throws(() => assertCompleteSourceGroupLogs({ ...complete, rooms: { [roomId]: {
      ...complete.rooms[roomId], log: [{ ...line, seq: 1, length: 100 }],
    } } }), /group chat history incomplete/u)
  } finally { await rm(data.root, { recursive: true, force: true }) }
})
