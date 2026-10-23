import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { parseRemoteTeamRead, projectRemoteTeam } from '../src/host/team-remote-read.js'
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
  writeFileSync(join(home, 'import-activation.pending.json'), '{}')
  await assert.rejects(service.read(request), { code: 'bot/read-only' })
})
