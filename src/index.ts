import { Context, Schema } from 'koishi'

export const name = 'message-relay'

export const inject = {
  optional: ['database'],
}

interface MonitoringRule {
  userId: string
  keywords: string[]
  relayTargetChannels: string[]
}
export interface Config {
  monitoringRules: MonitoringRule[]
  manualRelayAllowedChannels: string[]
  commandAuthLevel: number
  defaultPlatform: string
  debug: boolean
}
export const Config = Schema.intersect([
  Schema.object({
    monitoringRules: Schema.array(Schema.object({
      userId: Schema.string().description('被监控用户的完整 ID (需要带平台前缀，如 onebot:12345678)。'),
      keywords: Schema.array(Schema.string()).description('触发转发的关键词列表 (留空则转发该用户所有消息)。'),
      relayTargetChannels: Schema.array(Schema.string()).role('channel').description('该用户消息的目标转发频道列表 (需要带平台前缀，如 onebot:12345678)。'),
    })).role('table').description('用户监控规则列表。'),
  }).description('监控规则设置'),
  Schema.object({
    manualRelayAllowedChannels: Schema.array(Schema.string()).role('channel').default([]).description('允许「传话筒」指令手动转发的群组列表 (需要带平台前缀，如 onebot:12345678)。'),
    commandAuthLevel: Schema.number().min(0).max(5).default(3).description('能够使用「传话筒」指令的最低权限等级。'),
    defaultPlatform: Schema.string().default('onebot').description('手动传话时，默认使用的平台名称。'),
  }).description('手动指令设置'),
  Schema.object({
    debug: Schema.boolean().default(false).description('启用后，将在控制台输出详细的调试日志。'),
  }).description('高级设置'),
])

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('message-relay')
  logger.info('传声筒插件已启动。')


  const middlewareDispose = ctx.middleware(async (session, next) => {
    await next()
    const currentConfig = ctx.config
    const fullSessionUserId = `${session.platform}:${session.userId}`
    const matchedRule = currentConfig.monitoringRules.find(rule => rule.userId === fullSessionUserId)
    if (!matchedRule) return
    const hasKeyword = matchedRule.keywords.length === 0 || matchedRule.keywords.some(kw => session.content.includes(kw))
    if (!hasKeyword) return
    let sourceSenderDisplayName = session.username
    try {
      const member = await session.bot.getGuildMember(session.guildId, session.userId)
      if (member?.name) sourceSenderDisplayName = member.name
      else if (member?.nick) sourceSenderDisplayName = member.nick
    } catch (error) {
      if (ctx.config.debug) logger.warn(`(自动监控) 获取源群聊 ${session.guildId} 的昵称失败:`, error)
    }
    const fullSessionChannelId = `${session.platform}:${session.channelId}`
    const finalTargets = matchedRule.relayTargetChannels.filter(ch => ch !== fullSessionChannelId)
    if (finalTargets.length === 0) return
    if (ctx.config.debug) logger.info(`匹配到规则 (用户: ${matchedRule.userId})，准备为 ${finalTargets.length} 个目标频道分别生成消息...`)
    let successCount = 0
    for (const targetChannelId of finalTargets) {
      let targetSenderDisplayName = sourceSenderDisplayName
      try {
        const plainTargetId = targetChannelId.split(':')[1] || targetChannelId
        const targetMember = await session.bot.getGuildMember(plainTargetId, session.userId)
        if (targetMember?.name) targetSenderDisplayName = targetMember.name
        else if (targetMember?.nick) targetSenderDisplayName = targetMember.nick
      } catch (error) {
        if (ctx.config.debug) logger.info(`无法获取用户在目标频道 ${targetChannelId} 的昵称，将使用源群聊昵称。`)
      }
      const messageForThisChannel = `${targetSenderDisplayName}：${session.content}`
      try {
        const sentMessageIds = await ctx.broadcast([targetChannelId], messageForThisChannel)
        if (sentMessageIds.length > 0) {
          if (ctx.config.debug) logger.info(`[成功] 已将消息转发到 ${targetChannelId}`)
          successCount++
        } else {
          logger.warn(`[失败] 转发到频道 ${targetChannelId} 失败（Broadcast未返回ID）。`)
        }
      } catch (error) {
        logger.error(`[失败] 转发到频道 ${targetChannelId} 时发生错误:`, error)
      }
    }
    if (ctx.config.debug) logger.info(`转发任务完成: 成功 ${successCount}/${finalTargets.length}。`)
  })
  
  ctx.on('dispose', () => {
    middlewareDispose()
    logger.info('传声筒插件中间件已卸载。')
  })

  ctx.command('传话筒 <target:string> <content:text>', '手动发送消息到指定群聊', { authority: config.commandAuthLevel })
    .action(async ({ session }, rawTarget, content) => {
        if (!content) return '错误：发言内容不能为空。'
        let resolvedChannelId: string = null
        const index = parseInt(rawTarget, 10);
        if (!isNaN(index) && index > 0 && index <= ctx.config.manualRelayAllowedChannels.length) {
          resolvedChannelId = ctx.config.manualRelayAllowedChannels[index - 1];
        }
        if (!resolvedChannelId) {
          for (const groupId of ctx.config.manualRelayAllowedChannels) {
            try {
              const plainGroupId = groupId.split(':')[1] || groupId
              const guild = await session.bot.getGuild(plainGroupId);
              if (guild.name === rawTarget) {
                resolvedChannelId = groupId;
                break;
              }
            } catch {}
          }
        }
        if (!resolvedChannelId) {
            resolvedChannelId = rawTarget.includes(':') ? rawTarget : `${ctx.config.defaultPlatform}:${rawTarget}`
        }
        if (!ctx.config.manualRelayAllowedChannels.includes(resolvedChannelId)) {
          return `错误：找不到目标 "${rawTarget}" 或该目标不在允许传话的列表中。`
        }
        let senderDisplayName = session.username
        try {
          const plainTargetId = resolvedChannelId.split(':')[1] || resolvedChannelId
          const member = await session.bot.getGuildMember(plainTargetId, session.userId)
          if (member?.name) senderDisplayName = member.name
          else if (member?.nick) senderDisplayName = member.nick
        } catch (error) {
          if (ctx.config.debug) logger.warn(`(手动传话) 获取用户 ${session.userId} 在目标群聊 ${resolvedChannelId} 的昵称失败:`, error)
        }
        const manualMessage = `[传话筒 | 来自: ${senderDisplayName}] \n${content}`
        try {
          const sentMessageIds = await ctx.broadcast([resolvedChannelId], manualMessage)
          if (sentMessageIds.length > 0) return '消息已成功送达！'
          else throw new Error('Broadcast failed to send message.')
        } catch (error) {
          logger.error(`[失败] 手动传话到频道 ${resolvedChannelId} 失败:`, error)
          return `发送失败。请检查频道ID是否正确、机器人是否在该群聊中，或查看控制台日志。`
        }
    })

  ctx.command('支持的群聊', '显示传话筒功能支持的群聊列表')
    .action(async ({ session }) => {
        if (!ctx.config.manualRelayAllowedChannels.length) {
            return '当前没有配置任何支持手动传话的群聊。'
        }
        let response = '「传话筒」指令目前支持以下群聊 (可通过序号、群名称或群号传话)：\n'
        const listItems: string[] = []
        for (const [index, groupId] of ctx.config.manualRelayAllowedChannels.entries()) {
            try {
                const plainGroupId = groupId.split(':')[1] || groupId
                const guild = await session.bot.getGuild(plainGroupId) 
                listItems.push(`${index + 1}. ${guild.name} (${groupId})`)
            } catch {
                listItems.push(`${index + 1}. (信息获取失败) (${groupId})`)
            }
        }
        return response + listItems.join('\n')
    })
}