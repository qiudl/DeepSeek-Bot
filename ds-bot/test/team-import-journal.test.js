import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTeamImportJournal } from '../src/host/team-import-journal.js'

const sourceId = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const targetId = 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const reservation = { sourceId, targetId, eventDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), targetDigest: 'c'.repeat(64) }

test('REQ-20261023-0001 persists a private reservation and blocks repeated creation across instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-import-journal-'))
  try {
    const journal = createTeamImportJournal(root)
    await journal.reserve(reservation)
    const record = JSON.parse(await readFile(join(root, `${targetId}.json`), 'utf8'))
    assert.deepEqual(record, { version: 1, status: 'pending', ...reservation })
    if (process.platform !== 'win32') assert.equal((await stat(join(root, `${targetId}.json`))).mode & 0o777, 0o600)
    await assert.rejects(createTeamImportJournal(root).reserve(reservation), /already reserved/u)
    await journal.complete(targetId)
    assert.equal((await journal.read(targetId)).status, 'staged')
    await assert.rejects(journal.reserve(reservation), /already reserved/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('REQ-20261023-0001 leaves a failed stage visible and refuses to mark it complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-import-journal-'))
  try {
    const journal = createTeamImportJournal(root)
    await journal.reserve(reservation)
    await journal.fail(targetId)
    assert.equal((await journal.read(targetId)).status, 'needs-review')
    await assert.rejects(journal.complete(targetId), /not pending/u)
    await assert.rejects(journal.reserve(reservation), /already reserved/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})
