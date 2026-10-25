// Inventory only user-visible private chat attachments from a verified Session.
import { createHash } from 'node:crypto'
import { REPLY_KIND, SOURCE_KIND } from './constants.js'
import { historyEntry } from './parts.js'
import { inventorySessionAttachments } from './team-import-attachments.js'

const DIGEST = /^[0-9a-f]{64}$/u
const MAX_EVENTS = 100_000
const MAX_BYTES = 64_000_000
const MAX_ATTACHMENTS = 5_000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = () => { throw new Error('Invalid Bot chat attachment source') }

export function inventoryVisibleBotChatAttachments(events, expectedDigest) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS ||
      typeof expectedDigest !== 'string' || !DIGEST.test(expectedDigest)) invalid()
  let encoded
  try { encoded = JSON.stringify(events) } catch { invalid() }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_BYTES ||
      createHash('sha256').update(encoded).digest('hex') !== expectedDigest) invalid()
  const items = []
  const bySeq = new Map()
  let previous = -1
  for (const event of events) {
    if (!object(event) || !Number.isSafeInteger(event.seq) || event.seq <= previous) invalid()
    previous = event.seq
    const assistant = event.type === 'assistant/message'
    const user = event.type === 'user/message' &&
      ['user', SOURCE_KIND, REPLY_KIND].includes(event.data?.source?.kind)
    if (!assistant && !user) continue
    const content = assistant ? event.data?.message?.content : event.data?.content
    if (!Array.isArray(content)) invalid()
    for (const [index, block] of content.entries()) {
      if (!object(block)) invalid()
      if (block.type === 'text' && typeof block.text === 'string') continue
      if (assistant && (block.type === 'reasoning' || block.type === 'tool-call')) continue
      if (block.type !== 'image' && block.type !== 'file') invalid()
      const found = inventorySessionAttachments([block])
      if (found.length !== 1 || items.length >= MAX_ATTACHMENTS) invalid()
      const item = { eventSeq: event.seq, blockIndex: index,
        type: found[0].type, ref: found[0].ref }
      items.push(item)
      if (!bySeq.has(event.seq)) bySeq.set(event.seq, [])
      bySeq.get(event.seq).push(item)
    }
  }
  // DS Bot's private history keeps assistant answers only when the following
  // user/Bot input is itself shown. Do not publish attachment refs from a hidden
  // kickoff or an orphan assistant answer.
  const shown = new Set()
  let answers = []
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    const entry = historyEntry(event, false)
    const media = bySeq.has(event.seq)
    if (entry?.answer || (event.type === 'assistant/message' && media)) {
      answers.push(event.seq)
      continue
    }
    if (!entry) continue
    if (entry.keepAnswers) for (const seq of answers) shown.add(seq)
    answers = []
    if (entry.text !== '' || media) shown.add(event.seq)
  }
  const visible = items.filter(item => shown.has(item.eventSeq))
  return { eventDigest: expectedDigest, items: visible,
    manifestDigest: createHash('sha256').update(JSON.stringify(visible)).digest('hex') }
}
