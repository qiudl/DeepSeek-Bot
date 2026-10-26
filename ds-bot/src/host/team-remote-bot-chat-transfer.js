// A Profile-local, bounded sequential stream; no Session or storage path is accepted from a caller.
import { randomUUID } from 'node:crypto'
import { readVisibleBotChatAttachment } from './team-remote-bot-chat-attachments.js'

const SCHEMA = 'dsh-remote-bot-attachment/v1'
const BOT = /^bot:[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_ACTIVE = 2
const IDLE_MS = 60_000
const SCOPE_KEYS = ['logical_id', 'part', 'team_revision', 'event_digest',
  'manifest_digest', 'eventSeq', 'blockIndex']
const row = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const error = (code, message) => Object.assign(new Error(message), { code })
const invalid = () => { throw error('bot/invalid', 'Invalid Bot attachment transfer') }
const stale = () => { throw error('bot/stale', 'Bot attachment transfer source changed') }

export function parseRemoteBotChatAttachmentTransferRequest(value) {
  if (!row(value) || value.schema_version !== SCHEMA) invalid()
  const keys = ['schema_version', 'kind', ...SCOPE_KEYS,
    ...(value.kind === 'next' || value.kind === 'close' ? ['transfer_id'] : []),
    ...(value.kind === 'next' ? ['offset'] : [])]
  if (!['open', 'next', 'close'].includes(value.kind) || !exact(value, keys) ||
      typeof value.logical_id !== 'string' || !BOT.test(value.logical_id) ||
        !Number.isSafeInteger(value.part) || value.part < 0 || value.part >= 10_000 ||
        !Number.isSafeInteger(value.team_revision) || value.team_revision < 0 ||
        typeof value.event_digest !== 'string' || !DIGEST.test(value.event_digest) ||
        typeof value.manifest_digest !== 'string' || !DIGEST.test(value.manifest_digest) ||
        !Number.isSafeInteger(value.eventSeq) || value.eventSeq < 0 ||
        !Number.isSafeInteger(value.blockIndex) || value.blockIndex < 0 ||
      (value.kind === 'next' || value.kind === 'close') &&
      (typeof value.transfer_id !== 'string' || !UUID.test(value.transfer_id)) ||
      value.kind === 'next' && (!Number.isSafeInteger(value.offset) || value.offset < 0)) invalid()
  return value
}

const sameScope = (left, right) => SCOPE_KEYS.every(key => left[key] === right[key])

/** Hold at most two native attachment iterators; EOF is the only successful completion. */
export function createRemoteBotChatAttachmentTransfers({ select, current, confirm, ctx,
  now = Date.now, stream = readVisibleBotChatAttachment }) {
  const active = new Map()
  const close = async id => {
    const entry = active.get(id)
    if (!entry) return false
    active.delete(id)
    clearTimeout(entry.timer)
    entry.controller.abort()
    try { await entry.iterator.return?.() } catch { /* original failure remains authoritative */ }
    return true
  }
  const arm = entry => {
    clearTimeout(entry.timer)
    entry.expiresAt = now() + IDLE_MS
    entry.timer = setTimeout(() => { if (active.get(entry.id) === entry) void close(entry.id) }, IDLE_MS)
    entry.timer.unref?.()
  }
  return {
    activeCount: () => active.size,
    closeAll: async () => { await Promise.all([...active.keys()].map(close)) },
    async read(raw, signal) {
      const request = parseRemoteBotChatAttachmentTransferRequest(raw)
      if (request.kind === 'close') {
        const entry = active.get(request.transfer_id)
        if (entry && !sameScope(entry.request, request)) invalid()
        return { closed: await close(request.transfer_id) }
      }
      if (signal?.aborted && request.kind === 'next') {
        const entry = active.get(request.transfer_id)
        if (!entry || !sameScope(entry.request, request)) invalid()
        await close(request.transfer_id)
      }
      signal?.throwIfAborted()
      if (request.kind === 'open') {
        for (const entry of active.values()) if (entry.expiresAt <= now()) await close(entry.id)
        if (active.size >= MAX_ACTIVE) throw error('bot/busy', 'Too many Bot attachment transfers')
        const target = { logicalId: request.logical_id, part: request.part,
          eventDigest: request.event_digest, manifestDigest: request.manifest_digest,
          eventSeq: request.eventSeq, blockIndex: request.blockIndex }
        const selected = await select(target, signal)
        signal?.throwIfAborted()
        if (selected.teamRevision !== request.team_revision || selected.item.ref.bytes > 512 * 1024 * 1024 ||
            !await current(selected, signal)) stale()
        const controller = new AbortController()
        const iterator = stream(ctx, selected.source.events, selected.source.digest,
          request.manifest_digest, { eventSeq: request.eventSeq, blockIndex: request.blockIndex },
          controller.signal)[Symbol.asyncIterator]()
        const entry = { id: randomUUID(), request, selected, controller, iterator,
          offset: 0, busy: false, expiresAt: 0, timer: undefined }
        arm(entry)
        active.set(entry.id, entry)
        return { transfer_id: entry.id, logical_id: request.logical_id, part: request.part,
          part_count: selected.partCount, team_revision: selected.teamRevision,
          event_digest: request.event_digest, manifest_digest: request.manifest_digest,
          eventSeq: request.eventSeq, blockIndex: request.blockIndex,
          type: selected.item.type, ref: selected.item.ref,
          total_bytes: selected.item.ref.bytes, source: 'authority' }
      }
      const entry = active.get(request.transfer_id)
      if (!entry || !sameScope(entry.request, request) || entry.busy ||
          entry.expiresAt <= now() || entry.offset !== request.offset) {
        if (entry?.expiresAt <= now()) await close(request.transfer_id)
        invalid()
      }
      entry.busy = true
      const onAbort = () => entry.controller.abort(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        signal?.throwIfAborted()
        if (!await current(entry.selected, signal)) stale()
        const next = await entry.iterator.next()
        signal?.throwIfAborted()
        const rawBytes = next.done ? Buffer.alloc(0) : next.value
        if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength > 32 * 1024 ||
            rawBytes.byteLength === 0 && !next.done ||
            entry.offset + rawBytes.byteLength > entry.selected.item.ref.bytes) invalid()
        // The source iterator may reuse its buffer when EOF is requested below.
        const bytes = Buffer.from(rawBytes)
        const offset = entry.offset
        entry.offset += bytes.byteLength
        let final = next.done
        if (entry.offset === entry.selected.item.ref.bytes && !next.done) {
          const tail = await entry.iterator.next()
          if (!tail.done) invalid()
          final = true
        }
        signal?.throwIfAborted()
        if (!await current(entry.selected, signal)) stale()
        if (final) {
          if (entry.offset !== entry.selected.item.ref.bytes ||
              !await confirm(entry.selected, signal)) stale()
          signal?.throwIfAborted()
          if (!await current(entry.selected, signal)) stale()
        }
        const page = { transfer_id: entry.id, logical_id: entry.request.logical_id,
          part: entry.request.part, team_revision: entry.selected.teamRevision,
          event_digest: entry.request.event_digest, manifest_digest: entry.request.manifest_digest,
          eventSeq: entry.request.eventSeq, blockIndex: entry.request.blockIndex,
          attachment_id: entry.selected.item.ref.attachmentId,
          total_bytes: entry.selected.item.ref.bytes, offset,
          chunk_base64: Buffer.from(bytes).toString('base64'), final, source: 'authority' }
        if (Buffer.byteLength(JSON.stringify(page)) > 60 * 1024) invalid()
        if (final) await close(entry.id)
        else arm(entry)
        return page
      } catch (cause) {
        await close(entry.id)
        throw cause
      } finally {
        signal?.removeEventListener('abort', onAbort)
        entry.busy = false
      }
    },
  }
}
