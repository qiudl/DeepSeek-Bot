// Full group lines survive the 60-line UI cache. The group state remains the
// execution authority; a journal ahead of that state needs explicit recovery.
import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { TEXT_KEPT } from './constants.js'
import { headOf } from './text.js'

const ID = /^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const DIGEST = /^[0-9a-f]{64}$/u
const MAX_RECORD_BYTES = 2 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024
const noFollow = constants.O_NOFOLLOW ?? 0
const invalid = () => new Error('Group history needs recovery')
const row = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const sha = value => createHash('sha256').update(value).digest('hex')
const cacheLine = line => typeof line.text === 'string' && line.text.length > TEXT_KEPT && line.length === undefined
  ? { ...line, text: headOf(line.text, TEXT_KEPT), length: line.text.length } : line
const cacheProof = line => sha(JSON.stringify({ seq: line.seq, text: line.text ?? '', length: line.length ?? null }))

function writeAll(fd, data) {
  const bytes = Buffer.from(data)
  for (let offset = 0; offset < bytes.length;) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset)
    if (count <= 0) throw invalid()
    offset += count
  }
}

function record(seq, line, previous) {
  const body = { seq, line, previous }
  const digest = sha(JSON.stringify(body))
  const text = JSON.stringify({ ...body, digest }) + '\n'
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw invalid()
  return { text, digest }
}

function scan(path, roomId) {
  const fd = openSync(path, constants.O_RDONLY | noFollow)
  let header, previous, lastSeq, tail = []
  try {
    if (!fstatSync(fd).isFile()) throw invalid()
    const chunk = Buffer.alloc(CHUNK_BYTES)
    let pending = Buffer.alloc(0)
    const take = bytes => {
      let value
      try { value = JSON.parse(bytes.toString('utf8')) } catch { throw invalid() }
      if (!row(value)) throw invalid()
      if (!header) {
        if (!exact(value, ['version', 'room_id', 'first_seq', 'complete']) || value.version !== 1 ||
            value.room_id !== roomId || !Number.isSafeInteger(value.first_seq) || value.first_seq < 1 ||
            typeof value.complete !== 'boolean' || value.complete && value.first_seq !== 1) throw invalid()
        header = value
        previous = sha(JSON.stringify(value))
        lastSeq = value.first_seq - 1
        return
      }
      if (!exact(value, ['seq', 'line', 'previous', 'digest']) ||
          !Number.isSafeInteger(value.seq) || value.seq !== lastSeq + 1 ||
          !row(value.line) || value.line.seq !== value.seq ||
          value.previous !== previous || typeof value.digest !== 'string' || !DIGEST.test(value.digest) ||
          sha(JSON.stringify({ seq: value.seq, line: value.line, previous: value.previous })) !== value.digest)
        throw invalid()
      previous = value.digest
      lastSeq = value.seq
      tail.push(cacheProof(cacheLine(value.line)))
      if (tail.length > 60) tail.shift()
    }
    for (let size; (size = readSync(fd, chunk, 0, chunk.length)) > 0;) {
      pending = Buffer.concat([pending, chunk.subarray(0, size)])
      for (let end; (end = pending.indexOf(10)) >= 0;) {
        if (end > MAX_RECORD_BYTES) throw invalid()
        take(pending.subarray(0, end))
        pending = Buffer.from(pending.subarray(end + 1))
      }
      if (pending.length > MAX_RECORD_BYTES) throw invalid()
    }
    if (pending.length || !header) throw invalid()
    return { header, lastSeq, previous, tail }
  } finally { closeSync(fd) }
}

/** One Profile-local durable source for future group transcript reads. */
export function createGroupHistory(home, exclusiveWriter) {
  const dir = join(home, 'group-history')
  const current = new Map()
  const pathOf = id => {
    if (typeof id !== 'string' || !ID.test(id)) throw invalid()
    return join(dir, `${id}.jsonl`)
  }
  const directory = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!lstatSync(dir).isDirectory()) throw invalid()
  }
  const initialize = (room, legacy) => {
    const path = pathOf(room.id)
    directory()
    const log = room.log ?? []
    if (!Array.isArray(log) || !Number.isSafeInteger(room.seq) || room.seq < log.length ||
        log.some((line, index) => !row(line) || line.seq !== room.seq - log.length + index + 1))
      throw invalid()
    let found
    try { found = scan(path, room.id) }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const firstSeq = room.seq - log.length + 1
      const header = { version: 1, room_id: room.id, first_seq: firstSeq,
        complete: !legacy && firstSeq === 1 && log.every(line => line.length === undefined) }
      let previous = sha(JSON.stringify(header))
      let data = JSON.stringify(header) + '\n'
      for (const line of log) {
        const entry = record(line.seq, line, previous)
        data += entry.text
        previous = entry.digest
      }
      const temp = `${path}.${randomUUID()}.tmp`
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
      try { writeAll(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
      try { linkSync(temp, path) } finally { unlinkSync(temp) }
      found = scan(path, room.id)
    }
    if (found.lastSeq !== room.seq || found.tail.length < log.length ||
        log.some((line, index) => found.tail[found.tail.length - log.length + index] !== cacheProof(line)))
      throw invalid()
    current.set(room.id, found)
    return found
  }
  return {
    append(room, line, { legacy = false } = {}) {
      if (exclusiveWriter() !== true) throw invalid()
      const path = pathOf(room.id)
      directory()
      const state = current.get(room.id) ?? initialize(room, legacy)
      const log = room.log ?? []
      if (!Array.isArray(log) || state.lastSeq !== room.seq || state.tail.length < log.length ||
          log.some((item, index) => state.tail[state.tail.length - log.length + index] !== cacheProof(item)) ||
          !row(line) || line.seq !== room.seq + 1) throw invalid()
      const entry = record(line.seq, line, state.previous)
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | noFollow)
      try { writeAll(fd, entry.text); fsyncSync(fd) } catch (error) {
        current.delete(room.id)
        throw error
      } finally { closeSync(fd) }
      state.lastSeq = line.seq
      state.previous = entry.digest
      state.tail.push(cacheProof(cacheLine(line)))
      if (state.tail.length > 60) state.tail.shift()
      return { complete: state.header.complete, firstSeq: state.header.first_seq, lastSeq: state.lastSeq }
    },
    inspect(room) {
      const state = scan(pathOf(room.id), room.id)
      const log = room.log ?? []
      if (!Array.isArray(log) || state.lastSeq !== room.seq || state.tail.length < log.length ||
          log.some((line, index) => state.tail[state.tail.length - log.length + index] !== cacheProof(line)))
        throw invalid()
      return { complete: state.header.complete, firstSeq: state.header.first_seq, lastSeq: state.lastSeq }
    },
  }
}
