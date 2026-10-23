import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/native-room-source.js'

function fixture(enabled = true) {
  let writer = true
  let busy = false
  let captures = 0
  let captureFailure = false
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
    createSession: async () => { creates += 1; return 'bridge-session' }, save: async () => {},
  }
  install(rt)
  return { rt, room, events, get captures() { return captures },
    get creates() { return creates },
    get nativeRoomService() { return nativeRoomService },
    setWriter(value) { writer = value }, setBusy(value) { busy = value },
    setCaptureFailure(value) { captureFailure = value } }
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
  f.room.seq = 4
  f.room.log = [
    { seq: 1, who: 'User', sourceKind: 'user', sourceMessageId: 'message-1', text: 'first' },
    { seq: 2, who: 'Bot', botId: 'one', text: 'reply' },
    { seq: 3, who: 'User', sourceKind: 'user', sourceMessageId: 'message-3', text: '@Agent help' },
    { seq: 4, who: 'Bot', botId: 'two', text: 'reply' },
  ]
  assert.deepEqual(await f.nativeRoomService.userMessages({ roomId: f.room.id, afterSeq: 0, limit: 2 }), {
    state: 'ok', room_id: f.room.id, next_seq: 2, last_seq: 4,
    messages: [{ seq: 1, message_id: 'message-1', text: 'first' }],
  })
  assert.deepEqual(await f.nativeRoomService.userMessages({ roomId: f.room.id, afterSeq: 2, limit: 2 }), {
    state: 'ok', room_id: f.room.id, next_seq: 4, last_seq: 4,
    messages: [{ seq: 3, message_id: 'message-3', text: '@Agent help' }],
  })
})

test('native room reads fail closed on a lost or unverifiable message', async () => {
  const f = fixture()
  await f.nativeRoomService.prepare({ roomId: f.room.id })
  f.room.seq = 3
  f.room.log = [{ seq: 2, who: 'User', sourceKind: 'user', sourceMessageId: 'message-2', text: 'later' },
    { seq: 3, who: 'Bot', botId: 'one', text: 'reply' }]
  assert.deepEqual(await f.nativeRoomService.userMessages({ roomId: f.room.id, afterSeq: 0, limit: 10 }),
    { state: 'history_gap' })
  f.room.log.unshift({ seq: 1, who: 'User', sourceKind: 'user', text: 'legacy' })
  assert.deepEqual(await f.nativeRoomService.userMessages({ roomId: f.room.id, afterSeq: 0, limit: 10 }),
    { state: 'unverifiable_message', seq: 1 })
  f.room.log[0].sourceMessageId = 'message-1'
  f.room.log[0].length = 50_000
  assert.deepEqual(await f.nativeRoomService.userMessages({ roomId: f.room.id, afterSeq: 0, limit: 10 }),
    { state: 'unverifiable_message', seq: 1 })
  f.setWriter(false)
  assert.deepEqual(await f.nativeRoomService.userMessages({ roomId: f.room.id, afterSeq: 0, limit: 10 }),
    { state: 'unavailable' })
})
