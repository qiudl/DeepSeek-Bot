import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { inventoryVisibleBotChatAttachments, readVisibleBotChatAttachment } from '../src/host/team-remote-bot-chat-attachments.js'

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png',
  bytes: 42, width: 1, height: 1, name: 'photo.png' }
const at = (seq, type, data) => ({ seq, time: 1_760_000_000_000 + seq, type, data })

test('REQ-20261023-0001 inventories visible attachments without exposing hidden event data', () => {
  const events = [
    at(0, 'system/message', { content: [{ type: 'image', attachment: ref }] }),
    at(1, 'user/message', { source: { kind: 'user' }, content: [
      { type: 'text', text: 'look' }, { type: 'image', attachment: ref }] }),
    at(2, 'assistant/message', { message: { content: [
      { type: 'reasoning', text: 'private' }, { type: 'text', text: 'seen' }] } }),
    at(3, 'tool/result', { content: [{ type: 'image', attachment: ref }] }),
    at(4, 'user/message', { source: { kind: 'bot', role: 'kickoff' },
      content: [{ type: 'text', text: 'hidden setup' }] }),
    at(5, 'assistant/message', { message: { content: [{ type: 'image', attachment: ref }] } }),
  ]
  const result = inventoryVisibleBotChatAttachments(events, sha(events))
  assert.deepEqual(result.items, [{ eventSeq: 1, blockIndex: 1, type: 'image', ref }])
  assert.equal(result.eventDigest, sha(events))
  assert.equal(result.manifestDigest, sha(result.items))
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('REQ-20261023-0001 rejects stale and malformed visible attachment references', () => {
  const events = [at(0, 'user/message', { source: { kind: 'user' },
    content: [{ type: 'image', attachment: ref }] })]
  assert.throws(() => inventoryVisibleBotChatAttachments(events, '0'.repeat(64)), /Invalid/u)
  const broken = structuredClone(events)
  broken[0].data.content[0].attachment.attachmentId = 'other'
  assert.throws(() => inventoryVisibleBotChatAttachments(broken, sha(broken)), /Invalid attachment/u)
  const unknown = [at(0, 'user/message', { source: { kind: 'user' },
    content: [{ type: 'new-visible-block', secret: 'hidden' }] })]
  assert.throws(() => inventoryVisibleBotChatAttachments(unknown, sha(unknown)), /Invalid/u)
})

test('REQ-20261023-0001 reads only visible attachments bound to a Session manifest', async () => {
  const data = Buffer.from('visible image bytes')
  const visibleRef = { ...ref, bytes: data.length,
    attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}` }
  const fileData = Buffer.from('visible file bytes')
  const fileRef = { attachmentId: `sha256:${createHash('sha256').update(fileData).digest('hex')}`,
    name: 'notes.txt', bytes: fileData.length }
  const events = [
    at(0, 'system/message', { content: [{ type: 'image', attachment: visibleRef }] }),
    at(1, 'user/message', { source: { kind: 'user' }, content: [
      { type: 'text', text: 'look' }, { type: 'image', attachment: visibleRef },
      { type: 'file', attachment: fileRef }] }),
  ]
  const digest = sha(events)
  const manifest = inventoryVisibleBotChatAttachments(events, digest)
  let reads = 0
  const ctx = { attachments: { readImage: async found => {
    reads++
    assert.deepEqual(found, visibleRef)
    return { ref: found, data }
  }, async *readFileStream(found) {
    reads++
    assert.deepEqual(found, fileRef)
    yield fileData.subarray(0, 4)
    yield fileData.subarray(4)
  } } }
  const collect = async (eventDigest, manifestDigest, selector) => {
    const chunks = []
    for await (const chunk of readVisibleBotChatAttachment(ctx, events, eventDigest,
      manifestDigest, selector)) chunks.push(chunk)
    return Buffer.concat(chunks)
  }
  assert.deepEqual(await collect(digest, manifest.manifestDigest,
    { eventSeq: 1, blockIndex: 1 }), data)
  assert.deepEqual(await collect(digest, manifest.manifestDigest,
    { eventSeq: 1, blockIndex: 2 }), fileData)
  assert.equal(reads, 2)
  await assert.rejects(collect(digest, manifest.manifestDigest,
    { eventSeq: 0, blockIndex: 0 }), /Invalid Bot chat attachment source/u)
  await assert.rejects(collect(digest, '0'.repeat(64),
    { eventSeq: 1, blockIndex: 1 }), /Invalid Bot chat attachment source/u)
  await assert.rejects(collect('0'.repeat(64), manifest.manifestDigest,
    { eventSeq: 1, blockIndex: 1 }), /Invalid Bot chat attachment source/u)
  assert.equal(reads, 2)
})
