// Private, fail-closed record of staged Sessions; it never stores chat contents.
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const DIGEST = /^[0-9a-f]{64}$/u

function validId(id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error('Invalid import Session ID')
  return id
}

async function writeSynced(path, record, exclusive = false) {
  const file = await open(path, exclusive ? 'wx' : 'w', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
    await file.sync()
  } finally { await file.close() }
}

export function createTeamImportJournal(root) {
  const pathFor = id => join(root, `${validId(id)}.json`)
  const read = async id => JSON.parse(await readFile(pathFor(id), 'utf8'))
  async function change(id, status) {
    const path = pathFor(id)
    const record = await read(id)
    if (record.version !== 1 || record.targetId !== id || record.status !== 'pending') {
      throw new Error('Import reservation is not pending')
    }
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeSynced(temp, { ...record, status }, true)
      await rename(temp, path)
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  return {
    read,
    async reserve(record) {
      validId(record?.sourceId)
      const path = pathFor(record?.targetId)
      if (!['eventDigest', 'sourceDigest', 'targetDigest'].every(key => DIGEST.test(record[key] ?? ''))) {
        throw new Error('Invalid import digest')
      }
      await mkdir(root, { recursive: true, mode: 0o700 })
      try {
        await writeSynced(path, { version: 1, status: 'pending',
          sourceId: record.sourceId, targetId: record.targetId,
          eventDigest: record.eventDigest, sourceDigest: record.sourceDigest, targetDigest: record.targetDigest }, true)
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Import Session already reserved')
        throw error
      }
    },
    complete: id => change(id, 'staged'),
    fail: id => change(id, 'needs-review'),
  }
}
