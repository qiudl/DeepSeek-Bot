import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { inventorySessionAttachments, readVerifiedSourceAttachment, stageImportedAttachment, verifySourceAttachments } from '../src/host/team-import-attachments.js'

const image = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png',
  bytes: 68, width: 1, height: 1, name: 'pixel.png' }
const file = { attachmentId: `sha256:${'b'.repeat(64)}`, name: 'notes.txt', bytes: 12 }

test('REQ-20261023-0001 inventories attachments across history without copying text', () => {
  const imageBlock = { type: 'image', attachment: image, offloaded: true }
  const fileBlock = { type: 'file', attachment: file }
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Secret chat' }, imageBlock, fileBlock] } },
    { type: 'tool/result', data: { result: { content: [imageBlock, { type: 'file', attachment: { ...file } }] } } },
  ]
  const before = structuredClone(events)
  const result = inventorySessionAttachments(events)
  assert.deepEqual(result, [{ type: 'file', ref: file }, { type: 'image', ref: image }])
  assert.deepEqual(events, before)
  assert.equal(JSON.stringify(result).includes('Secret chat'), false)
})

test('REQ-20261023-0001 rejects unknown, malformed and conflicting attachment references', () => {
  assert.throws(() => inventorySessionAttachments([{ data: { attachmentId: image.attachmentId } }]), /Unknown attachment/u)
  assert.throws(() => inventorySessionAttachments([{ data: { content: [
    { type: 'file', attachment: { ...file, name: '../private' } },
  ] } }]), /Invalid attachment/u)
  assert.throws(() => inventorySessionAttachments([{ data: { content: [
    { type: 'file', attachment: { ...file, localPath: '/private/secret' } },
  ] } }]), /Invalid attachment/u)
  assert.throws(() => inventorySessionAttachments([{ data: { content: [
    { type: 'image', attachment: { ...image, width: 0 } },
  ] } }]), /Invalid image/u)
  assert.throws(() => inventorySessionAttachments([{ data: { content: [
    { type: 'file', attachment: file }, { type: 'file', attachment: { ...file, bytes: 13 } },
  ] } }]), /Conflicting attachment/u)
})

test('REQ-20261023-0001 verifies image and streamed file bytes through DSH attachment APIs', async () => {
  const imageBytes = Buffer.from('image bytes')
  const fileBytes = Buffer.from('file bytes')
  const imageRef = { ...image, attachmentId: `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`, bytes: imageBytes.length }
  const fileRef = { ...file, attachmentId: `sha256:${createHash('sha256').update(fileBytes).digest('hex')}`, bytes: fileBytes.length }
  const ctx = { attachments: {
    readImage: async ref => ({ ref, data: imageBytes }),
    async *readFileStream() { yield fileBytes.subarray(0, 2); yield fileBytes.subarray(2) },
  } }
  const items = [{ type: 'image', ref: imageRef }, { type: 'file', ref: fileRef }]
  assert.deepEqual(await verifySourceAttachments(ctx, items), [
    { type: 'image', attachmentId: imageRef.attachmentId, bytes: imageBytes.length },
    { type: 'file', attachmentId: fileRef.attachmentId, bytes: fileBytes.length },
  ])
  await assert.rejects(verifySourceAttachments({ attachments: {
    ...ctx.attachments, readImage: async () => ({ ref: imageRef, data: Buffer.from('bad') }),
  } }, items), /Attachment bytes changed/u)
  await assert.rejects(verifySourceAttachments({ attachments: {
    ...ctx.attachments, async *readFileStream() { yield fileBytes.subarray(0, 2) },
  } }, [{ type: 'file', ref: fileRef }]), /Attachment bytes changed/u)
})

test('REQ-20261023-0001 streams bounded source bytes and rejects truncation before completion', async () => {
  const data = Buffer.alloc(70_000, 7)
  const sourceRef = { ...file, bytes: data.length,
    attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}` }
  const ctx = { attachments: { readImage: async () => null,
    async *readFileStream() { yield data } } }
  const chunks = []
  for await (const chunk of readVerifiedSourceAttachment(ctx, { type: 'file', ref: sourceRef })) {
    assert.ok(chunk.byteLength <= 32 * 1024)
    chunks.push(chunk)
  }
  assert.deepEqual(Buffer.concat(chunks), data)
  const broken = { attachments: { ...ctx.attachments,
    async *readFileStream() { yield data.subarray(0, data.length - 1) } } }
  await assert.rejects(async () => {
    for await (const chunk of readVerifiedSourceAttachment(broken, { type: 'file', ref: sourceRef })) {
      void chunk
    }
  }, /Source attachment bytes changed/u)
})

test('REQ-20261023-0001 stages target attachment bytes and records the actual target reference', async () => {
  const imageBytes = Buffer.from('source image')
  const fileBytes = Buffer.from('source file')
  const imageRef = { ...image, attachmentId: `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`, bytes: imageBytes.length }
  const fileRef = { ...file, attachmentId: `sha256:${createHash('sha256').update(fileBytes).digest('hex')}`, bytes: fileBytes.length }
  const targetImage = { ...imageRef, attachmentId: `sha256:${'c'.repeat(64)}` }
  const saved = []
  const ctx = { attachments: {
    saveImage: async input => { saved.push(input.data); return targetImage },
    saveFileStream: async input => {
      const chunks = []
      for await (const chunk of input.data) chunks.push(chunk)
      saved.push(Buffer.concat(chunks))
      return fileRef
    },
  } }
  const stagedImage = await stageImportedAttachment(ctx, { type: 'image', sourceRef: imageRef, data: imageBytes })
  assert.deepEqual(stagedImage.targetRef, targetImage)
  async function* fileStream() { yield fileBytes.subarray(0, 3); yield fileBytes.subarray(3) }
  const stagedFile = await stageImportedAttachment(ctx, { type: 'file', sourceRef: fileRef, data: fileStream() })
  assert.deepEqual(stagedFile.targetRef, fileRef)
  assert.deepEqual(saved, [imageBytes, fileBytes])
  await assert.rejects(stageImportedAttachment(ctx, { type: 'image', sourceRef: imageRef, data: Buffer.from('bad') }), /Source image bytes changed/u)
  async function* truncated() { yield fileBytes.subarray(0, 3) }
  await assert.rejects(stageImportedAttachment(ctx, { type: 'file', sourceRef: fileRef, data: truncated() }), /Source file bytes changed/u)
})
