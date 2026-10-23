// Read-only manifest of durable memory files; snapshots and review cursors are derived state.
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const TOPIC = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}\.md$/u
const MAX_FILE_BYTES = 1_000_000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

async function entries(path) {
  try {
    const info = await lstat(path)
    if (!info.isDirectory()) throw new Error('Memory directory is not a regular directory')
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function mapped(plan, id) {
  const target = plan.sessions[id]
  if (!SESSION_ID.test(id) || typeof target !== 'string' || !SESSION_ID.test(target)) {
    throw new Error('Invalid memory Session mapping')
  }
  return target
}

/** Hashes source facts without exposing or writing their contents. */
export async function inventoryTeamMemory(root, source, plan) {
  if (!isAbsolute(root) || source?.version !== 1 || !object(source.bots) ||
      !object(source.rooms) || !object(plan?.sessions)) throw new Error('Invalid memory import plan')
  await entries(root)
  const files = []
  const scopes = [
    { type: 'team', id: null, targetId: null },
    ...Object.keys(source.bots).map(id => ({ type: 'bots', id, targetId: mapped(plan, id) })),
    ...Object.keys(source.rooms).map(id => ({ type: 'groups', id, targetId: mapped(plan, id) })),
  ]
  const targetIds = scopes.filter(scope => scope.targetId !== null).map(scope => scope.targetId)
  if (new Set(targetIds).size !== targetIds.length) throw new Error('Duplicate target memory scope')
  for (const type of ['bots', 'groups']) {
    const known = new Set(scopes.filter(scope => scope.type === type).map(scope => scope.id))
    for (const entry of await entries(join(root, type))) {
      if (!entry.isDirectory() || !known.has(entry.name)) throw new Error('Orphan memory scope')
    }
  }
  for (const { type, id, targetId } of scopes) {
    const base = type === 'team' ? 'team' : join(type, id)
    const targetBase = type === 'team' ? 'team' : join(type, targetId)
    for (const entry of await entries(join(root, base))) {
      if (entry.isSymbolicLink()) throw new Error('Memory symbolic link is not portable')
      if (!entry.isFile() || (entry.name !== 'MEMORY.md' &&
          (!TOPIC.test(entry.name) || entry.name.toLowerCase() !== entry.name))) {
        throw new Error('Unknown memory file')
      }
      const path = join(root, base, entry.name)
      const info = await lstat(path)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Invalid memory file')
      const body = await readFile(path)
      if (body.length > MAX_FILE_BYTES) throw new Error('Memory file changed while reading')
      files.push({ source: join(base, entry.name), target: join(targetBase, entry.name),
        bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') })
    }
  }
  return files.sort((left, right) => left.source.localeCompare(right.source, 'en'))
}
