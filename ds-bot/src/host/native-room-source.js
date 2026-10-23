// Keep Slark's fenced Source Session separate from the writable native room Session.
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import { nameProblem } from '../shared/mentions.js'

const CONTROL_TEXT = '[Slark Agent group membership requested]'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const coordinate = value => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') >= 1 && Buffer.byteLength(value, 'utf8') <= 256 &&
  !/[\x00-\x1f\x7f]/u.test(value)
const textFitsHostFrame = text => Buffer.byteLength(JSON.stringify(text), 'utf8') <= 16_000
const botLineId = (roomId, seq) => {
  const bytes = createHash('sha256').update(`ds-bot-native-line/v1\0${roomId}\0${seq}`).digest()
  bytes[6] = bytes[6] & 0x0f | 0x50
  bytes[8] = bytes[8] & 0x3f | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
const turnId = (roomId, key) => {
  const bytes = createHash('sha256').update(`ds-bot-native-turn/v1\0${roomId}\0${key}`).digest()
  bytes[6] = bytes[6] & 0x0f | 0x50
  bytes[8] = bytes[8] & 0x3f | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// A queued turn is identified by the triggering room line and the exact member
// cycle. Replaying a group relay cannot create a second request for that line.
export function queueNativeRoomTurn(room, participant) {
  const member = room.nativeMembers?.[participant.memberId]
  const line = room.log?.at(-1)
  if (!room.nativeTurnBridge || !member || member.state !== 'active' ||
    member.groupId !== room.nativeGroupId || member.cycle !== participant.cycle ||
    !line || !Number.isSafeInteger(line.seq) ||
    line.seq <= (member.nativeTurnAckSeq ?? member.joinedRoomSeq) ||
    line.length !== undefined || typeof line.text !== 'string' ||
    !textFitsHostFrame(line.text) ||
    !(line.sourceKind === 'user' && typeof line.sourceMessageId === 'string' &&
      line.sourceMessageId.length > 0 ||
      typeof line.botId === 'string' && line.botId.length > 0 && line.kind === undefined)) return null
  const key = `${line.seq}:${member.memberId}:${member.cycle}`
  room.nativeTurnOutbox ??= []
  const existing = room.nativeTurnOutbox.find(turn => turn.key === key)
  if (existing) return existing
  if (room.nativeTurnOutbox.length >= 1000) return null
  const order = (room.nativeTurnSeq ?? 0) + 1
  if (!Number.isSafeInteger(order)) return null
  room.nativeTurnSeq = order
  const turn = { key, turnId: turnId(room.id, key), groupId: member.groupId, memberId: member.memberId,
    cycle: member.cycle, triggerRoomSeq: line.seq, order, state: 'pending' }
  room.nativeTurnOutbox.push(turn)
  return turn
}

// The outbox lives in the same state.json write as the room log. Keep every room
// sequence, including lines that are not user instructions, so a cursor cannot
// silently skip a missing message when the visible 60-line log rolls over.
export function recordNativeRoomLine(room, line) {
  if (!Object.values(room.nativeMembers ?? {}).some(member => member.state === 'active')) return
  room.nativeOutbox ??= []
  const text = typeof line.text === 'string' ? line.text : ''
  room.nativeOutbox.push({ seq: line.seq,
    ...(line.sourceKind ? { sourceKind: line.sourceKind } : {}),
    ...(line.sourceMessageId ? { sourceMessageId: line.sourceMessageId } : {}),
    ...(line.botId ? { botId: line.botId } : {}),
    ...(line.kind ? { kind: line.kind } : {}),
    ...(textFitsHostFrame(text) ? { text } :
      { text: '', length: Buffer.byteLength(text, 'utf8') }),
  })
}

export function install(rt) {
  if (rt.config.slarkExternalGroup !== true) return
  let pending = Promise.resolve()
  const serialize = action => {
    const next = pending.then(action)
    pending = next.catch(() => {})
    return next
  }
  const compact = room => {
    const active = Object.values(room.nativeMembers ?? {}).filter(member => member.state === 'active')
    const through = active.length === 0 ? room.seq : Math.min(...active.map(member => member.ackSeq))
    room.nativeOutbox = (room.nativeOutbox ?? []).filter(line => line.seq > through)
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
  rt.ctx.provide('dsBotSlarkNativeRoom', {
    async prepare({ roomId } = {}) {
      const source = await rt.prepareNativeRoomSource(roomId)
      return source ? { room_id: roomId, source } : null
    },
    async joinAgent({ roomId, groupId, memberId, cycle, projectId, agentId, name } = {}) {
      return serialize(async () => {
        if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 256 ||
          !UUID.test(groupId ?? '') || !UUID.test(memberId ?? '') ||
          !Number.isSafeInteger(cycle) || cycle < 1 || !coordinate(projectId) ||
          !coordinate(agentId) || !coordinate(name) || nameProblem(name) !== undefined)
          return { state: 'invalid' }
        await rt.refresh()
        if (!rt.hasExclusiveWriter()) return { state: 'unavailable' }
        const room = rt.roomOf(roomId)
        if (!room || room.nativeSource?.state !== 'captured' ||
          room.nativeSource.roomId !== roomId ||
          room.nativeSource.workspaceId !== rt.state.workspaceId || rt.roomBusy(roomId))
          return { state: 'unavailable' }
        if (room.nativeGroupId && room.nativeGroupId !== groupId) return { state: 'conflict' }
        const existing = room.nativeMembers?.[memberId]
        if (existing) return existing.groupId === groupId && existing.cycle === cycle &&
          existing.projectId === projectId && existing.agentId === agentId &&
          existing.name === name && existing.state === 'active'
          ? { state: 'joined', joined_room_seq: existing.joinedRoomSeq } : { state: 'conflict' }
        if (Object.values(room.nativeMembers ?? {}).some(member => member.state === 'active' &&
          member.projectId === projectId && member.agentId === agentId)) return { state: 'conflict' }
        if (!Number.isSafeInteger(room.seq)) {
          room.log = (room.log ?? []).map((line, index) => ({ ...line, seq: index + 1 }))
          room.seq = room.log.length
          room.seen ??= {}
        }
        const priorGroupId = room.nativeGroupId
        const priorMembers = room.nativeMembers
        room.nativeGroupId = groupId
        room.nativeMembers = { ...(priorMembers ?? {}) }
        room.nativeOutbox ??= []
        room.nativeMembers[memberId] = { groupId, memberId, cycle, projectId, agentId, name,
          state: 'active', joinedRoomSeq: room.seq, readThrough: room.seq, ackSeq: room.seq,
          nativeTurnAckSeq: room.seq }
        compact(room)
        try { await rt.save() } catch (error) {
          if (priorGroupId === undefined) delete room.nativeGroupId
          else room.nativeGroupId = priorGroupId
          if (priorMembers === undefined) delete room.nativeMembers
          else room.nativeMembers = priorMembers
          throw error
        }
        return { state: 'joined', joined_room_seq: room.seq }
      })
    },
    async roomMessages({ roomId, memberId, cycle, afterSeq = 0, limit = 3 } = {}) {
      return serialize(async () => {
        if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 256 ||
          !UUID.test(memberId ?? '') || !Number.isSafeInteger(cycle) || cycle < 1 ||
          !Number.isSafeInteger(afterSeq) || afterSeq < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 3) return { state: 'invalid' }
        await rt.refresh()
        if (!rt.hasExclusiveWriter()) return { state: 'unavailable' }
        const room = rt.roomOf(roomId)
        const member = room?.nativeMembers?.[memberId]
        if (!room || !member || member.state !== 'active' || member.cycle !== cycle ||
          room.nativeSource?.state !== 'captured' || room.nativeGroupId !== member.groupId)
          return { state: 'unavailable' }
        // Zero is a private recovery cursor: resume at the durable ack after a
        // Daemon restart, never at the room's pre-join history.
        const cursor = afterSeq === 0 ? member.ackSeq : afterSeq
        if (cursor < member.joinedRoomSeq) return { state: 'history_forbidden' }
        if (cursor < member.ackSeq)
          return { state: 'already_acknowledged', through_seq: member.ackSeq }
        const lastSeq = room.seq
        const log = room.nativeOutbox
        if (!Number.isSafeInteger(lastSeq) || lastSeq < 0 || cursor > lastSeq ||
          !Array.isArray(log) || (cursor < lastSeq && log.at(-1)?.seq !== lastSeq))
          return { state: 'unavailable' }
        if (cursor < lastSeq && (log.length === 0 || log[0]?.seq > cursor + 1))
          return { state: 'history_gap' }
        const lines = log.filter(line => line.seq > cursor).slice(0, limit)
        const messages = []
        let nextSeq = cursor
        for (const line of lines) {
          if (line.seq !== nextSeq + 1) return { state: 'history_gap' }
          nextSeq = line.seq
          if (line.sourceKind === 'user') {
            if (line.botId !== undefined || typeof line.sourceMessageId !== 'string' ||
              line.sourceMessageId.length === 0 || line.sourceMessageId.length > 256 ||
              typeof line.text !== 'string' || line.text.length === 0 ||
              !textFitsHostFrame(line.text) || line.length !== undefined)
              return { state: 'unverifiable_message', seq: line.seq }
            messages.push({ seq: line.seq, source_kind: 'user',
              message_id: line.sourceMessageId, text: line.text })
          } else if (line.botId !== undefined && line.kind === undefined) {
            if (typeof line.botId !== 'string' || line.botId.length === 0 ||
              typeof line.text !== 'string' || line.text.length === 0 ||
              !textFitsHostFrame(line.text) || line.length !== undefined)
              return { state: 'unverifiable_message', seq: line.seq }
            messages.push({ seq: line.seq, source_kind: 'bot',
              message_id: botLineId(roomId, line.seq), bot_id: line.botId, text: line.text })
          }
        }
        if (nextSeq > member.readThrough) {
          const priorReadThrough = member.readThrough
          member.readThrough = nextSeq
          try { await rt.save() } catch (error) { member.readThrough = priorReadThrough; throw error }
        }
        return { state: 'ok', room_id: roomId, next_seq: nextSeq, last_seq: lastSeq, messages }
      })
    },
    async roomTurns({ roomId, memberId, cycle, afterSeq = 0, limit = 3 } = {}) {
      return serialize(async () => {
        if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 256 ||
          !UUID.test(memberId ?? '') || !Number.isSafeInteger(cycle) || cycle < 1 ||
          !Number.isSafeInteger(afterSeq) || afterSeq < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 3) return { state: 'invalid' }
        await rt.refresh()
        if (!rt.hasExclusiveWriter()) return { state: 'unavailable' }
        const room = rt.roomOf(roomId)
        const member = room?.nativeMembers?.[memberId]
        if (!room || !room.nativeTurnBridge || !member || member.state !== 'active' ||
          member.cycle !== cycle || member.groupId !== room.nativeGroupId ||
          !Number.isSafeInteger(room.seq) || afterSeq > room.seq ||
          afterSeq !== 0 && afterSeq < member.joinedRoomSeq) return { state: 'unavailable' }
        const cursor = afterSeq === 0 ? (member.nativeTurnAckSeq ?? member.joinedRoomSeq) : afterSeq
        const turns = (room.nativeTurnOutbox ?? []).filter(turn => turn.memberId === memberId &&
          turn.cycle === cycle && turn.groupId === member.groupId &&
          turn.triggerRoomSeq > cursor && turn.state === 'pending').slice(0, limit)
        return { state: 'turns', room_id: roomId, group_id: member.groupId,
          member_id: memberId, cycle,
          next_seq: turns.at(-1)?.triggerRoomSeq ?? cursor,
          turns: turns.map(turn => ({ turn_id: turn.turnId,
            trigger_room_seq: turn.triggerRoomSeq, turn_order: turn.order })) }
      })
    },
    async acknowledgeTurns({ roomId, memberId, cycle, turnIds } = {}) {
      return serialize(async () => {
        if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 256 ||
          !UUID.test(memberId ?? '') || !Number.isSafeInteger(cycle) || cycle < 1 ||
          !Array.isArray(turnIds) || turnIds.length < 1 || turnIds.length > 3 ||
          turnIds.some(id => typeof id !== 'string' || !UUID.test(id)) ||
          new Set(turnIds).size !== turnIds.length) return { state: 'invalid' }
        await rt.refresh()
        if (!rt.hasExclusiveWriter()) return { state: 'unavailable' }
        const room = rt.roomOf(roomId)
        const member = room?.nativeMembers?.[memberId]
        if (!room || !member || member.state !== 'active' || member.cycle !== cycle ||
          member.groupId !== room.nativeGroupId || room.nativeTurnBridge !== true)
          return { state: 'unavailable' }
        const selected = (room.nativeTurnOutbox ?? []).filter(turn => turn.memberId === memberId &&
          turn.cycle === cycle && turn.groupId === member.groupId && turn.state === 'pending')
          .slice(0, turnIds.length)
        if (selected.length !== turnIds.length ||
          selected.some((turn, index) => turn.turnId !== turnIds[index]))
          return { state: 'conflict' }
        const prior = room.nativeTurnOutbox
        const priorMember = member
        const selectedIds = new Set(turnIds)
        room.nativeTurnOutbox = prior.filter(turn => !selectedIds.has(turn.turnId))
        room.nativeMembers = { ...room.nativeMembers, [memberId]: { ...member,
          nativeTurnAckSeq: selected.at(-1).triggerRoomSeq } }
        try { await rt.save() } catch (error) {
          room.nativeTurnOutbox = prior
          room.nativeMembers = { ...room.nativeMembers, [memberId]: priorMember }
          throw error
        }
        return { state: 'turns_acknowledged', turn_ids: turnIds }
      })
    },
    async acknowledgeMessages({ roomId, memberId, cycle, throughSeq } = {}) {
      return serialize(async () => {
        if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 256 ||
          !UUID.test(memberId ?? '') || !Number.isSafeInteger(cycle) || cycle < 1 ||
          !Number.isSafeInteger(throughSeq) || throughSeq < 0) return { state: 'invalid' }
        await rt.refresh()
        if (!rt.hasExclusiveWriter()) return { state: 'unavailable' }
        const room = rt.roomOf(roomId)
        const member = room?.nativeMembers?.[memberId]
        if (!member || member.cycle !== cycle || member.state !== 'active') return { state: 'unavailable' }
        if (throughSeq > member.readThrough)
          return { state: 'conflict' }
        if (throughSeq <= member.ackSeq)
          return { state: 'acknowledged', through_seq: member.ackSeq }
        if (throughSeq > member.ackSeq) {
          const priorOutbox = room.nativeOutbox
          const priorAck = member.ackSeq
          member.ackSeq = throughSeq
          compact(room)
          try { await rt.save() } catch (error) {
            member.ackSeq = priorAck
            room.nativeOutbox = [...priorOutbox, ...room.nativeOutbox.filter(line =>
              line.seq > (priorOutbox.at(-1)?.seq ?? 0))]
            throw error
          }
        }
        return { state: 'acknowledged', through_seq: throughSeq }
      })
    },
    async leaveAgent({ roomId, memberId, cycle } = {}) {
      return serialize(async () => {
        if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 256 ||
          !UUID.test(memberId ?? '') || !Number.isSafeInteger(cycle) || cycle < 1)
          return { state: 'invalid' }
        await rt.refresh()
        if (!rt.hasExclusiveWriter()) return { state: 'unavailable' }
        const room = rt.roomOf(roomId)
        const member = room?.nativeMembers?.[memberId]
        if (!member || member.cycle !== cycle) return { state: 'unavailable' }
        if (member.state === 'left') return { state: 'left', left_room_seq: member.leftRoomSeq }
        if (member.state !== 'active') return { state: 'conflict' }
        const priorOutbox = room.nativeOutbox
        room.nativeMembers = { ...room.nativeMembers,
          [memberId]: { ...member, state: 'left', leftRoomSeq: room.seq } }
        compact(room)
        try { await rt.save() } catch (error) {
          room.nativeMembers = { ...room.nativeMembers, [memberId]: member }
          room.nativeOutbox = [...priorOutbox, ...room.nativeOutbox.filter(line =>
            line.seq > (priorOutbox.at(-1)?.seq ?? 0))]
          throw error
        }
        return { state: 'left', left_room_seq: room.seq }
      })
    },
  })
}
