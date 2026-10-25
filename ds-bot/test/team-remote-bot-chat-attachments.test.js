import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { inventoryVisibleBotChatAttachments } from '../src/host/team-remote-bot-chat-attachments.js'

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
