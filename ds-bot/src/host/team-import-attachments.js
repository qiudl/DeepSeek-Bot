// Enumerate durable attachment references in a decoded Session event graph.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/u
const MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const TRANSFER_CHUNK = 32 * 1024
const MAX_TRANSFER_BYTES = 512 * 1024 * 1024
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function attachment(block) {
  const ref = block.attachment
  const allowed = block.type === 'file'
    ? ['attachmentId', 'name', 'bytes']
    : ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name', 'originalDimensions']
  if (!object(ref) || !ATTACHMENT_ID.test(ref.attachmentId ?? '') ||
      !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 ||
      Object.keys(ref).some(key => !allowed.includes(key)) ||
      ref.name !== undefined && (typeof ref.name !== 'string' || ref.name.includes('/') || ref.name.includes('\\') || ref.name.length > 255)) {
    throw new Error('Invalid attachment reference')
  }
  if (block.type === 'file') {
    if (typeof ref.name !== 'string' || ref.name === '') throw new Error('Invalid file attachment')
  } else if (!MEDIA.has(ref.mediaType) || !Number.isSafeInteger(ref.width) || ref.width < 1 ||
      !Number.isSafeInteger(ref.height) || ref.height < 1 ||
      ref.originalDimensions !== undefined && (!object(ref.originalDimensions) ||
        Object.keys(ref.originalDimensions).sort().join(',') !== 'height,width' ||
        !Number.isSafeInteger(ref.originalDimensions.width) || ref.originalDimensions.width < 1 ||
        !Number.isSafeInteger(ref.originalDimensions.height) || ref.originalDimensions.height < 1)) {
    throw new Error('Invalid image attachment')
  }
  return { type: block.type, ref: structuredClone(ref) }
}

/** Unknown attachment-shaped fields fail closed, so a new DSH shape cannot be silently dropped. */
export function inventorySessionAttachments(events) {
  if (!Array.isArray(events) || events.length > 100_000) throw new Error('Invalid attachment source')
  const found = new Map()
  const ancestors = new WeakSet()
  function walk(value, depth) {
    if (depth > 64) throw new Error('Attachment event too deep')
    if (Array.isArray(value)) {
      if (ancestors.has(value)) throw new Error('Cyclic attachment event')
      ancestors.add(value)
      for (const item of value) walk(item, depth + 1)
      ancestors.delete(value)
      return
    }
    if (!object(value)) return
    if (ancestors.has(value)) throw new Error('Cyclic attachment event')
    ancestors.add(value)
    if (Object.hasOwn(value, 'attachmentId')) throw new Error('Unknown attachment reference')
    if (value.type === 'image' || value.type === 'file') {
      const item = attachment(value)
      const key = `${item.type}:${item.ref.attachmentId}:${item.ref.name ?? ''}`
      const previous = found.get(key)
      if (previous !== undefined && !isDeepStrictEqual(previous.ref, item.ref)) {
        throw new Error('Conflicting attachment reference')
      }
      found.set(key, item)
      if (found.size > 5_000) throw new Error('Too many attachments')
      for (const [key, child] of Object.entries(value)) if (key !== 'attachment') walk(child, depth + 1)
      ancestors.delete(value)
      return
    }
    for (const child of Object.values(value)) walk(child, depth + 1)
    ancestors.delete(value)
  }
  walk(events, 0)
  return [...found.values()].sort((left, right) =>
    `${left.type}:${left.ref.attachmentId}:${left.ref.name ?? ''}`.localeCompare(
      `${right.type}:${right.ref.attachmentId}:${right.ref.name ?? ''}`, 'en'))
}

/** Verify source objects through DSH before their bytes are offered for transfer. */
export async function verifySourceAttachments(ctx, items, signal) {
  const store = ctx?.attachments ?? ctx?.get?.('attachments')
  if (!store || typeof store.readImage !== 'function' || typeof store.readFileStream !== 'function' ||
      !Array.isArray(items) || items.length > 5_000) throw new Error('Invalid attachment verifier')
  const verified = []
  for (const item of items) {
    if (!object(item) || !['image', 'file'].includes(item.type)) throw new Error('Invalid attachment manifest')
    const { ref } = attachment({ type: item.type, attachment: item.ref })
    const hash = createHash('sha256')
    let bytes = 0
    if (item.type === 'image') {
      const stored = await store.readImage(ref, signal)
      if (!isDeepStrictEqual(stored?.ref, ref) || !(stored.data instanceof Uint8Array)) {
        throw new Error('Image attachment changed')
      }
      bytes = stored.data.byteLength
      hash.update(stored.data)
    } else {
      for await (const chunk of store.readFileStream(ref, signal)) {
        if (!(chunk instanceof Uint8Array)) throw new Error('Invalid file attachment stream')
        bytes += chunk.byteLength
        if (bytes > ref.bytes) throw new Error('File attachment changed')
        hash.update(chunk)
      }
    }
    if (bytes !== ref.bytes || `sha256:${hash.digest('hex')}` !== ref.attachmentId) {
      throw new Error('Attachment bytes changed')
    }
    verified.push({ type: item.type, attachmentId: ref.attachmentId, bytes })
  }
  return verified
}

/** Stream only a validated DSH attachment reference; consumers commit after EOF. */
export async function* readVerifiedSourceAttachment(ctx, item, signal) {
  const store = ctx?.attachments ?? ctx?.get?.('attachments')
  if (!store || typeof store.readImage !== 'function' ||
      typeof store.readFileStream !== 'function' ||
      !object(item) || !['image', 'file'].includes(item.type)) {
    throw new Error('Invalid source attachment reader')
  }
  const { ref } = attachment({ type: item.type, attachment: item.ref })
  if (ref.bytes > MAX_TRANSFER_BYTES) throw new Error('Source attachment too large')
  const hash = createHash('sha256')
  let bytes = 0
  const stream = item.type === 'image'
    ? (async function* () {
      const stored = await store.readImage(ref, signal)
      if (!isDeepStrictEqual(stored?.ref, ref) || !(stored.data instanceof Uint8Array)) {
        throw new Error('Image attachment changed')
      }
      yield stored.data
    })()
    : store.readFileStream(ref, signal)
  for await (const block of stream) {
    signal?.throwIfAborted()
    if (!(block instanceof Uint8Array) || bytes + block.byteLength > ref.bytes) {
      throw new Error('Source attachment bytes changed')
    }
    for (let offset = 0; offset < block.byteLength; offset += TRANSFER_CHUNK) {
      const chunk = block.subarray(offset, Math.min(offset + TRANSFER_CHUNK, block.byteLength))
      hash.update(chunk)
      bytes += chunk.byteLength
      yield chunk
      signal?.throwIfAborted()
    }
  }
  if (bytes !== ref.bytes || `sha256:${hash.digest('hex')}` !== ref.attachmentId) {
    throw new Error('Source attachment bytes changed')
  }
}

/** Save one verified transfer payload in the target Profile without exposing it to a Bot. */
export async function stageImportedAttachment(ctx, { type, sourceRef, data, signal }) {
  const store = ctx?.attachments ?? ctx?.get?.('attachments')
  if (!store || !['image', 'file'].includes(type) ||
      typeof store.saveImage !== 'function' || typeof store.saveFileStream !== 'function') {
    throw new Error('Invalid target attachment store')
  }
  const { ref } = attachment({ type, attachment: sourceRef })
  let targetRef
  if (type === 'image') {
    if (!(data instanceof Uint8Array) || data.byteLength !== ref.bytes ||
        `sha256:${createHash('sha256').update(data).digest('hex')}` !== ref.attachmentId) {
      throw new Error('Source image bytes changed')
    }
    targetRef = await store.saveImage({ data, mediaType: ref.mediaType, name: ref.name })
  } else {
    if (typeof data?.[Symbol.asyncIterator] !== 'function') throw new Error('Invalid file transfer stream')
    const hash = createHash('sha256')
    let bytes = 0
    async function* checked() {
      for await (const chunk of data) {
        if (!(chunk instanceof Uint8Array)) throw new Error('Invalid file transfer chunk')
        bytes += chunk.byteLength
        if (bytes > ref.bytes) throw new Error('Source file bytes changed')
        hash.update(chunk)
        yield chunk
      }
    }
    targetRef = await store.saveFileStream({ data: checked(), name: ref.name, signal })
    if (bytes !== ref.bytes || `sha256:${hash.digest('hex')}` !== ref.attachmentId ||
        targetRef?.attachmentId !== ref.attachmentId) throw new Error('Source file bytes changed')
  }
  attachment({ type, attachment: targetRef })
  return { type, sourceRef: ref, targetRef: structuredClone(targetRef) }
}

/** Replace only validated attachment references after every referenced object is staged. */
export function remapSessionAttachments(events, mappings = []) {
  const needed = inventorySessionAttachments(events)
  if (!Array.isArray(mappings)) throw new Error('Invalid attachment mapping')
  const byKey = new Map()
  const keyOf = item => `${item.type}:${item.ref.attachmentId}:${item.ref.name ?? ''}`
  for (const entry of mappings) {
    if (!object(entry) || !['image', 'file'].includes(entry.type)) throw new Error('Invalid attachment mapping')
    const source = attachment({ type: entry.type, attachment: entry.sourceRef })
    const target = attachment({ type: entry.type, attachment: entry.targetRef })
    const key = keyOf(source)
    if (byKey.has(key) && !isDeepStrictEqual(byKey.get(key), { source: source.ref, target: target.ref })) {
      throw new Error('Conflicting attachment mapping')
    }
    byKey.set(key, { source: source.ref, target: target.ref })
  }
  for (const item of needed) {
    const mapped = byKey.get(keyOf(item))
    if (!mapped || !isDeepStrictEqual(mapped.source, item.ref)) throw new Error('Unstaged attachment')
  }
  const copy = structuredClone(events)
  function replace(value) {
    if (Array.isArray(value)) { for (const item of value) replace(item); return }
    if (!object(value)) return
    if (value.type === 'image' || value.type === 'file') {
      const item = attachment(value)
      value.attachment = structuredClone(byKey.get(keyOf(item)).target)
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'attachment') replace(child)
  }
  replace(copy)
  return copy
}
