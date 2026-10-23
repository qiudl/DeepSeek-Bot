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
