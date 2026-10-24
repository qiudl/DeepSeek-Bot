import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGroupHistory } from '../src/host/group-history.js'
import { TEXT_KEPT } from '../src/host/constants.js'
import { headOf } from '../src/host/text.js'

const roomId = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-group-history-'))
  try { await run(home) } finally { await rm(home, { recursive: true, force: true }) }
}

test('REQ-20261023-0001 retains full group lines after the UI cache rolls', async () => fixture(async home => {
  const history = createGroupHistory(home, () => true)
  const room = { id: roomId, seq: 0, log: [] }
  const longText = 'long '.repeat(600)
  for (let seq = 1; seq <= 65; seq++) {
    const full = { seq, who: 'User', text: seq === 1 ? longText : `line ${seq}` }
    history.append(room, full)
    room.seq = seq
    room.log.push(seq === 1 ? { ...full, text: headOf(longText, TEXT_KEPT), length: longText.length } : full)
    room.log = room.log.slice(-60)
  }
  assert.deepEqual(history.inspect(room), { complete: true, firstSeq: 1, lastSeq: 65 })
  const journal = await readFile(join(home, 'group-history', `${roomId}.jsonl`), 'utf8')
  const rows = journal.trimEnd().split('\n').map(JSON.parse)
  assert.equal(rows.length, 66)
  assert.equal(rows[1].line.text, longText)
  assert.equal(rows.at(-1).line.text, 'line 65')
  assert.deepEqual(createGroupHistory(home, () => true).inspect(room), history.inspect(room))
}))

test('REQ-20261023-0001 marks legacy, rolled group caches incomplete', async () => fixture(async home => {
  const room = { id: roomId, seq: 61, log: [{ seq: 61, who: 'User', text: 'old tail' }] }
  const history = createGroupHistory(home, () => true)
  history.append(room, { seq: 62, who: 'User', text: 'new line' }, { legacy: true })
  room.seq = 62
  room.log.push({ seq: 62, who: 'User', text: 'new line' })
  assert.deepEqual(history.inspect(room), { complete: false, firstSeq: 61, lastSeq: 62 })
}))

test('REQ-20261023-0001 fails closed on torn journal, stale state, or lost write authority', async () => fixture(async home => {
  const room = { id: roomId, seq: 0, log: [] }
  const history = createGroupHistory(home, () => true)
  history.append(room, { seq: 1, who: 'User', text: 'first' })
  assert.throws(() => history.inspect(room), /needs recovery/u)
  room.seq = 1
  room.log = [{ seq: 1, who: 'User', text: 'first' }]
  const path = join(home, 'group-history', `${roomId}.jsonl`)
  await writeFile(path, `${await readFile(path, 'utf8')}{"seq":2`)
  assert.throws(() => createGroupHistory(home, () => true).inspect(room), /needs recovery/u)
  assert.throws(() => createGroupHistory(home, () => false).append(room, { seq: 2, text: 'blocked' }), /needs recovery/u)
}))

test('REQ-20261023-0001 initializes an empty room as complete', async () => fixture(async home => {
  const room = { id: roomId, seq: 0, log: [] }
  const history = createGroupHistory(home, () => true)
  history.append(room, { seq: 1, who: 'User', text: 'first' })
  room.seq = 1
  room.log = [{ seq: 1, who: 'User', text: 'first' }]
  assert.deepEqual(history.inspect(room), { complete: true, firstSeq: 1, lastSeq: 1 })
}))
