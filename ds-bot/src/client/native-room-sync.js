// The browser selects only locally joined rooms; Host rechecks Account, group and member.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export async function pumpNativeRoomSnapshot(snapshot, host, current = () => true) {
  if (!host?.collaborationNativeRoomPump) return 0
  let attempted = 0
  for (const room of snapshot.rooms ?? []) {
    if (!current()) break
    const target = room.nativeSource?.state === 'captured' ? room.nativeSource.target : null
    if (!target || room.nativeSource.roomId !== room.id ||
      target.workspace_id !== room.nativeSource.workspaceId ||
      !uuid.test(target.workspace_id) || typeof target.session_id !== 'string' ||
      !/^[!-~]{1,256}$/.test(target.session_id)) continue
    for (const member of Object.values(room.nativeMembers ?? {})) {
      if (!current()) break
      if (member.state !== 'active' || member.groupId !== room.nativeGroupId ||
        !uuid.test(member.memberId ?? '') || !Number.isSafeInteger(room.seq) ||
        !Number.isSafeInteger(member.ackSeq) || room.seq <= member.ackSeq) continue
      try { await host.collaborationNativeRoomPump({ workspace_id: target.workspace_id,
        session_id: target.session_id, member_id: member.memberId }) }
      catch { /* A later tick resumes from the durable Host ack cursor. */ }
      attempted += 1
    }
  }
  return attempted
}
