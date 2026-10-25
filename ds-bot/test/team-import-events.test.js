import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { remapSessionEvents } from '../src/host/team-import-events.js'

const id = hex => `session-${hex.repeat(8)}-${hex.repeat(4)}-${hex.repeat(4)}-${hex.repeat(4)}-${hex.repeat(12)}`
const own = id('a'), sender = id('b'), room = id('c')
const targetOwn = id('1'), targetSender = id('2'), targetRoom = id('3')
const plan = { sessions: { [own]: targetOwn, [sender]: targetSender, [room]: targetRoom } }

const events = [
  { type: 'system/message', seq: 0, time: 1, surfaceOp: 'append', data: { turn: 1, step: 1,
    message: createSystemMessage('Source prompt') } },
  { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append',
    data: { content: [{ type: 'text', text: own }], source: { senderSessionId: sender, roomId: room } } },
  { type: 'agent/inbox/spliced', seq: 2, time: 3,
    data: { inserted: [{ source: { senderSessionId: sender, roomId: room } }] } },
  { type: 'session-log-deepseek/delivery-accepted', seq: 3, time: 4, data: { sessionId: own, throughSeq: 2 } },
]
const targetSystemMessage = createSystemMessage('')

test('REQ-20261023-0001 remaps structural history references and preserves quoted chat text', () => {
  const original = structuredClone(events)
  const mapped = remapSessionEvents(events, own, plan, { active: true, targetSystemMessage })
  assert.deepEqual(mapped[0].data.message, targetSystemMessage)
  assert.equal(mapped[1].data.source.senderSessionId, targetSender)
  assert.equal(mapped[1].data.source.roomId, targetRoom)
  assert.equal(mapped[2].data.inserted[0].source.senderSessionId, targetSender)
  assert.equal(mapped[2].data.inserted[0].source.roomId, targetRoom)
  assert.equal(mapped[3].data.sessionId, targetOwn)
  assert.equal(mapped[1].data.content[0].text, own)
  assert.deepEqual(events, original)
})

test('REQ-20261023-0001 refuses invalid active history and unfamiliar structural references', () => {
  const noSystem = structuredClone(events)
  noSystem[0].type = 'user/message'
  assert.throws(() => remapSessionEvents(noSystem, own, plan, { active: true, targetSystemMessage }), /protected system message/u)
  const gap = structuredClone(events)
  gap[2].seq = 8
  assert.throws(() => remapSessionEvents(gap, own, plan, { targetSystemMessage }), /Invalid Session event sequence/u)
  const unknown = structuredClone(events)
  unknown.push({ type: 'future/event', seq: 4, time: 5, data: { sessionId: sender } })
  assert.throws(() => remapSessionEvents(unknown, own, plan, { targetSystemMessage }), /Unmapped Session reference/u)
  unknown[4].data = { originRef: sender }
  assert.throws(() => remapSessionEvents(unknown, own, plan, { targetSystemMessage }), /Unmapped Session reference/u)
  const foreign = structuredClone(events)
  foreign[3].data.sessionId = sender
  assert.throws(() => remapSessionEvents(foreign, own, plan, { targetSystemMessage }), /Wrong delivery Session/u)
})

test('REQ-20261023-0001 requires staged attachment refs and maps the exact content blocks', () => {
  const sourceRef = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png',
    bytes: 68, width: 1, height: 1, name: 'photo.png' }
  const targetRef = { ...sourceRef, attachmentId: `sha256:${'b'.repeat(64)}` }
  const withImage = structuredClone(events)
  withImage[1].data.content.push({ type: 'image', attachment: sourceRef })
  assert.throws(() => remapSessionEvents(withImage, own, plan, { targetSystemMessage }), /Unstaged attachment/u)
  const mapped = remapSessionEvents(withImage, own, plan, {
    attachments: [{ type: 'image', sourceRef, targetRef }], targetSystemMessage,
  })
  assert.deepEqual(mapped[1].data.content[1].attachment, targetRef)
  assert.deepEqual(withImage[1].data.content[1].attachment, sourceRef)
  assert.equal(mapped[1].data.content[0].text, own)
})

test('REQ-20261023-0001 rejects imported system prompts without a target replacement', () => {
  assert.throws(() => remapSessionEvents(events, own, plan, { active: true }), /Target-generated system prompt required/u)
  assert.throws(() => remapSessionEvents(events, own, plan, {
    active: true, targetSystemMessage: events[0].data.message,
  }), /Target-generated system prompt required/u)
  assert.throws(() => remapSessionEvents(events, own, plan, {
    active: true, targetSystemMessage: createSystemMessage('Source prompt'),
  }), /Target-generated system prompt required/u)
  assert.throws(() => remapSessionEvents(events, own, plan, {
    active: true, targetSystemMessage: createSystemMessage('Target prompt'),
  }), /Target-generated system prompt required/u)
  assert.throws(() => remapSessionEvents(events, own, plan, {
    active: true, targetSystemMessage: { ...targetSystemMessage, legacyText: 'Source prompt' },
  }), /Target-generated system prompt required/u)
})
