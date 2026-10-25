import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { parseRemoteBotChatRead, projectRemoteBotChat } from '../src/host/team-remote-bot-chat-page.js'

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
