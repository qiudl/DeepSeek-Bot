// Read-only inventory of group history that a selective import must preserve.
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { createGroupHistory } from './group-history.js'

const MAX_ROOMS = 10_000
const MAX_JOURNAL_BYTES = 512 * 1024 * 1024
const failed = () => { throw new Error('Source group history incomplete') }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = value => createHash('sha256').update(value).digest('hex')

function completeCache(room) {
  const log = room.log ?? []
  if (!Array.isArray(log) || !Number.isSafeInteger(room.seq) || room.seq < 0 ||
      room.seq !== log.length || log.some((line, index) => !object(line) ||
        line.seq !== index + 1 || line.length !== undefined)) failed()
  return { seq: room.seq, digest: digest(JSON.stringify(log)),
    totalBytes: Buffer.byteLength(JSON.stringify(log), 'utf8') }
}

/** A complete source is evidence for planning, not proof of a staged target journal. */
export function inventorySourceGroupHistories(sourceHome, source) {
  if (!isAbsolute(sourceHome ?? '') || !object(source?.rooms) ||
      Object.keys(source.rooms).length > MAX_ROOMS) failed()
  const history = createGroupHistory(sourceHome, () => false)
  return Object.entries(source.rooms).sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([sourceRoomId, room]) => {
      if (!object(room) || room.id !== sourceRoomId) failed()
      if (room.historyJournal === undefined) {
        return { sourceRoomId, source: 'complete-cache', ...completeCache(room) }
      }
      try {
        const page = history.readChunk(room, 0, 1)
        if (page.complete !== true || page.seq !== room.seq ||
            page.digest !== room.historyJournal.digest ||
            !Number.isSafeInteger(page.totalBytes) || page.totalBytes < 1 ||
            page.totalBytes > MAX_JOURNAL_BYTES || page.content.length !== 1) failed()
        return { sourceRoomId, source: 'committed-journal', seq: page.seq,
          digest: page.digest, totalBytes: page.totalBytes }
      } catch { return failed() }
    })
}
