import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { selectRemoteBotChatAttachment } from '../src/host/team-remote-bot-chat-page.js'
import { inventoryVisibleBotChatAttachments } from '../src/host/team-remote-bot-chat-attachments.js'
import { createRemoteBotChatAttachmentTransfers,
  parseRemoteBotChatAttachmentTransferRequest } from '../src/host/team-remote-bot-chat-transfer.js'

const sessionId = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const logicalId = `bot:${sessionId}`
const bytes = Buffer.alloc(70_001, 7)
const sha = value => createHash('sha256').update(value).digest('hex')
const ref = { attachmentId: `sha256:${sha(bytes)}`, name: 'report.bin', bytes: bytes.length }
const events = [{ seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'user' },
  content: [{ type: 'file', attachment: ref }] } }]
const source = { events, eventCount: events.length, digest: sha(JSON.stringify(events)) }
const manifest = inventoryVisibleBotChatAttachments(events, source.digest)
const team = { revision: 7, bots: { [sessionId]: { id: sessionId,
  sessionId, segments: [] } }, rooms: {} }
const open = { schema_version: 'dsh-remote-bot-attachment/v1', kind: 'open',
  logical_id: logicalId, part: 0, team_revision: 7, event_digest: source.digest,
  manifest_digest: manifest.manifestDigest, eventSeq: 1, blockIndex: 0 }
const signal = () => new AbortController().signal

function fixture(chunks = [bytes], sourceValue = source) {
  let current = true, confirmed = true
  const ctx = { attachments: {
    readImage: async () => { throw Error('not an image') },
    readFileStream: async function* () { for (const chunk of chunks) yield chunk },
  } }
  const transfers = createRemoteBotChatAttachmentTransfers({ ctx,
    select: target => selectRemoteBotChatAttachment(team, target, async () => sourceValue),
    current: async () => current, confirm: async () => confirmed })
  return { transfers, revoke: () => { current = false }, change: () => { confirmed = false } }
}

test('REQ-20261023-0001 reads one pinned attachment sequentially and verifies EOF', async () => {
  const f = fixture()
  const descriptor = await f.transfers.read(open, signal())
  assert.equal(descriptor.logical_id, logicalId)
  assert.equal(descriptor.total_bytes, bytes.length)
  assert.equal(f.transfers.activeCount(), 1)
  const received = []
  let offset = 0, final = false
  while (!final) {
    const page = await f.transfers.read({ schema_version: open.schema_version, kind: 'next',
      transfer_id: descriptor.transfer_id, offset }, signal())
    const chunk = Buffer.from(page.chunk_base64, 'base64')
    assert.equal(page.offset, offset)
    assert.ok(chunk.length <= 32 * 1024)
    received.push(chunk)
    offset += chunk.length
    final = page.final
  }
  assert.deepEqual(Buffer.concat(received), bytes)
  assert.equal(offset, bytes.length)
  assert.equal(f.transfers.activeCount(), 0)
  await assert.rejects(f.transfers.read({ schema_version: open.schema_version, kind: 'next',
    transfer_id: descriptor.transfer_id, offset }, signal()), { code: 'bot/invalid' })
})

test('REQ-20261023-0001 refuses stale, hidden, corrupted and revoked source bytes', async () => {
  const f = fixture()
  await assert.rejects(f.transfers.read({ ...open, blockIndex: 1 }, signal()), { code: 'bot/invalid' })
  await assert.rejects(f.transfers.read({ ...open, manifest_digest: '0'.repeat(64) }, signal()), { code: 'bot/stale' })
  assert.throws(() => parseRemoteBotChatAttachmentTransferRequest({ ...open, session_id: sessionId }),
    { code: 'bot/invalid' })
  const descriptor = await f.transfers.read(open, signal())
  await f.transfers.read({ schema_version: open.schema_version, kind: 'next',
    transfer_id: descriptor.transfer_id, offset: 0 }, signal())
  f.revoke()
  await assert.rejects(f.transfers.read({ schema_version: open.schema_version, kind: 'next',
    transfer_id: descriptor.transfer_id, offset: 32 * 1024 }, signal()), { code: 'bot/stale' })
  assert.equal(f.transfers.activeCount(), 0)
  const corrupted = Buffer.from(bytes)
  corrupted[1] ^= 1
  const g = fixture([corrupted])
  const opened = await g.transfers.read(open, signal())
  await g.transfers.read({ schema_version: open.schema_version, kind: 'next',
    transfer_id: opened.transfer_id, offset: 0 }, signal())
  await g.transfers.read({ schema_version: open.schema_version, kind: 'next',
    transfer_id: opened.transfer_id, offset: 32 * 1024 }, signal())
  await assert.rejects(g.transfers.read({ schema_version: open.schema_version, kind: 'next',
    transfer_id: opened.transfer_id, offset: 64 * 1024 }, signal()), /changed/u)
  assert.equal(g.transfers.activeCount(), 0)
  const h = fixture()
  const openedH = await h.transfers.read(open, signal())
  h.change()
  await h.transfers.read({ schema_version: open.schema_version, kind: 'next',
    transfer_id: openedH.transfer_id, offset: 0 }, signal())
  await h.transfers.read({ schema_version: open.schema_version, kind: 'next',
    transfer_id: openedH.transfer_id, offset: 32 * 1024 }, signal())
  await assert.rejects(h.transfers.read({ schema_version: open.schema_version, kind: 'next',
    transfer_id: openedH.transfer_id, offset: 64 * 1024 }, signal()), { code: 'bot/stale' })
  assert.equal(h.transfers.activeCount(), 0)
})

test('REQ-20261023-0001 cancellation closes the pinned source iterator', async () => {
  const f = fixture()
  const descriptor = await f.transfers.read(open, signal())
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(f.transfers.read({ schema_version: open.schema_version, kind: 'next',
    transfer_id: descriptor.transfer_id, offset: 0 }, cancelled.signal))
  assert.equal(f.transfers.activeCount(), 0)
})

test('REQ-20261023-0001 copies the final buffer before verifying stream EOF', async () => {
  const shared = Uint8Array.of(7)
  const selected = { source: { events: [], digest: source.digest }, sessionId,
    logicalId, part: 0, partCount: 1, teamRevision: 7,
    item: { type: 'file', ref: { attachmentId: ref.attachmentId, name: 'x', bytes: 1 } } }
  const transfers = createRemoteBotChatAttachmentTransfers({ ctx: {},
    select: async () => selected, current: async () => true, confirm: async () => true,
    stream: async function* () { yield shared; shared[0] = 9 } })
  const descriptor = await transfers.read(open, signal())
  const page = await transfers.read({ schema_version: open.schema_version, kind: 'next',
    transfer_id: descriptor.transfer_id, offset: 0 }, signal())
  assert.equal(page.final, true)
  assert.equal(Buffer.from(page.chunk_base64, 'base64')[0], 7)
})

test('REQ-20261023-0001 limits active streams and retires idle transfers', async () => {
  let clock = 0
  const ctx = { attachments: { readImage: async () => { throw Error('not image') },
    readFileStream: async function* () { yield bytes } } }
  const transfers = createRemoteBotChatAttachmentTransfers({ ctx, now: () => clock,
    select: target => selectRemoteBotChatAttachment(team, target, async () => source),
    current: async () => true, confirm: async () => true })
  const one = await transfers.read(open, signal())
  const two = await transfers.read(open, signal())
  await assert.rejects(transfers.read(open, signal()), { code: 'bot/busy' })
  assert.deepEqual(await transfers.read({ schema_version: open.schema_version,
    kind: 'close', transfer_id: one.transfer_id }), { closed: true })
  const three = await transfers.read(open, signal())
  clock = 60_001
  await assert.rejects(transfers.read({ schema_version: open.schema_version,
    kind: 'next', transfer_id: three.transfer_id, offset: 0 }, signal()), { code: 'bot/invalid' })
  assert.equal(transfers.activeCount(), 1)
  await transfers.closeAll()
  assert.equal(transfers.activeCount(), 0)
  assert.notEqual(two.transfer_id, three.transfer_id)
})

test('REQ-20261023-0001 empty files complete at EOF', async () => {
  const selected = { source: { events: [], digest: source.digest }, sessionId,
    logicalId, part: 0, partCount: 1, teamRevision: 7,
    item: { type: 'file', ref: { attachmentId: `sha256:${sha(Buffer.alloc(0))}`,
      name: 'empty.txt', bytes: 0 } } }
  const transfers = createRemoteBotChatAttachmentTransfers({ ctx: {},
    select: async () => selected, current: async () => true, confirm: async () => true,
    stream: async function* () {} })
  const descriptor = await transfers.read(open, signal())
  const page = await transfers.read({ schema_version: open.schema_version, kind: 'next',
    transfer_id: descriptor.transfer_id, offset: 0 }, signal())
  assert.equal(page.final, true)
  assert.equal(page.chunk_base64, '')
  assert.equal(transfers.activeCount(), 0)
})
