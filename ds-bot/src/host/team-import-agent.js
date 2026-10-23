// Stage one active chat without making it part of the DS Bot roster.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isAbsolute } from 'node:path'
import { remapSessionEvents } from './team-import-events.js'

/** A pending reservation must be inspected before a retry can create the same Session ID. */
export async function stageImportedAgent(ctx, { sourceId, plan, events, workspace, title, model, historyOnly = false, journal }) {
  if (typeof historyOnly !== 'boolean') throw new Error('Invalid Agent stage mode')
  const seed = remapSessionEvents(events, sourceId, plan, { active: !historyOnly })
  const targetId = plan.sessions[sourceId]
  const validModel = typeof model?.provider === 'string' && model.provider.trim() !== '' &&
    typeof model.model === 'string' && model.model.trim() !== ''
  if (!workspace || !isAbsolute(workspace.path) ||
      (!historyOnly && (typeof workspace.attachSession !== 'function' || !validModel)) ||
      (historyOnly && model !== undefined) ||
      typeof title !== 'string' || title.trim() === '' ||
      !journal || !['reserve', 'complete', 'fail'].every(method => typeof journal[method] === 'function')) {
    throw new Error('Incomplete target Agent settings')
  }
  const presets = ctx.get?.('agentPresets') ?? ctx.agentPresets
  if (!presets || !(await presets.list()).some(preset => preset.id === 'standard' && preset.broken === undefined)) {
    throw new Error('Target standard Agent preset unavailable')
  }
  const eventDigest = createHash('sha256').update(JSON.stringify(seed)).digest('hex')
  await journal.reserve({ sourceId, targetId, mode: historyOnly ? 'history' : 'active',
    eventDigest, sourceDigest: plan.sourceDigest, targetDigest: plan.targetDigest })
  try {
    const { agent } = await ctx.agents.create({
      sessionId: targetId,
      seed,
      meta: { cwd: workspace.path, agentPreset: 'standard' },
      setup: async scope => { await presets.mount(scope, 'standard') },
    })
    const actual = agent.session.snapshotEvents()
    if (!isDeepStrictEqual(actual.slice(0, seed.length), seed)) throw new Error('Seeded Agent history differs')
    if (!historyOnly) await workspace.attachSession(targetId)
    await ctx.sessionTitle.rename(agent.session, title)
    if (!historyOnly) await ctx.sessionController.selectModel({ sessionId: targetId, ...model })
    await ctx.sessions.flush(agent.session)
    await journal.complete(targetId)
    return targetId
  } catch (error) {
    await journal.fail(targetId)
    throw error
  }
}

/** DSH resolveAgent owns the write handle; callers must reuse that Agent, not resume it again. */
export async function verifyImportedAgent(ctx, { sourceId, plan, events, mode, eventDigest }) {
  if (!['active', 'history'].includes(mode) || !/^[0-9a-f]{64}$/u.test(eventDigest ?? '') ||
      typeof ctx?.sessionController?.resolveAgent !== 'function') throw new Error('Incomplete Agent verification')
  const seed = remapSessionEvents(events, sourceId, plan, { active: mode === 'active' })
  if (createHash('sha256').update(JSON.stringify(seed)).digest('hex') !== eventDigest) {
    throw new Error('Import source events changed')
  }
  const targetId = plan.sessions[sourceId]
  const resolved = await ctx.sessionController.resolveAgent(targetId)
  if (resolved?.error || resolved?.agent?.session?.id !== targetId ||
      typeof resolved.agent.session.snapshotEvents !== 'function') {
    throw new Error('Staged Agent unavailable')
  }
  const persisted = resolved.agent.session.snapshotEvents()
  if (!isDeepStrictEqual(persisted.slice(0, seed.length), seed)) {
    throw new Error('Staged Agent history differs')
  }
  return true
}
