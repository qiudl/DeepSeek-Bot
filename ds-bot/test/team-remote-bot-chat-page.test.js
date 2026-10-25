import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { parseRemoteBotChatRead, parseRemoteBotChatAttachmentRead,
  projectRemoteBotChat, projectRemoteBotChatAttachments } from '../src/host/team-remote-bot-chat-page.js'

const id = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const old = 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const team = { revision: 7, bots: { [id]: { id, sessionId: old,
  segments: [{ sessionId: id }] } }, rooms: {} }
const events = session => [{ seq: 0, type: 'system/message', data: { cwd: '/private/source' } },
  { seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'user' },
    content: [{ type: 'text', text: `hello ${session} `.repeat(40) }] } }]
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'bot-chat',
  logical_id: `bot:${id}`, part: 1, limit: 80 }
const reader = async session => ({ events: events(session), eventCount: 2,
  digest: digest(events(session)) })

test('REQ-20261023-0001 pages only a team-owned Bot private chat part', async () => {
  const chunks = []
  let cursor
  let first
  do {
    const page = await projectRemoteBotChat(team, { ...request, ...(cursor ? { cursor } : {}) }, reader, () => 0)
    first ??= page
    assert.equal(page.logical_id, request.logical_id)
    assert.equal(page.part, 1)
    assert.equal(page.part_count, 2)
    assert.equal(page.team_revision, 7)
    assert.equal(page.complete, true)
    assert.equal(page.source, 'authority')
    assert.equal(page.last_confirmed_at, '1970-01-01T00:00:00.000Z')
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 60 * 1024)
    chunks.push(Buffer.from(page.content_base64, 'base64'))
    cursor = page.next_cursor
  } while (cursor)
  const body = Buffer.concat(chunks)
  assert.equal(body.length, first.total_bytes)
  assert.equal(createHash('sha256').update(body).digest('hex'), first.rows_digest)
  assert.deepEqual(JSON.parse(body.toString('utf8')).map(row => row.text),
    [`hello ${old} `.repeat(40).trim()])
  assert.equal(body.includes(Buffer.from('/private/source')), false)
})

test('REQ-20261023-0001 rejects arbitrary Sessions and stale Bot chat cursors', async () => {
  for (const candidate of [{ ...request, profile_id: 'other' },
    { ...request, part: -1 }, { ...request, logical_id: 'bot:../private' },
    { ...request, limit: 32 * 1024 + 1 }]) {
    assert.throws(() => parseRemoteBotChatRead(candidate), { code: 'bot/invalid' })
  }
  await assert.rejects(projectRemoteBotChat(team, { ...request,
    logical_id: 'bot:session-cccccccc-cccc-cccc-cccc-cccccccccccc' }, reader),
  { code: 'bot/invalid' })
  const first = await projectRemoteBotChat(team, request, reader)
  await assert.rejects(projectRemoteBotChat({ ...team, revision: 8 },
    { ...request, cursor: first.next_cursor }, reader), { code: 'bot/stale' })
  const changed = async session => ({ events: events(session).concat({ seq: 2, time: 2,
    type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'new' }] } } }),
    eventCount: 3, digest: digest(events(session).concat({ seq: 2, time: 2,
      type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'new' }] } } })) })
  await assert.rejects(projectRemoteBotChat(team, { ...request, cursor: first.next_cursor }, changed),
    { code: 'bot/stale' })
  const alias = { ...team, rooms: { [old]: { id: old, sessions: {}, segments: {} } } }
  await assert.rejects(projectRemoteBotChat(alias, request, reader), { code: 'bot/invalid' })
})

test('REQ-20261023-0001 pages only visible attachment refs from a team-owned chat', async () => {
  const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png',
    bytes: 12, width: 1, height: 1, name: 'photo.png' }
  const mediaEvents = [
    { seq: 0, type: 'system/message', data: { content: [{ type: 'image', attachment: ref }] } },
    ...[1, 2, 3].map(seq => ({ seq, time: seq, type: 'user/message',
      data: { source: { kind: 'user' }, content: [
        { type: 'text', text: `photo ${seq}` }, { type: 'image', attachment: ref }] } })),
  ]
  const read = async () => ({ events: mediaEvents, eventCount: mediaEvents.length,
    digest: digest(mediaEvents) })
  const mediaRequest = { schema_version: request.schema_version, kind: 'bot-chat-attachments',
    logical_id: request.logical_id, part: 1, limit: 2 }
  const first = await projectRemoteBotChatAttachments(team, mediaRequest, read, () => 0)
  assert.equal(first.part_count, 2)
  assert.equal(first.items.length, 2)
  assert.deepEqual(first.items.map(item => item.eventSeq), [1, 2])
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 60 * 1024)
  const second = await projectRemoteBotChatAttachments(team,
    { ...mediaRequest, cursor: first.next_cursor }, read, () => 0)
  assert.deepEqual(second.items.map(item => item.eventSeq), [3])
  assert.equal(second.next_cursor, null)
  assert.equal(second.manifest_digest, first.manifest_digest)
  assert.equal(JSON.stringify(first).includes('/private/'), false)
  await assert.rejects(projectRemoteBotChatAttachments({ ...team, revision: 8 },
    { ...mediaRequest, cursor: first.next_cursor }, read), { code: 'bot/stale' })
  const changed = structuredClone(mediaEvents)
  changed[2].data.content[0].text = 'changed'
  await assert.rejects(projectRemoteBotChatAttachments(team,
    { ...mediaRequest, cursor: first.next_cursor }, async () => ({ events: changed,
      eventCount: changed.length, digest: digest(changed) })), { code: 'bot/stale' })
  await assert.rejects(projectRemoteBotChatAttachments(team,
    { ...mediaRequest, profile_id: 'other' }, read), { code: 'bot/invalid' })
  assert.throws(() => parseRemoteBotChatAttachmentRead({ ...mediaRequest, limit: 101 }),
    { code: 'bot/invalid' })
})
