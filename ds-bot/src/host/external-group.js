// Internal service for a Host adapter that has already authenticated the Slark
// Account and DSH Profile. Browser clients do not receive this service.
export function install(rt) {
  if (rt.config.slarkExternalGroup !== true) return
  rt.ctx.provide('dsBotSlarkExternalGroup', {
    async resolveLocalBot(botId) {
      if (typeof botId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(botId)) return null
      await rt.refresh()
      if (!rt.hasExclusiveWriter()) return null
      const bot = rt.botOf(botId)
      if (bot === undefined || bot.id !== botId ||
        typeof bot.name !== 'string' || bot.name.trim() === '') return null
      return { botId, actorRef: `deepseek-bot:${botId}`, displayName: bot.name }
    },
  })
}
