import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pumpNativeRoomSnapshot } from '../src/client/native-room-sync.js'

const workspace = '11111111-1111-4111-8111-111111111111'
const memberId = '22222222-2222-4222-8222-222222222222'
const groupId = '33333333-3333-4333-8333-333333333333'

test('native room sync selects only a captured, currently joined room member', async () => {
  const calls = []
  const host = { collaborationNativeRoomPump: async input => { calls.push(input) } }
  const joined = { id: 'room_1', seq: 2, nativeGroupId: groupId,
    nativeSource: { state: 'captured', roomId: 'room_1', workspaceId: workspace,
      target: { workspace_id: workspace, session_id: 'bridge-session' } },
    nativeMembers: { [memberId]: { state: 'active', groupId, memberId, ackSeq: 1 } } }
  const stale = { ...joined, id: 'other' }
  const departed = { ...joined, nativeMembers: { [memberId]: {
    state: 'left', groupId, memberId } } }
  assert.equal(await pumpNativeRoomSnapshot({ rooms: [stale, departed, joined] }, host), 1)
  assert.deepEqual(calls, [{ workspace_id: workspace, session_id: 'bridge-session',
    member_id: memberId }])
  assert.equal(await pumpNativeRoomSnapshot({ rooms: [joined] }, host, () => false), 0)
  assert.equal(await pumpNativeRoomSnapshot({ rooms: [{ ...joined, nativeMembers: {
    [memberId]: { state: 'active', groupId, memberId, ackSeq: 2 } } }] }, host), 0)
})
