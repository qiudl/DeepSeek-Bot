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

test('REQ-20261023-0001 recovers a full journal suffix not committed in team state', async () => fixture(async home => {
  const room = { id: roomId, seq: 0, log: [] }
  const writer = createGroupHistory(home, () => true)
  writer.append(room, { seq: 1, who: 'User', text: 'uncommitted' })
  const restarted = createGroupHistory(home, () => true)
  assert.deepEqual(restarted.recover(room), { complete: true, firstSeq: 1, lastSeq: 0 })
  restarted.append(room, { seq: 1, who: 'User', text: 'committed' })
  room.seq = 1
  room.log = [{ seq: 1, who: 'User', text: 'committed' }]
  assert.deepEqual(restarted.inspect(room), { complete: true, firstSeq: 1, lastSeq: 1 })
}))

test('REQ-20261023-0001 recovers a partial suffix only after the committed prefix', async () => fixture(async home => {
  const room = { id: roomId, seq: 0, log: [] }
  const writer = createGroupHistory(home, () => true)
  writer.append(room, { seq: 1, who: 'User', text: 'committed' })
  room.seq = 1
  room.log = [{ seq: 1, who: 'User', text: 'committed' }]
  const path = join(home, 'group-history', `${roomId}.jsonl`)
  await writeFile(path, `${await readFile(path, 'utf8')}{"seq":2`)
  const restarted = createGroupHistory(home, () => true)
  assert.deepEqual(restarted.recover(room), { complete: true, firstSeq: 1, lastSeq: 1 })
  assert.deepEqual(restarted.inspect(room), { complete: true, firstSeq: 1, lastSeq: 1 })
}))

test('REQ-20261023-0001 refuses recovery when committed history is missing or changed', async () => fixture(async home => {
  const room = { id: roomId, seq: 0, log: [] }
  const writer = createGroupHistory(home, () => true)
  writer.append(room, { seq: 1, who: 'User', text: 'committed' })
  room.seq = 1
  room.log = [{ seq: 1, who: 'User', text: 'committed' }]
  const path = join(home, 'group-history', `${roomId}.jsonl`)
  const rows = (await readFile(path, 'utf8')).trimEnd().split('\n')
  await writeFile(path, `${rows[0]}\n`)
  assert.throws(() => createGroupHistory(home, () => true).recover(room), /needs recovery/u)
  await writeFile(path, `${rows[0]}\n${rows[1].replace('committed', 'changed')}\n`)
  assert.throws(() => createGroupHistory(home, () => true).recover(room), /needs recovery/u)
}))

test('REQ-20261023-0001 keeps a committed journal marker from being silently reseeded', async () => fixture(async home => {
  const room = { id: roomId, seq: 0, log: [] }
  const writer = createGroupHistory(home, () => true)
  writer.append(room, { seq: 1, who: 'User', text: 'committed' })
  room.seq = 1
  room.log = [{ seq: 1, who: 'User', text: 'committed' }]
  room.historyJournal = writer.checkpoint(room)
  const path = join(home, 'group-history', `${roomId}.jsonl`)
  await rm(path)
  assert.throws(() => createGroupHistory(home, () => true).recover(room), /needs recovery/u)
  assert.throws(() => createGroupHistory(home, () => true).append(room, { seq: 2, who: 'User', text: 'next' }), /needs recovery/u)
}))

test('REQ-20261023-0001 checks the committed digest before trimming an uncommitted suffix', async () => fixture(async home => {
  const room = { id: roomId, seq: 0, log: [] }
  const writer = createGroupHistory(home, () => true)
  writer.append(room, { seq: 1, who: 'User', text: 'committed' })
  room.seq = 1
  room.log = [{ seq: 1, who: 'User', text: 'committed' }]
  room.historyJournal = writer.checkpoint(room)
  writer.append(room, { seq: 2, who: 'User', text: 'uncommitted' })
  const recovered = createGroupHistory(home, () => true)
  assert.deepEqual(recovered.recover(room), { complete: true, firstSeq: 1, lastSeq: 1 })
  room.historyJournal.digest = '0'.repeat(64)
  assert.throws(() => createGroupHistory(home, () => true).recover(room), /needs recovery/u)
}))

test('REQ-20261023-0001 pages only the committed journal bytes', async () => fixture(async home => {
  const room = { id: roomId, seq: 0, log: [] }
  const writer = createGroupHistory(home, () => true)
  for (let seq = 1; seq <= 3; seq++) {
    const line = { seq, who: 'User', text: `line ${seq} ` + '长'.repeat(100) }
    writer.append(room, line)
    room.seq = seq
    room.log.push(line)
    room.historyJournal = writer.checkpoint(room)
  }
  writer.append(room, { seq: 4, who: 'User', text: 'uncommitted' })
  const reader = createGroupHistory(home, () => false)
  const chunks = []
  let total
  for (let offset = 0; total === undefined || offset < total;) {
    const page = reader.readChunk(room, offset, 73)
    assert.equal(page.seq, 3)
    assert.equal(page.digest, room.historyJournal.digest)
    total = page.totalBytes
    chunks.push(page.content)
    offset += page.content.length
  }
  const text = Buffer.concat(chunks).toString('utf8')
  assert.equal(Buffer.byteLength(text), total)
  assert.equal(text.includes('uncommitted'), false)
  assert.match(text, /line 3/u)
  assert.throws(() => reader.readChunk(room, total + 1, 73), /needs recovery/u)
  assert.throws(() => reader.readChunk(room, 0, 32 * 1024 + 1), /needs recovery/u)
}))

test('REQ-20261023-0001 cached pages invalidate when a committed journal changes', async () => fixture(async home => {
  const room = { id: roomId, seq: 0, log: [] }
  const writer = createGroupHistory(home, () => true)
  const line = { seq: 1, who: 'User', text: 'committed' }
  writer.append(room, line)
  room.seq = 1
  room.log = [line]
  room.historyJournal = writer.checkpoint(room)
  const reader = createGroupHistory(home, () => false)
  const first = reader.readChunk(room, 0, 9)
  assert.equal(first.seq, 1)
  const path = join(home, 'group-history', `${roomId}.jsonl`)
  await writeFile(path, (await readFile(path, 'utf8')).replace('committed', 'tamperedd'))
  assert.throws(() => reader.readChunk(room, 9, 9), /needs recovery/u)
}))
