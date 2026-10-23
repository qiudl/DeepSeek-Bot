// Stage one active chat without making it part of the DS Bot roster.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isAbsolute } from 'node:path'
import { remapSessionEvents } from './team-import-events.js'

/** A pending reservation must be inspected before a retry can create the same Session ID. */
export async function stageImportedAgent(ctx, { sourceId, plan, events, workspace, title, model, journal }) {
  const seed = remapSessionEvents(events, sourceId, plan, { active: true })
  const targetId = plan.sessions[sourceId]
  if (!workspace || !isAbsolute(workspace.path) || typeof workspace.attachSession !== 'function' ||
      typeof title !== 'string' || title.trim() === '' ||
      typeof model?.provider !== 'string' || model.provider.trim() === '' ||
      typeof model.model !== 'string' || model.model.trim() === '' ||
      !journal || !['reserve', 'complete', 'fail'].every(method => typeof journal[method] === 'function')) {
    throw new Error('Incomplete target Agent settings')
  }
  const presets = ctx.get?.('agentPresets') ?? ctx.agentPresets
  if (!presets || !(await presets.list()).some(preset => preset.id === 'standard' && preset.broken === undefined)) {
    throw new Error('Target standard Agent preset unavailable')
  }
  const eventDigest = createHash('sha256').update(JSON.stringify(seed)).digest('hex')
  await journal.reserve({ sourceId, targetId, eventDigest, sourceDigest: plan.sourceDigest, targetDigest: plan.targetDigest })
  try {
    const { agent } = await ctx.agents.create({
      sessionId: targetId,
      seed,
      meta: { cwd: workspace.path, agentPreset: 'standard' },
      setup: async scope => { await presets.mount(scope, 'standard') },
    })
    const actual = agent.session.snapshotEvents()
    if (!isDeepStrictEqual(actual.slice(0, seed.length), seed)) throw new Error('Seeded Agent history differs')
    await workspace.attachSession(targetId)
    await ctx.sessionTitle.rename(agent.session, title)
    await ctx.sessionController.selectModel({ sessionId: targetId, ...model })
    await ctx.sessions.flush(agent.session)
    await journal.complete(targetId)
    return targetId
  } catch (error) {
    await journal.fail(targetId)
    throw error
  }
}
