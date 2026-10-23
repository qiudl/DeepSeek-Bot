// A native room keeps its first Slark binding Source in the room's own DSH Session.
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const CONTROL_TEXT = '[Slark Agent group membership requested]'

export function install(rt) {
  if (rt.config.slarkExternalGroup !== true) return
  let pending = Promise.resolve()
  const serialize = action => {
    const next = pending.then(action)
    pending = next.catch(() => {})
    return next
  }

  rt.prepareNativeRoomSource = roomId => serialize(async () => {
    if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 256) return null
    await rt.refresh()
    if (!rt.hasExclusiveWriter()) return null
    const room = rt.roomOf(roomId)
    const workspaceId = rt.state.workspaceId
    if (!room || room.id !== roomId || !workspaceId || !rt.ctx.workspaceRegistry.get(workspaceId)
      || rt.roomBusy(roomId)) return null
    let prepared = room.nativeSource
    if (prepared && (prepared.roomId !== roomId || prepared.workspaceId !== workspaceId ||
      typeof prepared.bridgeSessionId !== 'string')) throw Error('native_room_source_mismatch')
    if (!prepared) {
      const bridgeSessionId = await rt.createSession(`Slark Agent · ${room.name}`)
      prepared = { state: 'bridge', roomId, workspaceId, bridgeSessionId }
      room.nativeSource = prepared
      await rt.save()
    }
    const session = rt.ctx.sessions.get(prepared.bridgeSessionId)
    if (!session) throw Error('native_room_bridge_missing')
    if (prepared?.state === 'captured') return prepared.target
    if (prepared.state === 'bridge') {
      const message = createUserMessage({ content: [{ type: 'text', text: CONTROL_TEXT }],
        source: { kind: 'slark-native-room-join' } })
      session.append('user/message', message, { surfaceOp: 'append' })
      await rt.ctx.sessions.flush(session)
      prepared.state = 'pending'
      prepared.text = CONTROL_TEXT
      prepared.target = { workspace_id: workspaceId, session_id: prepared.bridgeSessionId,
        source_message_id: message.id, source_revision: '1' }
      await rt.save()
    }
    if (prepared.state !== 'pending' || prepared.text !== CONTROL_TEXT ||
      prepared.target?.session_id !== prepared.bridgeSessionId) throw Error('native_room_source_mismatch')
    const target = prepared.target
    const captured = await rt.ctx.sessionController.captureCollaborationSource({
      ...target, original_message: CONTROL_TEXT, active_mentions: [],
    }, AbortSignal.timeout(30_000))
    if (captured.snapshot.original_message !== CONTROL_TEXT ||
      captured.snapshot.workspace_id !== workspaceId ||
      captured.snapshot.session_id !== prepared.bridgeSessionId ||
      captured.snapshot.source_message_id !== target.source_message_id) throw Error('native_room_source_mismatch')
    prepared.state = 'captured'
    await rt.save()
    return target
  })
}
