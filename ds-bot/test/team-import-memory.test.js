import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { inventoryTeamMemory } from '../src/host/team-import-memory.js'

const bot = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const room = 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const mappedBot = 'session-cccccccc-cccc-cccc-cccc-cccccccccccc'
const mappedRoom = 'session-dddddddd-dddd-dddd-dddd-dddddddddddd'
const source = { version: 1, bots: { [bot]: { id: bot } }, rooms: { [room]: { id: room } } }
const plan = { sessions: { [bot]: mappedBot, [room]: mappedRoom } }

test('REQ-20261023-0001 inventories durable Bot, group and team memory without reading derived snapshots as facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-memory-inventory-'))
  try {
    for (const dir of [`bots/${bot}`, `groups/${room}`, 'team', 'snapshots']) await mkdir(join(root, dir), { recursive: true })
    await writeFile(join(root, 'bots', bot, 'MEMORY.md'), '# Memory\n')
    await writeFile(join(root, 'groups', room, 'project.md'), '- Shared fact\n')
    await writeFile(join(root, 'team', 'MEMORY.md'), '- Team fact\n')
    await writeFile(join(root, 'snapshots', `${bot}.md`), 'old frozen prompt')
    await writeFile(join(root, 'reviewed.json'), JSON.stringify({ [`chat:${bot}`]: 2 }))
    const before = await readFile(join(root, 'groups', room, 'project.md'))
    const files = await inventoryTeamMemory(root, source, plan)
    assert.deepEqual(files.map(file => file.target).sort(), [
      `bots/${mappedBot}/MEMORY.md`, `groups/${mappedRoom}/project.md`, 'team/MEMORY.md',
    ].sort())
    assert.equal(files.find(file => file.source === `groups/${room}/project.md`).sha256,
      createHash('sha256').update(before).digest('hex'))
    assert.deepEqual(await readFile(join(root, 'groups', room, 'project.md')), before)
    assert.equal(files.some(file => /snapshot|reviewed/u.test(file.source)), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('REQ-20261023-0001 refuses linked and orphan memory scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-memory-inventory-'))
  try {
    await mkdir(join(root, 'bots', bot), { recursive: true })
    await symlink(join(root, 'secret'), join(root, 'bots', bot, 'MEMORY.md'))
    await assert.rejects(inventoryTeamMemory(root, source, plan), /symbolic link/u)
    await rm(join(root, 'bots', bot, 'MEMORY.md'))
    await mkdir(join(root, 'bots', room))
    await assert.rejects(inventoryTeamMemory(root, source, plan), /Orphan memory scope/u)
    await rm(join(root, 'bots'), { recursive: true })
    await symlink(join(root, 'team'), join(root, 'bots'))
    await assert.rejects(inventoryTeamMemory(root, source, plan), /regular directory/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('REQ-20261023-0001 refuses two memory scopes mapped to one target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-memory-inventory-'))
  try {
    await assert.rejects(inventoryTeamMemory(root, source, {
      sessions: { [bot]: mappedBot, [room]: mappedBot },
    }), /Duplicate target memory scope/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})
