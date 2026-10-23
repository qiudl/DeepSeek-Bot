import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTeamImportAttachmentJournal, readStagedAttachmentMappings,
  stageImportedAttachmentWithJournal, verifyStagedAttachmentMappings } from '../src/host/team-import-attachment-journal.js'

const bytes = Buffer.from('private attachment')
const ref = { attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  name: 'note.txt', bytes: bytes.length }
const plan = { sourceDigest: 'a'.repeat(64), targetDigest: 'b'.repeat(64) }

test('REQ-20261023-0001 records a durable attachment mapping before Session staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-attachment-journal-'))
  try {
    const journal = createTeamImportAttachmentJournal(root)
    const ctx = { attachments: { saveImage: async () => { throw new Error('unused') },
      saveFileStream: async ({ data }) => { for await (const chunk of data) assert.deepEqual(chunk, bytes); return ref },
      readImage: async () => { throw new Error('unused') },
      async *readFileStream() { yield bytes },
    } }
    async function* stream() { yield bytes }
    const staged = await stageImportedAttachmentWithJournal(ctx,
      { type: 'file', sourceRef: ref, data: stream() }, plan, journal)
    assert.deepEqual(staged.targetRef, ref)
    assert.deepEqual(await readStagedAttachmentMappings(createTeamImportAttachmentJournal(root),
      [{ type: 'file', ref }], plan), [{ type: 'file', sourceRef: ref, targetRef: ref }])
    assert.equal((await verifyStagedAttachmentMappings(ctx, journal, [{ type: 'file', ref }], plan)).length, 1)
    await assert.rejects(verifyStagedAttachmentMappings({ attachments: {
      ...ctx.attachments, async *readFileStream() { yield Buffer.from('corrupt') },
    } }, journal, [{ type: 'file', ref }], plan), /Attachment bytes changed/u)
    const [name] = await readdir(root)
    const record = JSON.parse(await readFile(join(root, name), 'utf8'))
    assert.equal(record.status, 'staged')
    if (process.platform !== 'win32') assert.equal((await stat(join(root, name))).mode & 0o777, 0o600)
    await assert.rejects(stageImportedAttachmentWithJournal(ctx,
      { type: 'file', sourceRef: ref, data: stream() }, plan, journal), /already reserved/u)
    await assert.rejects(readStagedAttachmentMappings(journal, [{ type: 'file', ref }],
      { ...plan, targetDigest: 'c'.repeat(64) }), /stage incomplete/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('REQ-20261023-0001 leaves an interrupted or failed attachment reservation for review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-attachment-journal-'))
  try {
    const journal = createTeamImportAttachmentJournal(root)
    await journal.reserve({ type: 'file', sourceRef: ref, ...plan })
    await assert.rejects(readStagedAttachmentMappings(journal, [{ type: 'file', ref }], plan), /stage incomplete/u)
    await assert.rejects(journal.reserve({ type: 'file', sourceRef: ref, ...plan }), /already reserved/u)
    await journal.fail('file', ref)
    assert.equal((await journal.read('file', ref)).status, 'needs-review')
    await assert.rejects(journal.complete('file', ref, ref), /not pending/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})
