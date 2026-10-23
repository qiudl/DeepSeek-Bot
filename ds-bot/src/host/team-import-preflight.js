// Check a staged team's evidence before a separate, transactional activation.
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { inventoryTeamMemory } from './team-import-memory.js'
import { stageTeamImport } from './team-import-stage.js'

const digest = body => createHash('sha256').update(body).digest('hex')

function activeSessions(source) {
  const active = new Set()
  for (const bot of Object.values(source.bots)) active.add(bot.sessionId ?? bot.id)
  for (const room of Object.values(source.rooms)) {
    for (const id of Object.values(room.sessions ?? {})) active.add(id)
  }
  return active
}

/** This checks evidence only. The caller must still freeze writes and commit atomically. */
export async function verifyTeamImportStage({ source, target, plan, candidate, models = {},
  sourceMemoryRoot, memoryStageRoot, journal, verifySession }) {
  if (!isAbsolute(sourceMemoryRoot ?? '') || !isAbsolute(memoryStageRoot ?? '') ||
      typeof journal?.read !== 'function' || typeof verifySession !== 'function') {
    throw new Error('Incomplete import preflight')
  }
  const expected = stageTeamImport(source, target, plan, { models })
  if (!isDeepStrictEqual(candidate, expected)) throw new Error('Team candidate changed')
  const active = activeSessions(source)
  for (const [sourceId, targetId] of Object.entries(plan.sessions)) {
    const record = await journal.read(targetId)
    const mode = active.has(sourceId) ? 'active' : 'history'
    if (record?.version !== 1 || record.status !== 'staged' ||
        record.sourceId !== sourceId || record.targetId !== targetId || record.mode !== mode ||
        record.sourceDigest !== plan.sourceDigest || record.targetDigest !== plan.targetDigest ||
        !/^[0-9a-f]{64}$/u.test(record.eventDigest)) {
      throw new Error('Import Session stage incomplete')
    }
    if (await verifySession({ sourceId, targetId, mode, eventDigest: record.eventDigest }) !== true) {
      throw new Error('Import Session verification failed')
    }
  }
  const expectedFiles = await inventoryTeamMemory(sourceMemoryRoot, source, plan)
  const markerPath = join(memoryStageRoot, 'manifest.json')
  if (!(await lstat(markerPath)).isFile()) throw new Error('Invalid memory stage marker')
  const marker = JSON.parse(await readFile(markerPath, 'utf8'))
  if (marker?.version !== 1 || marker.status !== 'staged' ||
      marker.sourceDigest !== plan.sourceDigest || marker.targetDigest !== plan.targetDigest ||
      !isDeepStrictEqual(marker.files, expectedFiles)) throw new Error('Memory stage incomplete')
  for (const file of expectedFiles) {
    const path = join(memoryStageRoot, 'files', file.target)
    if (!(await lstat(path)).isFile()) throw new Error('Invalid staged memory file')
    const body = await readFile(path)
    if (body.length !== file.bytes || digest(body) !== file.sha256) throw new Error('Staged memory changed')
  }
  return { sessions: Object.keys(plan.sessions).length, memoryFiles: expectedFiles.length }
}
