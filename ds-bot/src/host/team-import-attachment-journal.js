// Private reservation for a source attachment's target reference; no payload bytes are stored.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { inventorySessionAttachments, stageImportedAttachment, verifySourceAttachments } from './team-import-attachments.js'

const DIGEST = /^[0-9a-f]{64}$/u

function item(type, ref) {
  if (!['image', 'file'].includes(type)) throw new Error('Invalid import attachment type')
  return inventorySessionAttachments([{ type: 'user/message', data: { content: [{ type, attachment: ref }] } }])[0]
}

function key(type, ref) {
  const valid = item(type, ref)
  return createHash('sha256').update(JSON.stringify([valid.type, valid.ref.attachmentId, valid.ref.name ?? null])).digest('hex')
}

async function writeSynced(path, record) {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
    await file.sync()
  } finally { await file.close() }
}

export function createTeamImportAttachmentJournal(root) {
  const pathFor = (type, ref) => join(root, `${key(type, ref)}.json`)
  const read = async (type, sourceRef) => JSON.parse(await readFile(pathFor(type, sourceRef), 'utf8'))
  async function change(type, sourceRef, status, targetRef) {
    const path = pathFor(type, sourceRef)
    const record = await read(type, sourceRef)
    if (record.version !== 1 || record.status !== 'pending' || record.type !== type ||
        !isDeepStrictEqual(record.sourceRef, item(type, sourceRef).ref)) {
      throw new Error('Import attachment reservation is not pending')
    }
    const next = { ...record, status, ...(targetRef === undefined ? {} : { targetRef: item(type, targetRef).ref }) }
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeSynced(temp, next)
      await rename(temp, path)
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  return {
    read,
    async reserve({ type, sourceRef, sourceDigest, targetDigest }) {
      const path = pathFor(type, sourceRef)
      if (!DIGEST.test(sourceDigest ?? '') || !DIGEST.test(targetDigest ?? '')) {
        throw new Error('Invalid import attachment plan digest')
      }
      await mkdir(root, { recursive: true, mode: 0o700 })
      try {
        await writeSynced(path, { version: 1, status: 'pending', type,
          sourceRef: item(type, sourceRef).ref, sourceDigest, targetDigest })
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Import attachment already reserved')
        throw error
      }
    },
    complete: (type, sourceRef, targetRef) => change(type, sourceRef, 'staged', targetRef),
    fail: (type, sourceRef) => change(type, sourceRef, 'needs-review'),
  }
}

/** A failed or interrupted reservation remains blocked until a recovery audit inspects it. */
export async function stageImportedAttachmentWithJournal(ctx, options, plan, journal) {
  if (!journal || !['reserve', 'complete', 'fail'].every(method => typeof journal[method] === 'function') ||
      !DIGEST.test(plan?.sourceDigest ?? '') || !DIGEST.test(plan?.targetDigest ?? '')) {
    throw new Error('Incomplete attachment stage journal')
  }
  const { type, sourceRef } = options
  await journal.reserve({ type, sourceRef, sourceDigest: plan.sourceDigest, targetDigest: plan.targetDigest })
  try {
    const staged = await stageImportedAttachment(ctx, options)
    await journal.complete(type, sourceRef, staged.targetRef)
    return staged
  } catch (error) {
    await journal.fail(type, sourceRef).catch(() => {})
    throw error
  }
}

/** Rebuild the mapping only from staged records bound to this import plan. */
export async function readStagedAttachmentMappings(journal, items, plan) {
  if (typeof journal?.read !== 'function' || !Array.isArray(items) || items.length > 5_000 ||
      !DIGEST.test(plan?.sourceDigest ?? '') || !DIGEST.test(plan?.targetDigest ?? '')) {
    throw new Error('Incomplete attachment mapping read')
  }
  const mappings = []
  for (const source of items) {
    const { type, ref } = item(source?.type, source?.ref)
    const record = await journal.read(type, ref)
    if (record?.version !== 1 || record.status !== 'staged' || record.type !== type ||
        record.sourceDigest !== plan.sourceDigest || record.targetDigest !== plan.targetDigest ||
        !isDeepStrictEqual(record.sourceRef, ref)) throw new Error('Import attachment stage incomplete')
    const targetRef = item(type, record.targetRef).ref
    mappings.push({ type, sourceRef: ref, targetRef })
  }
  return mappings
}

/** A durable mapping is ready only while every target object still verifies. */
export async function verifyStagedAttachmentMappings(ctx, journal, items, plan, signal) {
  const mappings = await readStagedAttachmentMappings(journal, items, plan)
  await verifySourceAttachments(ctx, mappings.map(entry => ({ type: entry.type, ref: entry.targetRef })), signal)
  return mappings
}
