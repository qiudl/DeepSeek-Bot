import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, queueNativeRoomTurn, recordNativeRoomLine } from '../src/host/native-room-source.js'

const GROUP = '11111111-1111-4111-8111-111111111111'
const MEMBER = '22222222-2222-4222-8222-222222222222'
const NEXT_MEMBER = '33333333-3333-4333-8333-333333333333'
const agent = { groupId: GROUP, memberId: MEMBER, cycle: 1,
  projectId: 'project-1', agentId: 'agent-1', name: 'Slark Agent · Project / Helper' }

function fixture(enabled = true) {
  let writer = true
  let busy = false
  let captures = 0
  let captureFailure = false
  let saveFailure = false
  let nativeRoomService
  const events = []
  const room = { id: 'room-session', name: 'Team', members: ['one', 'two'] }
  const state = { workspaceId: 'workspace-1', rooms: { [room.id]: room } }
  const session = { append(type, message, options) { events.push({ type, message, options }) } }
  let creates = 0
  const rt = {
    config: { slarkExternalGroup: enabled }, state,
    ctx: {
      sessions: { get: id => id === 'bridge-session' ? session : undefined, flush: async () => {} },
      sessionController: { async captureCollaborationSource(input) {
        captures += 1
        if (captureFailure) throw Error('capture_failed')
        assert.equal(input.source_message_id, events[0].message.id)
        assert.equal(input.original_message, events[0].message.content[0].text)
        return { kind: 'captured', snapshot: input }
      } },
      workspaceRegistry: { get: id => id === state.workspaceId ? { id } : undefined },
      provide(name, service) {
        assert.equal(name, 'dsBotSlarkNativeRoom')
        nativeRoomService = service
      },
    },
    roomOf: id => state.rooms[id], roomBusy: () => busy,
    refresh: async () => {}, hasExclusiveWriter: () => writer,
    createSession: async () => { creates += 1; return 'bridge-session' },
    save: async () => { if (saveFailure) throw Error('save_failed') },
  }
  install(rt)
  return { rt, room, events, get captures() { return captures },
    get creates() { return creates },
    get nativeRoomService() { return nativeRoomService },
    setWriter(value) { writer = value }, setBusy(value) { busy = value },
    setCaptureFailure(value) { captureFailure = value }, setSaveFailure(value) { saveFailure = value } }
}

test('a native room source is a non-relayed Session event and a retry keeps its identity', async () => {
  const f = fixture()
  const first = await f.nativeRoomService.prepare({ roomId: 'room-session' })
  const second = await f.nativeRoomService.prepare({ roomId: 'room-session' })
  assert.deepEqual(second, first)
  assert.equal(f.captures, 1)
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0].type, 'user/message')
  assert.deepEqual(f.events[0].options, { surfaceOp: 'append' })
  assert.equal(f.events[0].message.source.kind, 'slark-native-room-join')
  assert.deepEqual(first, { room_id: 'room-session', source: {
    workspace_id: 'workspace-1', session_id: 'bridge-session',
    source_message_id: f.events[0].message.id, source_revision: '1' } })
  assert.equal(f.room.nativeSource.state, 'captured')
  assert.equal(f.creates, 1)
})

test('a failed capture retries the original durable control message', async () => {
  const f = fixture()
  f.setCaptureFailure(true)
  await assert.rejects(f.rt.prepareNativeRoomSource('room-session'), /capture_failed/)
  assert.equal(f.room.nativeSource.state, 'pending')
  f.setCaptureFailure(false)
  const target = await f.rt.prepareNativeRoomSource('room-session')
  assert.equal(target.source_message_id, f.events[0].message.id)
  assert.equal(f.events.length, 1)
  assert.equal(f.captures, 2)
  assert.equal(f.creates, 1)
})

test('a missing room, busy room or non-writer cannot create a Source', async () => {
  const f = fixture()
  f.setWriter(false)
  assert.equal(await f.rt.prepareNativeRoomSource('room-session'), null)
  f.setWriter(true)
  f.setBusy(true)
  assert.equal(await f.rt.prepareNativeRoomSource('room-session'), null)
  f.setBusy(false)
  assert.equal(await f.rt.prepareNativeRoomSource('missing'), null)
  assert.equal(f.events.length, 0)
  assert.equal(f.captures, 0)
  assert.equal(fixture(false).rt.prepareNativeRoomSource, undefined)
})

test('native room reads preserve original user message IDs and advance across Bot lines', async () => {
  const f = fixture()
  await f.nativeRoomService.prepare({ roomId: f.room.id })
  assert.deepEqual(await f.nativeRoomService.joinAgent({ roomId: f.room.id, ...agent }),
    { state: 'joined', joined_room_seq: 0 })
  const lines = [
    { seq: 1, who: 'User', sourceKind: 'user', sourceMessageId: 'message-1', text: 'first' },
    { seq: 2, who: 'Bot', botId: 'one', text: 'reply' },
    { seq: 3, who: 'User', sourceKind: 'user', sourceMessageId: 'message-3', text: '@Agent help' },
    { seq: 4, who: 'Bot', botId: 'two', text: 'reply' },
  ]
  for (const line of lines) { f.room.seq = line.seq; recordNativeRoomLine(f.room, line) }
  f.room.log = lines.slice(-2)
  assert.deepEqual(await f.nativeRoomService.roomMessages({ roomId: f.room.id, memberId: MEMBER,
    cycle: 1, afterSeq: 0, limit: 2 }), {
    state: 'ok', room_id: f.room.id, next_seq: 2, last_seq: 4,
    messages: [{ seq: 1, source_kind: 'user', message_id: 'message-1', text: 'first' },
      { seq: 2, source_kind: 'bot', message_id: '0a846508-670f-59a5-a393-9ddedb4bf3b0', bot_id: 'one', text: 'reply' }],
  })
  assert.deepEqual(await f.nativeRoomService.roomMessages({ roomId: f.room.id, memberId: MEMBER,
    cycle: 1, afterSeq: 2, limit: 2 }), {
    state: 'ok', room_id: f.room.id, next_seq: 4, last_seq: 4,
    messages: [{ seq: 3, source_kind: 'user', message_id: 'message-3', text: '@Agent help' },
      { seq: 4, source_kind: 'bot', message_id: '4568b790-e70a-5569-a313-ec0a20cc6803', bot_id: 'two', text: 'reply' }],
  })
  assert.deepEqual(await f.nativeRoomService.acknowledgeMessages({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, throughSeq: 2 }), { state: 'acknowledged', through_seq: 2 })
  assert.deepEqual(f.room.nativeOutbox.map(line => line.seq), [3, 4])
  assert.deepEqual(await f.nativeRoomService.roomMessages({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, afterSeq: 0 }),
    { state: 'ok', room_id: f.room.id, next_seq: 4, last_seq: 4,
      messages: [{ seq: 3, source_kind: 'user', message_id: 'message-3', text: '@Agent help' },
        { seq: 4, source_kind: 'bot', message_id: '4568b790-e70a-5569-a313-ec0a20cc6803',
          bot_id: 'two', text: 'reply' }] })
  assert.deepEqual(await f.nativeRoomService.acknowledgeMessages({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, throughSeq: 1 }), { state: 'acknowledged', through_seq: 2 })
  assert.deepEqual(await f.nativeRoomService.joinAgent({ roomId: f.room.id, ...agent,
    memberId: NEXT_MEMBER, agentId: 'agent-2', name: 'Slark Agent · Project / Other' }),
    { state: 'joined', joined_room_seq: 4 })
  assert.deepEqual(await f.nativeRoomService.roomMessages({ roomId: f.room.id,
    memberId: NEXT_MEMBER, cycle: 1, afterSeq: 0, limit: 2 }),
  { state: 'ok', room_id: f.room.id, next_seq: 4, last_seq: 4, messages: [] })
  assert.deepEqual(await f.nativeRoomService.roomMessages({ roomId: f.room.id,
    memberId: NEXT_MEMBER, cycle: 1, afterSeq: 1, limit: 2 }), { state: 'history_forbidden' })
})

test('native room reads fail closed on a lost or unverifiable message', async () => {
  const f = fixture()
  await f.nativeRoomService.prepare({ roomId: f.room.id })
  await f.nativeRoomService.joinAgent({ roomId: f.room.id, ...agent })
  f.room.seq = 3
  f.room.nativeOutbox = [{ seq: 2, who: 'User', sourceKind: 'user', sourceMessageId: 'message-2', text: 'later' },
    { seq: 3, who: 'Bot', botId: 'one', text: 'reply' }]
  assert.deepEqual(await f.nativeRoomService.roomMessages({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, afterSeq: 0, limit: 3 }),
    { state: 'history_gap' })
  f.room.nativeOutbox.unshift({ seq: 1, who: 'User', sourceKind: 'user', text: 'legacy' })
  assert.deepEqual(await f.nativeRoomService.roomMessages({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, afterSeq: 0, limit: 3 }),
    { state: 'unverifiable_message', seq: 1 })
  f.room.nativeOutbox[0].sourceMessageId = 'message-1'
  f.room.nativeOutbox[0].length = 50_000
  assert.deepEqual(await f.nativeRoomService.roomMessages({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, afterSeq: 0, limit: 3 }),
    { state: 'unverifiable_message', seq: 1 })
  f.setWriter(false)
  assert.deepEqual(await f.nativeRoomService.roomMessages({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, afterSeq: 0, limit: 3 }),
    { state: 'unavailable' })
})

test('two joined Agents independently read and acknowledge the same native lines', async () => {
  const f = fixture()
  await f.nativeRoomService.prepare({ roomId: f.room.id })
  await f.nativeRoomService.joinAgent({ roomId: f.room.id, ...agent })
  await f.nativeRoomService.joinAgent({ roomId: f.room.id, ...agent,
    memberId: NEXT_MEMBER, agentId: 'agent-2', name: 'Slark Agent · Project / Other' })
  f.room.seq = 1
  recordNativeRoomLine(f.room, { seq: 1, sourceKind: 'user', sourceMessageId: 'message-1', text: 'hello' })
  for (const memberId of [MEMBER, NEXT_MEMBER]) {
    const page = await f.nativeRoomService.roomMessages({ roomId: f.room.id,
      memberId, cycle: 1, afterSeq: 0 })
    assert.deepEqual(page.messages, [{ seq: 1, source_kind: 'user',
      message_id: 'message-1', text: 'hello' }])
  }
  assert.deepEqual(await f.nativeRoomService.acknowledgeMessages({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, throughSeq: 1 }), { state: 'acknowledged', through_seq: 1 })
  assert.deepEqual(f.room.nativeOutbox.map(line => line.seq), [1])
  assert.deepEqual(await f.nativeRoomService.acknowledgeMessages({ roomId: f.room.id,
    memberId: NEXT_MEMBER, cycle: 1, throughSeq: 1 }), { state: 'acknowledged', through_seq: 1 })
  assert.deepEqual(f.room.nativeOutbox, [])
})

test('native turns queue once for an original post and the current member cycle', async () => {
  const f = fixture()
  await f.nativeRoomService.prepare({ roomId: f.room.id })
  await f.nativeRoomService.joinAgent({ roomId: f.room.id, ...agent })
  const participant = { memberId: MEMBER, cycle: 1 }
  f.room.seq = 1
  f.room.log = [{ seq: 1, sourceKind: 'user', sourceMessageId: 'message-1', text: 'hello' }]
  assert.equal(queueNativeRoomTurn(f.room, participant), null)
  f.room.nativeTurnBridge = true
  const first = queueNativeRoomTurn(f.room, participant)
  assert.match(first.turnId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  assert.deepEqual(first, { key: `1:${MEMBER}:1`, turnId: first.turnId,
    groupId: GROUP, memberId: MEMBER,
    cycle: 1, triggerRoomSeq: 1, state: 'pending' })
  assert.equal(queueNativeRoomTurn(f.room, participant), first)
  assert.equal(f.room.nativeTurnOutbox.length, 1)
  assert.deepEqual(await f.nativeRoomService.roomTurns({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, afterSeq: 0 }), { state: 'turns', room_id: f.room.id,
    group_id: GROUP, member_id: MEMBER, cycle: 1, next_seq: 1,
    turns: [{ turn_id: first.turnId, trigger_room_seq: 1 }] })
  assert.equal(queueNativeRoomTurn(f.room, { memberId: MEMBER, cycle: 2 }), null)
  f.room.log = [{ seq: 2, sourceKind: 'user', sourceMessageId: 'message-2',
    text: '中'.repeat(6000) }]
  assert.equal(queueNativeRoomTurn(f.room, participant), null)
  assert.equal(f.room.nativeTurnOutbox.length, 1)
})

test('a failed member save is not reported as a durable join', async () => {
  const f = fixture()
  await f.nativeRoomService.prepare({ roomId: f.room.id })
  f.setSaveFailure(true)
  await assert.rejects(f.nativeRoomService.joinAgent({ roomId: f.room.id, ...agent }), /save_failed/)
  assert.equal(f.room.nativeMembers?.[MEMBER], undefined)
  f.setSaveFailure(false)
  assert.deepEqual(await f.nativeRoomService.joinAgent({ roomId: f.room.id, ...agent }),
    { state: 'joined', joined_room_seq: 0 })
})

test('leaving stops reads and a new cycle begins after the old room sequence', async () => {
  const f = fixture()
  await f.nativeRoomService.prepare({ roomId: f.room.id })
  await f.nativeRoomService.joinAgent({ roomId: f.room.id, ...agent })
  f.room.seq = 1
  recordNativeRoomLine(f.room, { seq: 1, sourceKind: 'user', sourceMessageId: 'message-1', text: 'old' })
  assert.deepEqual(await f.nativeRoomService.leaveAgent({ roomId: f.room.id, memberId: MEMBER, cycle: 1 }),
    { state: 'left', left_room_seq: 1 })
  assert.deepEqual(await f.nativeRoomService.roomMessages({ roomId: f.room.id, memberId: MEMBER,
    cycle: 1, afterSeq: 0 }), { state: 'unavailable' })
  assert.deepEqual(await f.nativeRoomService.joinAgent({ roomId: f.room.id, ...agent,
    memberId: NEXT_MEMBER, cycle: 2 }), { state: 'joined', joined_room_seq: 1 })
  assert.deepEqual(await f.nativeRoomService.roomMessages({ roomId: f.room.id, memberId: NEXT_MEMBER,
    cycle: 2, afterSeq: 0 }),
  { state: 'ok', room_id: f.room.id, next_seq: 1, last_seq: 1, messages: [] })
})

test('an unsuccessful acknowledgement keeps the message available for retry', async () => {
  const f = fixture()
  await f.nativeRoomService.prepare({ roomId: f.room.id })
  await f.nativeRoomService.joinAgent({ roomId: f.room.id, ...agent })
  f.room.seq = 1
  recordNativeRoomLine(f.room, { seq: 1, sourceKind: 'user', sourceMessageId: 'message-1', text: 'retry me' })
  assert.equal((await f.nativeRoomService.roomMessages({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, afterSeq: 0 })).next_seq, 1)
  f.setSaveFailure(true)
  await assert.rejects(f.nativeRoomService.acknowledgeMessages({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, throughSeq: 1 }), /save_failed/)
  assert.equal(f.room.nativeMembers[MEMBER].ackSeq, 0)
  assert.deepEqual(f.room.nativeOutbox.map(line => line.seq), [1])
  f.setSaveFailure(false)
  assert.equal((await f.nativeRoomService.roomMessages({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, afterSeq: 0 })).messages[0].text, 'retry me')
})

test('a multibyte message cannot exceed the Host frame budget', async () => {
  const f = fixture()
  await f.nativeRoomService.prepare({ roomId: f.room.id })
  await f.nativeRoomService.joinAgent({ roomId: f.room.id, ...agent })
  f.room.seq = 1
  recordNativeRoomLine(f.room, { seq: 1, sourceKind: 'user', sourceMessageId: 'message-1',
    text: '中'.repeat(6000) })
  assert.deepEqual(await f.nativeRoomService.roomMessages({ roomId: f.room.id,
    memberId: MEMBER, cycle: 1, afterSeq: 0 }),
  { state: 'unverifiable_message', seq: 1 })
})
