import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { projectTextBotChatPart } from '../src/host/team-remote-bot-chat.js'

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const text = value => [{ type: 'text', text: value }]
const at = (seq, type, data) => ({ seq, time: 1_760_000_000_000 + seq, type, data })
const events = [
  at(0, 'system/message', { cwd: '/private/secret-workspace', apiKey: 'hidden-key' }),
  at(1, 'user/message', { source: { kind: 'user' }, content: text('Hi') }),
  at(2, 'assistant/message', { message: { content: [...text('Hello'),
    { type: 'reasoning', text: 'private chain of thought' },
    { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '/private/secret-workspace' }] } }),
  at(3, 'tool/result', { content: text('hidden tool secret') }),
  at(4, 'user/message', { source: { kind: 'bot', role: 'kickoff' }, content: text('setup') }),
  at(5, 'assistant/message', { message: { content: text('setup answer') } }),
  at(6, 'user/message', { source: { kind: 'bot', role: 'reply' }, content: text('Writer says done') }),
  at(7, 'assistant/message', { message: { content: text('Good') } }),
]

test('REQ-20261023-0001 projects only visible private chat text bound to source digest', () => {
  const projected = projectTextBotChatPart(events, sha(events))
  assert.deepEqual(projected, { eventCount: events.length, eventDigest: sha(events),
    rows: [
      { seq: 1, time: events[1].time, who: 'user', text: 'Hi' },
      { seq: 2, time: events[2].time, who: 'you', text: 'Hello' },
      { seq: 6, time: events[6].time, who: 'bot', text: 'Writer says done' },
      { seq: 7, time: events[7].time, who: 'you', text: 'Good' },
    ],
    rowsDigest: sha([
      { seq: 1, time: events[1].time, who: 'user', text: 'Hi' },
      { seq: 2, time: events[2].time, who: 'you', text: 'Hello' },
      { seq: 6, time: events[6].time, who: 'bot', text: 'Writer says done' },
      { seq: 7, time: events[7].time, who: 'you', text: 'Good' },
    ]) })
  assert.equal(JSON.stringify(projected).includes('hidden'), false)
  assert.equal(JSON.stringify(projected).includes('private chain of thought'), false)
  assert.equal(JSON.stringify(projected).includes('/private/secret-workspace'), false)
})

test('REQ-20261023-0001 rejects stale, malformed and rich private chats instead of truncating them', () => {
  assert.throws(() => projectTextBotChatPart(events, '0'.repeat(64)), /changed/u)
  const image = [at(1, 'user/message', { source: { kind: 'user' },
    content: [{ type: 'image', attachment: { attachmentId: 'a' } }] })]
  assert.throws(() => projectTextBotChatPart(image, sha(image)), /unsupported/u)
  const unknown = [at(1, 'assistant/message', { message: {
    content: [{ type: 'unexpected', secret: 'hidden' }] } })]
  assert.throws(() => projectTextBotChatPart(unknown, sha(unknown)), /unsupported/u)
  const malformed = [{ ...events[1], seq: -1 }]
  assert.throws(() => projectTextBotChatPart(malformed, sha(malformed)), /Invalid/u)
  const reordered = [events[1], { ...events[2], seq: 1 }]
  assert.throws(() => projectTextBotChatPart(reordered, sha(reordered)), /Invalid/u)
})
