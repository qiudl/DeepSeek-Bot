import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { createGroupHistory } from '../src/host/group-history.js'
import { parseRemoteGroupHistoryRead, parseRemoteMemoryRead, parseRemoteTeamRead,
  projectRemoteGroupHistory, projectRemoteMemory, projectRemoteTeam } from '../src/host/team-remote-read.js'
import { fakeContext } from './fake-ctx.js'

const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'team', limit: 1 }
const state = { revision: 7, mainBotIds: ['thanos'], bots: {
  thanos: { id: 'thanos', name: '灭霸Thanos', role: '主 Bot', instructions: 'private prompt',
    workDir: '/private/work', model: 'private-model', secret: 'private-value' },
  chief: { id: 'chief', name: 'Chief', role: 'Assistant' },
}, rooms: { project: { id: 'project', name: '项目', members: ['thanos', 'chief'],
  log: [{ text: 'private log' }], workDir: '/private/room' } } }

test('REQ-20261023-0001 remote team pages contain only logical roster fields', () => {
  const first = projectRemoteTeam(state, request, () => 0)
  assert.deepEqual(first.items, [{ kind: 'bot', logical_id: 'bot:chief', name: 'Chief', role: 'Assistant', main: false }])
  assert.equal(first.team_revision, 7)
  assert.equal(first.source, 'authority')
  assert.equal(first.last_confirmed_at, '1970-01-01T00:00:00.000Z')
  const second = projectRemoteTeam(state, { ...request, cursor: first.next_cursor }, () => 0)
  assert.deepEqual(second.items, [{ kind: 'bot', logical_id: 'bot:thanos', name: '灭霸Thanos', role: '主 Bot', main: true }])
  const third = projectRemoteTeam(state, { ...request, cursor: second.next_cursor }, () => 0)
  assert.deepEqual(third.items, [{ kind: 'room', logical_id: 'room:project', name: '项目',
    members: ['bot:thanos', 'bot:chief'] }])
  assert.equal(third.next_cursor, null)
  const wire = JSON.stringify([first, second, third])
  for (const hidden of ['private prompt', '/private/work', 'private-model', 'private-value',
    'private log', '/private/room', 'sessionId']) assert.equal(wire.includes(hidden), false)
  assert.throws(() => projectRemoteTeam({ ...state, revision: 8 },
    { ...request, cursor: first.next_cursor }), { code: 'bot/stale' })
})

test('REQ-20261023-0001 remote team rejects selectors and broken references', () => {
  for (const value of [
    { ...request, kind: 'chat' }, { ...request, profile_id: 'other' },
    { ...request, logical_id: 'bot:thanos' }, { ...request, limit: 101 },
    { ...request, cursor: '../secret' }, { ...request, schema_version: 'other' },
  ]) assert.throws(() => parseRemoteTeamRead(value), { code: 'bot/invalid' })
  assert.throws(() => projectRemoteTeam({ ...state, rooms: {
    project: { id: 'project', name: 'Broken', members: ['missing'] },
  } }, request), { code: 'bot/invalid' })
  assert.throws(() => projectRemoteTeam(state, { ...request, cursor: 'bm90LWpzb24' }),
    { code: 'bot/invalid' })
})

test('REQ-20261023-0001 large teams advance by byte-bounded pages', () => {
  const bots = Object.fromEntries(Array.from({ length: 100 }, (_, index) => {
    const id = `bot_${index}`
    return [id, { id, name: '名'.repeat(170), role: 'r'.repeat(1024) }]
  }))
  const large = { revision: 8, mainBotIds: [], bots, rooms: {} }
  const seen = new Set()
  let cursor
  do {
    const page = projectRemoteTeam(large, { schema_version: request.schema_version,
      kind: 'team', limit: 100, ...(cursor ? { cursor } : {}) }, () => 0)
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 60 * 1024)
    assert.ok(page.items.length > 0)
    for (const item of page.items) {
      assert.equal(seen.has(item.logical_id), false)
      seen.add(item.logical_id)
    }
    cursor = page.next_cursor
  } while (cursor)
  assert.equal(seen.size, 100)
})

test('REQ-20261023-0001 remote team service requires this Host to own the team', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-read-'))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  Object.assign(rt.state, structuredClone(state))
  await rt.save()
  const service = ctx.get('dsBotSlarkRemoteRead')
  assert.equal((await service.read({ ...request, limit: 3 })).items.length, 3)
  assert.equal((await service.read({ schema_version: request.schema_version,
    kind: 'memory', logical_id: 'bot:thanos' })).item, null)
  writeFileSync(join(home, 'import-activation.pending.json'), '{}')
  await assert.rejects(service.read(request), { code: 'bot/read-only' })
  await assert.rejects(service.read({ schema_version: request.schema_version,
    kind: 'memory', logical_id: 'bot:thanos' }), { code: 'bot/read-only' })
})

test('REQ-20261023-0001 memory pages carry complete bytes and reject a changed scope', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-memory-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const dir = join(home, 'memory', 'bots', 'thanos')
  mkdirSync(dir, { recursive: true })
  const original = Buffer.from('灭霸'.repeat(20_000))
  writeFileSync(join(dir, 'MEMORY.md'), original)
  writeFileSync(join(dir, 'facts.md'), 'some facts')
  const target = { schema_version: request.schema_version, kind: 'memory', logical_id: 'bot:thanos' }
  const collected = new Map()
  let cursor
  let first
  do {
    const page = await projectRemoteMemory(state, home, { ...target, ...(cursor ? { cursor } : {}) }, () => 0)
    first ??= page
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 60 * 1024)
    assert.equal(page.logical_id, 'bot:thanos')
    assert.equal(page.source, 'authority')
    assert.equal(page.last_confirmed_at, '1970-01-01T00:00:00.000Z')
    const item = page.item
    const prior = collected.get(item.file) ?? []
    assert.equal(item.offset, Buffer.concat(prior).length)
    prior.push(Buffer.from(item.content_base64, 'base64'))
    collected.set(item.file, prior)
    cursor = page.next_cursor
  } while (cursor)
  assert.deepEqual(Buffer.concat(collected.get('MEMORY.md')), original)
  assert.equal(Buffer.concat(collected.get('facts.md')).toString(), 'some facts')
  writeFileSync(join(dir, 'facts.md'), 'changed')
  await assert.rejects(projectRemoteMemory(state, home, { ...target, cursor: first.next_cursor }), { code: 'bot/stale' })
})

test('REQ-20261023-0001 memory read rejects selectors, unknown scopes and symbolic links', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-memory-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  for (const value of [{ ...request, kind: 'memory' },
    { schema_version: request.schema_version, kind: 'memory', logical_id: 'bot:thanos', profile_id: 'other' },
    { schema_version: request.schema_version, kind: 'memory', logical_id: 'bot:../secret' }]) {
    assert.throws(() => parseRemoteMemoryRead(value), { code: 'bot/invalid' })
  }
  const target = { schema_version: request.schema_version, kind: 'memory', logical_id: 'bot:thanos' }
  await assert.rejects(projectRemoteMemory(state, home, { ...target, logical_id: 'bot:missing' }), { code: 'bot/invalid' })
  assert.equal((await projectRemoteMemory(state, home, target)).item, null)
  const dir = join(home, 'memory', 'bots', 'thanos')
  mkdirSync(dir, { recursive: true })
  symlinkSync(join(home, 'outside.md'), join(dir, 'MEMORY.md'))
  await assert.rejects(projectRemoteMemory(state, home, target), { code: 'bot/invalid' })
})

test('REQ-20261023-0001 group history pages exclude uncommitted bytes and stale cursors', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-group-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const room = { id: 'project', seq: 0, log: [] }
  const source = { rooms: { project: room } }
  const writer = createGroupHistory(home, () => true)
  for (let seq = 1; seq <= 3; seq++) {
    const line = { seq, who: 'User', text: 'group text '.repeat(60) + seq }
    writer.append(room, line)
    room.seq = seq
    room.log.push(line)
    room.historyJournal = writer.checkpoint(room)
  }
  writer.append(room, { seq: 4, who: 'User', text: 'uncommitted' })
  const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'group-history',
    logical_id: 'room:project', limit: 111 }
  const chunks = []
  let cursor
  let first
  do {
    const page = projectRemoteGroupHistory(source, home, { ...request, ...(cursor ? { cursor } : {}) }, () => 0)
    first ??= page
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 60 * 1024)
    assert.equal(page.seq, 3)
    assert.equal(page.digest, room.historyJournal.digest)
    assert.equal(page.last_confirmed_at, '1970-01-01T00:00:00.000Z')
    chunks.push(Buffer.from(page.content_base64, 'base64'))
    cursor = page.next_cursor
  } while (cursor)
  const bytes = Buffer.concat(chunks)
  assert.equal(bytes.length, first.total_bytes)
  assert.equal(bytes.toString('utf8').includes('uncommitted'), false)
  room.historyJournal.digest = '0'.repeat(64)
  assert.throws(() => projectRemoteGroupHistory(source, home,
    { ...request, cursor: first.next_cursor }), { code: 'bot/stale' })
})

test('REQ-20261023-0001 group history read refuses selectors and incomplete sources', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-group-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'group-history',
    logical_id: 'room:project' }
  for (const value of [{ ...request, profile_id: 'other' },
    { ...request, logical_id: 'room:../other' }, { ...request, limit: 32 * 1024 + 1 }]) {
    assert.throws(() => parseRemoteGroupHistoryRead(value), { code: 'bot/invalid' })
  }
  assert.throws(() => projectRemoteGroupHistory({ rooms: {} }, home, request), { code: 'bot/invalid' })
  assert.throws(() => projectRemoteGroupHistory({ rooms: { project: {
    id: 'project', seq: 61, log: [{ seq: 61, text: 'tail' }],
  } } }, home, request), { code: 'bot/incomplete' })
  assert.equal(projectRemoteGroupHistory({ rooms: { project: { id: 'project', seq: 0, log: [] } } },
    home, request).total_bytes, 0)
})

test('REQ-20261023-0001 remote group service reads committed state, not unsaved memory', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-group-'))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  const room = { id: 'project', seq: 0, log: [] }
  const writer = createGroupHistory(home, () => true)
  const line = { seq: 1, who: 'User', text: 'committed' }
  writer.append(room, line)
  room.seq = 1
  room.log = [line]
  room.historyJournal = writer.checkpoint(room)
  rt.state.rooms.project = room
  await rt.save()
  const service = ctx.get('dsBotSlarkRemoteRead')
  const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'group-history',
    logical_id: 'room:project' }
  room.seq = 2
  const page = await service.read(request)
  assert.equal(page.seq, 1)
  assert.match(Buffer.from(page.content_base64, 'base64').toString(), /committed/u)
})

test('REQ-20261023-0001 private Bot chat service uses committed team and read-only Session handle', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-chat-'))
  const ctx = fakeContext()
  const id = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const events = [{ seq: 0, type: 'system/message', data: { cwd: '/private/source' } },
    { seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'user' },
      content: [{ type: 'text', text: 'hi' }] } }]
  const opened = []
  let revokeDuringRead = false
  ctx.sessionPersistence = {
    stat: async session => ({ header: { id: session }, revision: 'r1',
      eventCount: events.length, sizeBytes: 100 }),
    open: async (session, access) => {
      opened.push([session, access])
      return { id: session, access, header: { id: session },
        read: async () => {
          if (revokeDuringRead) writeFileSync(join(home, 'import-activation.pending.json'), '{}')
          return { events }
        }, close: async () => {} }
    },
  }
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  rt.state.bots[id] = { id, name: 'Thanos', role: 'Main' }
  rt.state.mainBotIds = [id]
  await rt.save()
  const service = ctx.get('dsBotSlarkRemoteRead')
  const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'bot-chat',
    logical_id: `bot:${id}`, part: 0, limit: 1024 }
  const page = await service.read(request)
  assert.deepEqual(opened, [[id, 'read']])
  assert.equal(page.part_count, 1)
  assert.equal(Buffer.from(page.content_base64, 'base64').toString().includes('/private/source'), false)
  events[1].data.content.push({ type: 'image', attachment: {
    attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png',
    bytes: 12, width: 1, height: 1, name: 'photo.png',
  } })
  const attachmentRequest = { schema_version: 'dsh-remote-bot-read/v1',
    kind: 'bot-chat-attachments', logical_id: `bot:${id}`, part: 0, limit: 10 }
  const manifest = await service.read(attachmentRequest)
  assert.deepEqual(manifest.items.map(item => [item.eventSeq, item.blockIndex]), [[1, 1]])
  assert.equal(JSON.stringify(manifest).includes('/private/source'), false)
  assert.deepEqual(opened, [[id, 'read'], [id, 'read']])
  revokeDuringRead = true
  await assert.rejects(service.read(attachmentRequest), { code: 'bot/read-only' })
  assert.deepEqual(opened, [[id, 'read'], [id, 'read'], [id, 'read']])
  await assert.rejects(service.read(request), { code: 'bot/read-only' })
  assert.deepEqual(opened, [[id, 'read'], [id, 'read'], [id, 'read']])
})

test('REQ-20261023-0001 Profile service streams only a pinned visible Bot attachment', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-attachment-'))
  const ctx = fakeContext()
  const id = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const bytes = Buffer.from('visible attachment bytes')
  const ref = { attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    name: 'report.txt', bytes: bytes.length }
  const events = [{ seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'user' },
    content: [{ type: 'file', attachment: ref }] } }]
  ctx.sessionPersistence = {
    stat: async session => ({ header: { id: session }, revision: 'r1',
      eventCount: events.length, sizeBytes: 100 }),
    open: async (session, access) => ({ id: session, access, header: { id: session },
      read: async () => ({ events }), close: async () => {} }),
  }
  ctx.attachments = { readImage: async () => { throw Error('not image') },
    readFileStream: async function* () { yield bytes } }
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  rt.state.bots[id] = { id, name: 'Thanos', role: 'Main' }
  rt.state.mainBotIds = [id]
  await rt.save()
  const service = ctx.get('dsBotSlarkRemoteRead')
  const manifest = await service.read({ schema_version: 'dsh-remote-bot-read/v1',
    kind: 'bot-chat-attachments', logical_id: `bot:${id}`, part: 0, limit: 100 })
  const opened = await service.read({ schema_version: 'dsh-remote-bot-attachment/v1', kind: 'open',
    logical_id: `bot:${id}`, part: 0, team_revision: manifest.team_revision,
    event_digest: manifest.event_digest, manifest_digest: manifest.manifest_digest,
    eventSeq: 1, blockIndex: 0 })
  const page = await service.read({ schema_version: 'dsh-remote-bot-attachment/v1',
    kind: 'next', transfer_id: opened.transfer_id, offset: 0 })
  assert.equal(page.final, true)
  assert.deepEqual(Buffer.from(page.chunk_base64, 'base64'), bytes)
  assert.equal(page.attachment_id, ref.attachmentId)
  writeFileSync(join(home, 'import-activation.pending.json'), '{}')
  await assert.rejects(service.read({ schema_version: 'dsh-remote-bot-attachment/v1', kind: 'open',
    logical_id: `bot:${id}`, part: 0, team_revision: manifest.team_revision,
    event_digest: manifest.event_digest, manifest_digest: manifest.manifest_digest,
    eventSeq: 1, blockIndex: 0 }), { code: 'bot/read-only' })
})
