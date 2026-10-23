// Stage memory bytes privately; no live Bot or group scope changes here.
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { inventoryTeamMemory } from './team-import-memory.js'
import { teamStateDigest } from './team-import-plan.js'

const MAX_TOTAL_BYTES = 64_000_000
const DIGEST = /^[0-9a-f]{64}$/u

async function writeSynced(path, bytes) {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally { await file.close() }
}

function nested(parent, child) {
  const offset = relative(parent, child)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(offset))
}

/** An existing stage, including pending or failed work, requires explicit recovery. */
export async function stageTeamMemory({ sourceRoot, targetRoot, stageRoot, source, plan, manifest }) {
  if (!isAbsolute(sourceRoot) || !isAbsolute(targetRoot) || !isAbsolute(stageRoot) || !Array.isArray(manifest) ||
      !DIGEST.test(plan?.sourceDigest ?? '') || !DIGEST.test(plan?.targetDigest ?? '')) {
    throw new Error('Invalid memory staging location')
  }
  const parent = dirname(stageRoot)
  if (!(await lstat(parent)).isDirectory()) throw new Error('Memory stage parent must be a private directory')
  const actualSource = await realpath(sourceRoot)
  const actualTarget = await realpath(targetRoot)
  const actualStage = join(await realpath(parent), basename(stageRoot))
  if (nested(actualSource, actualStage) || nested(actualStage, actualSource) ||
      nested(actualTarget, actualStage) || nested(actualStage, actualTarget)) {
    throw new Error('Invalid memory staging location')
  }
  if (teamStateDigest(source) !== plan.sourceDigest) throw new Error('Source team changed')
  const current = await inventoryTeamMemory(sourceRoot, source, plan)
  if (!isDeepStrictEqual(current, manifest)) throw new Error('Source memory changed')
  if (current.reduce((sum, file) => sum + file.bytes, 0) > MAX_TOTAL_BYTES) throw new Error('Memory stage too large')
  try { await mkdir(stageRoot, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Memory stage already exists')
    throw error
  }
  const marker = join(stageRoot, 'manifest.json')
  const record = { version: 1, sourceDigest: plan.sourceDigest, targetDigest: plan.targetDigest, files: current }
  await writeSynced(marker, Buffer.from(`${JSON.stringify({ ...record, status: 'pending' })}\n`))
  for (const file of current) {
    const body = await readFile(join(sourceRoot, file.source))
    if (body.length !== file.bytes || createHash('sha256').update(body).digest('hex') !== file.sha256) {
      throw new Error('Source memory changed during staging')
    }
    const target = join(stageRoot, 'files', file.target)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeSynced(target, body)
  }
  const temp = `${marker}.tmp`
  try {
    await writeSynced(temp, Buffer.from(`${JSON.stringify({ ...record, status: 'staged' })}\n`))
    await rename(temp, marker)
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  return { files: current.length }
}
