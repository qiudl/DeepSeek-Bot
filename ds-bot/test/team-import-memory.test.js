import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { inventoryTeamMemory } from '../src/host/team-import-memory.js'
import { stageTeamMemory } from '../src/host/team-import-memory-stage.js'
import { teamStateDigest } from '../src/host/team-import-plan.js'

const bot = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const room = 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const mappedBot = 'session-cccccccc-cccc-cccc-cccc-cccccccccccc'
const mappedRoom = 'session-dddddddd-dddd-dddd-dddd-dddddddddddd'
const source = { version: 1, bots: { [bot]: { id: bot } }, rooms: { [room]: { id: room } } }
const plan = { sessions: { [bot]: mappedBot, [room]: mappedRoom },
  sourceDigest: teamStateDigest(source), targetDigest: 'b'.repeat(64) }

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

test('REQ-20261023-0001 stages exact memory bytes outside the live team and blocks repeated staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-memory-stage-'))
  try {
    const sourceRoot = join(root, 'source')
    const liveRoot = join(root, 'live')
    const stageRoot = join(root, 'private', 'stage-1')
    await mkdir(join(sourceRoot, 'bots', bot), { recursive: true })
    await mkdir(join(sourceRoot, 'groups', room), { recursive: true })
    await mkdir(join(sourceRoot, 'team'), { recursive: true })
    await mkdir(liveRoot)
    await mkdir(dirname(stageRoot), { recursive: true, mode: 0o700 })
    const body = Buffer.from('# Memory\n\n- Knows a private fact\n', 'utf8')
    await writeFile(join(sourceRoot, 'bots', bot, 'MEMORY.md'), body)
    await writeFile(join(sourceRoot, 'groups', room, 'MEMORY.md'), '# Memory\n\n- Group fact\n')
    await writeFile(join(sourceRoot, 'team', 'MEMORY.md'), '# Memory\n\n- Team fact\n')
    const manifest = await inventoryTeamMemory(sourceRoot, source, plan)
    const result = await stageTeamMemory({ sourceRoot, targetRoot: liveRoot, stageRoot, source, plan, manifest })
    assert.equal(result.files, 3)
    assert.deepEqual(await readFile(join(stageRoot, 'files', 'bots', mappedBot, 'MEMORY.md')), body)
    assert.match(await readFile(join(stageRoot, 'files', 'groups', mappedRoom, 'MEMORY.md'), 'utf8'), /Group fact/u)
    assert.match(await readFile(join(stageRoot, 'files', 'team', 'MEMORY.md'), 'utf8'), /Team fact/u)
    assert.equal(JSON.parse(await readFile(join(stageRoot, 'manifest.json'), 'utf8')).status, 'staged')
    assert.equal((await stat(stageRoot)).mode & 0o777, 0o700)
    assert.deepEqual(await readdir(liveRoot), [])
    await assert.rejects(stageTeamMemory({ sourceRoot, targetRoot: liveRoot, stageRoot, source, plan, manifest }), /already exists/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('REQ-20261023-0001 rejects changed source memory before staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-memory-stage-'))
  try {
    const sourceRoot = join(root, 'source'), targetRoot = join(root, 'live'), stageRoot = join(root, 'private', 'stage-2')
    await mkdir(join(sourceRoot, 'team'), { recursive: true })
    await mkdir(targetRoot)
    await mkdir(dirname(stageRoot), { recursive: true, mode: 0o700 })
    await writeFile(join(sourceRoot, 'team', 'MEMORY.md'), '# Memory\n')
    const manifest = await inventoryTeamMemory(sourceRoot, source, plan)
    await writeFile(join(sourceRoot, 'team', 'MEMORY.md'), '# Changed\n')
    await assert.rejects(stageTeamMemory({ sourceRoot, targetRoot, stageRoot, source, plan, manifest }), /Source memory changed/u)
    await assert.rejects(stat(stageRoot), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('REQ-20261023-0001 binds staged memory to the source team revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-memory-stage-'))
  try {
    const sourceRoot = join(root, 'source'), targetRoot = join(root, 'live'), stageRoot = join(root, 'private', 'stage-3')
    await mkdir(sourceRoot)
    await mkdir(targetRoot)
    await mkdir(dirname(stageRoot), { recursive: true, mode: 0o700 })
    const manifest = await inventoryTeamMemory(sourceRoot, source, plan)
    await assert.rejects(stageTeamMemory({ sourceRoot, targetRoot, stageRoot,
      source: { ...source, revision: 99 }, plan, manifest }), /Source team changed/u)
    await assert.rejects(stat(stageRoot), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('REQ-20261023-0001 refuses a staging parent linked into the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-memory-stage-'))
  try {
    const sourceRoot = join(root, 'source'), targetRoot = join(root, 'live'), stageRoot = join(root, 'linked', 'stage-4')
    await mkdir(sourceRoot)
    await mkdir(targetRoot)
    await symlink(sourceRoot, dirname(stageRoot))
    const manifest = await inventoryTeamMemory(sourceRoot, source, plan)
    await assert.rejects(stageTeamMemory({ sourceRoot, targetRoot, stageRoot, source, plan, manifest }), /private directory/u)
    assert.deepEqual(await readdir(sourceRoot), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('REQ-20261023-0001 refuses a staging directory inside live memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-memory-stage-'))
  try {
    const sourceRoot = join(root, 'source'), targetRoot = join(root, 'live')
    const stageRoot = join(targetRoot, 'imports', 'stage-5')
    await mkdir(sourceRoot)
    await mkdir(dirname(stageRoot), { recursive: true })
    const manifest = await inventoryTeamMemory(sourceRoot, source, plan)
    await assert.rejects(stageTeamMemory({ sourceRoot, targetRoot, stageRoot, source, plan, manifest }),
      /Invalid memory staging location/u)
    assert.deepEqual(await readdir(dirname(stageRoot)), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
