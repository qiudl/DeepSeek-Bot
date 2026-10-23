import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readTeamImportSourceSession } from '../src/host/team-import-source.js'

const id = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const targetId = 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const plan = { sessions: { [id]: targetId } }
const events = [{ seq: 0, type: 'system/message', surfaceOp: 'append', data: { text: 'Source' } }]

function fixture() {
  const calls = []
  const snapshot = { header: { id }, revision: 'r1', eventCount: 1, sizeBytes: 100 }
  const handle = { access: 'read', id, header: { id },
    read: async (offset, length) => { calls.push(`read:${offset}:${length}`); return { events } },
    close: async () => { calls.push('close') } }
  const ctx = { sessionPersistence: {
    stat: async () => { calls.push('stat'); return snapshot },
    open: async (_id, access) => { calls.push(`open:${access}`); return handle },
  } }
  return { ctx, calls, snapshot, handle }
}

test('REQ-20261023-0001 reads source events through a bounded DSH read handle', async () => {
  const { ctx, calls } = fixture()
  const result = await readTeamImportSourceSession(ctx, id, plan)
  assert.deepEqual(result, { events, eventCount: 1,
    digest: createHash('sha256').update(JSON.stringify(events)).digest('hex') })
  assert.deepEqual(calls, ['stat', 'open:read', 'read:0:100001', 'close', 'stat'])
})

test('REQ-20261023-0001 closes a source handle and refuses changed or oversized logs', async () => {
  const changed = fixture()
  let count = 0
  changed.ctx.sessionPersistence.stat = async () => ({ ...changed.snapshot, revision: `r${++count}` })
  await assert.rejects(readTeamImportSourceSession(changed.ctx, id, plan), /changed during read/u)
  assert.deepEqual(changed.calls, ['open:read', 'read:0:100001', 'close'])

  const unsafe = fixture()
  unsafe.handle.access = 'write'
  await assert.rejects(readTeamImportSourceSession(unsafe.ctx, id, plan), /not read-only/u)
  assert.deepEqual(unsafe.calls, ['stat', 'open:read', 'close'])

  const tooLarge = fixture()
  tooLarge.snapshot.sizeBytes = 64_000_001
  await assert.rejects(readTeamImportSourceSession(tooLarge.ctx, id, plan), /too large/u)
  assert.deepEqual(tooLarge.calls, ['stat'])

  const failed = fixture()
  failed.handle.read = async () => { throw new Error('corrupt log') }
  await assert.rejects(readTeamImportSourceSession(failed.ctx, id, plan), /corrupt log/u)
  assert.deepEqual(failed.calls, ['stat', 'open:read', 'close'])

  const unplanned = fixture()
  await assert.rejects(readTeamImportSourceSession(unplanned.ctx, id, { sessions: {} }), /Invalid source Session reader/u)
  assert.deepEqual(unplanned.calls, [])
})
