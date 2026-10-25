// Project one verified private Session into the text the Bot chat actually shows.
import { createHash } from 'node:crypto'
import { REPLY_KIND, SOURCE_KIND } from './constants.js'
import { historyEntry } from './parts.js'

const MAX_EVENTS = 100_000
const MAX_BYTES = 64_000_000
const DIGEST = /^[0-9a-f]{64}$/u
const row = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = () => { throw new Error('Invalid Bot chat source') }
const unsupported = () => { throw new Error('Bot chat has unsupported visible content') }
const sha = value => createHash('sha256').update(value).digest('hex')

function visibleContent(event) {
  if (event.type === 'assistant/message') return { content: event.data?.message?.content, tools: true }
  if (event.type === 'user/message' &&
      ['user', SOURCE_KIND, REPLY_KIND].includes(event.data?.source?.kind)) {
    return { content: event.data?.content, tools: false }
  }
  return null
}

function checkContent(event) {
  const visible = visibleContent(event)
  if (!visible) return
  if (!Array.isArray(visible.content)) unsupported()
  for (const block of visible.content) {
    if (!row(block)) unsupported()
    if (block.type === 'text' && typeof block.text === 'string') continue
    // DSH stores assistant reasoning in the Session, but the chat UI never shows it.
    if (visible.tools && (block.type === 'tool-call' || block.type === 'reasoning')) continue
    unsupported()
  }
}

/** Source event digest binds this view to the previously inventoried Session. */
export function projectTextBotChatPart(events, expectedDigest) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS ||
      typeof expectedDigest !== 'string' || !DIGEST.test(expectedDigest)) invalid()
  let encoded
  try { encoded = JSON.stringify(events) } catch { invalid() }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_BYTES ||
      events.some(event => !row(event) || !Number.isSafeInteger(event.seq) || event.seq < 0)) invalid()
  for (let index = 1; index < events.length; index++) {
    if (events[index].seq <= events[index - 1].seq) invalid()
  }
  if (sha(encoded) !== expectedDigest) throw new Error('Bot chat source changed')
  const backwards = []
  let answers = []
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    checkContent(event)
    const entry = historyEntry(event, false)
    if (!entry) continue
    const line = { seq: event.seq, time: Number.isFinite(event.time) ? event.time : null,
      who: entry.answer ? 'you' : entry.who, text: entry.text }
    if (entry.answer) { answers.push(line); continue }
    if (entry.keepAnswers) backwards.push(...answers)
    answers = []
    if (entry.text !== '') backwards.push(line)
  }
  const rows = backwards.reverse()
  const serialized = JSON.stringify(rows)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) invalid()
  return { eventCount: events.length, eventDigest: expectedDigest, rows, rowsDigest: sha(serialized) }
}
