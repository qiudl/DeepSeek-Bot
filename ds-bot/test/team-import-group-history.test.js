import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGroupHistory } from '../src/host/group-history.js'
import { inventorySourceGroupHistories } from '../src/host/team-import-group-history.js'

const roomId = 'session-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
const source = room => ({ version: 1, rooms: { [roomId]: room } })

test('REQ-20261023-0001 inventories a complete committed group beyond its UI cache', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-import-group-'))
  try {
    const writer = createGroupHistory(home, () => true)
    const room = { id: roomId, seq: 0, log: [] }
    for (let seq = 1; seq <= 65; seq++) {
      const line = { seq, who: 'User', text: `line ${seq}` }
      writer.append(room, line)
      room.seq = seq
      room.log = [...room.log, line].slice(-60)
      room.historyJournal = writer.checkpoint(room)
    }
    const inventory = inventorySourceGroupHistories(home, source(room))
    assert.equal(inventory.length, 1)
    assert.equal(inventory[0].sourceRoomId, roomId)
    assert.equal(inventory[0].source, 'committed-journal')
    assert.equal(inventory[0].seq, 65)
    assert.equal(inventory[0].digest, room.historyJournal.digest)
    assert.ok(inventory[0].totalBytes > 0)
    assert.throws(() => inventorySourceGroupHistories(home, source({ ...room,
      historyJournal: { ...room.historyJournal, digest: '0'.repeat(64) } })), /history incomplete/u)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('REQ-20261023-0001 distinguishes complete legacy cache from rolled or truncated history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-import-group-'))
  try {
    const complete = { id: roomId, seq: 1, log: [{ seq: 1, who: 'User', text: 'full' }] }
    assert.deepEqual(inventorySourceGroupHistories(home, source(complete)).map(item => item.source),
      ['complete-cache'])
    assert.throws(() => inventorySourceGroupHistories(home, source({ ...complete,
      seq: 61, log: [{ seq: 61, who: 'User', text: 'tail' }] })), /history incomplete/u)
    assert.throws(() => inventorySourceGroupHistories(home, source({ ...complete,
      log: [{ ...complete.log[0], length: 100 }] })), /history incomplete/u)
  } finally { await rm(home, { recursive: true, force: true }) }
})
