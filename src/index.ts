import { Context, Schema, h } from 'koishi'

export const name = 'message-relay'

export const inject = {
  optional: ['database'],
}

interface MonitoringRule {
  userId: string
  keywords: string[]
  relayTargetChannels: string[]
}

interface QuotedRelayRule {
  commandName: string
  targetChannels: string[]
  excludeSource: boolean
  showSuccessMessage: boolean
  showOriginalSender: boolean
}

export interface Config {
  monitoringRules: MonitoringRule[]
  manualRelayAllowedChannels: string[]
  commandAuthLevel: number
  defaultPlatform: string
  debug: boolean
  // 引用转发设置
  quotedRelayEnabled: boolean
  quotedRelayAuthLevel: number
  quotedRelayRules: QuotedRelayRule[]
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
    quotedRelayEnabled: Schema.boolean().default(false).description('是否启用引用转发功能。'),
    quotedRelayAuthLevel: Schema.number().min(0).max(5).default(3).description('能够使用引用转发指令的最低权限等级。'),
    quotedRelayRules: Schema.array(Schema.object({
      commandName: Schema.string().description('指令名称。'),
      targetChannels: Schema.array(Schema.string()).role('channel').description('该指令对应的目标群组列表 (需要带平台前缀，如 onebot:12345678)。'),
      excludeSource: Schema.boolean().default(true).description('是否排除消息来源群聊（避免转发回同一群）。'),
      showSuccessMessage: Schema.boolean().default(true).description('转发完成后是否发送转发成功消息。'),
      showOriginalSender: Schema.boolean().default(true).description('是否显示原消息发送者的昵称。'),
    })).role('table').default([]).description('引用转发指令规则列表。'),
  }).description('引用转发设置'),
  Schema.object({
    debug: Schema.boolean().default(false).description('启用后，将在控制台输出详细的调试日志。'),
  }).description('高级设置'),
])

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('message-relay')
  logger.info('传声筒插件已启动。')

  // MIME类型检测函数
  function getMimeType(buffer: Buffer): string {
    if (buffer.length < 4) return 'application/octet-stream'
    
    const header = buffer.toString('hex', 0, 4)
    if (header.startsWith('89504e47')) return 'image/png'
    if (header.startsWith('ffd8ff')) return 'image/jpeg'
    if (header.startsWith('47494638')) return 'image/gif'
    if (buffer.toString('ascii', 0, 4) === 'RIFF') return 'image/webp'
    
    // 视频格式检测
    if (header.startsWith('00000020') || header.startsWith('00000018')) return 'video/mp4'
    if (header.startsWith('1a45dfa3')) return 'video/webm'
    
    // 音频格式检测
    if (header.startsWith('494433') || header.startsWith('fff3') || header.startsWith('fff2')) return 'audio/mpeg'
    if (header.startsWith('4f676753')) return 'audio/ogg'
    
    return 'application/octet-stream'
  }

  // 元素检查函数
  function hasFileElement(elements: any[]): boolean {
    if (!Array.isArray(elements)) return false
    return elements.some(el => {
      const type = el?.type || el?.name
      return type === 'file'
    })
  }

  function hasAudioElement(elements: any[]): boolean {
    if (!Array.isArray(elements)) return false
    return elements.some(el => {
      const type = el?.type || el?.name
      return ['audio', 'record'].includes(type)
    })
  }

  function hasMfaceElement(elements: any[]): boolean {
    if (!Array.isArray(elements)) return false
    return elements.some(el => {
      const type = el?.type || el?.name
      return type === 'mface'
    })
  }

  function hasMediaElement(elements: any[]): boolean {
    if (!Array.isArray(elements)) return false
    return elements.some(el => {
      const type = el?.type || el?.name
      return ['img', 'image', 'video'].includes(type) // 移除 audio 和 record
    })
  }

  // 当 content 为空时，从 elements 兜底生成可读文本
  function stringifyElementsAsText(elements: any[]): string {
    if (!Array.isArray(elements)) return ''
    const parts: string[] = []
    for (const el of elements) {
      const type = el?.type || el?.name
      const attrs = el?.attrs || el || {}
      switch (type) {
        case 'text':
          parts.push(attrs.content ?? (Array.isArray(el.children) ? el.children.join('') : '') ?? '')
          break
        case 'at':
          parts.push(`@${attrs.name || attrs.id || attrs.qq || ''}`)
          break
        case 'img':
        case 'image':
          parts.push('[图片]')
          break
        case 'video':
          parts.push('[视频]')
          break
        case 'audio':
        case 'record':
          parts.push('[语音]')
          break
        case 'file':
          parts.push(`[文件${attrs.name ? '：' + attrs.name : ''}]`)
          break
        case 'face':
          parts.push(`[表情${attrs.id ?? ''}]`)
          break
        case 'mface':
          parts.push(attrs.summary || '[表情包]')
          break
        case 'json':
          parts.push('[小程序]')
          break
        case 'forward':
          parts.push('[合并转发]')
          break
        default:
          if (Array.isArray(el?.children) && el.children.length) {
            parts.push(stringifyElementsAsText(el.children))
          } else if (attrs?.text) {
            parts.push(attrs.text)
          } else if (type) {
            parts.push(`[${type}]`)
          }
          break
      }
    }
    return parts.join('')
  }


  const middlewareDispose = ctx.middleware(async (session, next) => {
    await next()
    const currentConfig = ctx.config
    const fullSessionUserId = `${session.platform}:${session.userId}`
    const matchedRule = currentConfig.monitoringRules.find(rule => rule.userId === fullSessionUserId)
    if (!matchedRule) return
    
    // 生成完整消息文本用于关键词匹配
    const messageText = session.content || stringifyElementsAsText(session.elements)
    const hasKeyword = matchedRule.keywords.length === 0 || matchedRule.keywords.some(kw => messageText.includes(kw))
    if (!hasKeyword) return
    
    // 检查是否有文件或语音，如果有则不进行转发
    if (hasFileElement(session.elements) || hasAudioElement(session.elements)) {
      return // 有文件或语音的消息不转发
    }
    
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
      
      try {
        // 检查是否有媒体内容需要特殊处理
        if (hasMfaceElement(session.elements) || hasMediaElement(session.elements)) {
          // 处理媒体内容
          const processedElements = []
          const usernameElement = h.text(`${targetSenderDisplayName}：`)
          processedElements.push(usernameElement)
          
          for (const element of session.elements) {
            const type = element?.type
            const attrs = element?.attrs || {}
            
            if (type === 'mface' && (attrs as any).url) {
              try {
                const response = await ctx.http.get((attrs as any).url, { responseType: 'arraybuffer' })
                const buffer = Buffer.from(response)
                const mimeType = getMimeType(buffer)
                const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
                processedElements.push(h.image(dataUrl))
              } catch (err) {
                logger.warn(`下载表情包失败: ${err.message}`)
                processedElements.push(h.text((attrs as any).summary || '[表情包]'))
              }
            } else if (['img', 'image', 'video'].includes(type) && (attrs as any).src) {
              try {
                const response = await ctx.http.get((attrs as any).src, { responseType: 'arraybuffer' })
                const buffer = Buffer.from(response)
                const mimeType = getMimeType(buffer)
                const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
                
                if (type === 'video') {
                  processedElements.push(h.video(dataUrl))
                } else {
                  processedElements.push(h.image(dataUrl))
                }
              } catch (err) {
                logger.warn(`下载媒体失败: ${err.message}`)
                processedElements.push(h.text(`[${type}]`))
              }
            } else {
              processedElements.push(element)
            }
          }
          
          const plainTargetId = targetChannelId.split(':')[1] || targetChannelId
          await session.bot.sendMessage(plainTargetId, processedElements)
        } else {
          // 普通消息直接发送文本
          const messageForThisChannel = `${targetSenderDisplayName}：${messageText}`
          const sentMessageIds = await ctx.broadcast([targetChannelId], messageForThisChannel)
          if (sentMessageIds.length === 0) {
            logger.warn(`[失败] 转发到频道 ${targetChannelId} 失败（Broadcast未返回ID）。`)
            continue
          }
        }
        
        if (ctx.config.debug) logger.info(`[成功] 已将消息转发到 ${targetChannelId}`)
        successCount++
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

  // 新增：引用转发命令（支持多个指令，每个有独立配置）
  if (config.quotedRelayEnabled && config.quotedRelayRules.length > 0) {
    for (const rule of config.quotedRelayRules) {
      ctx.command(rule.commandName + ' [content:text]', '将引用/回复的那条消息转发到已配置的群组，或直接转发输入的内容', { authority: config.quotedRelayAuthLevel })
        .action(async ({ session }, content) => {
          const quoted: any = (session as any).quote
          let messageToSend: string = ''
          let originalUserId: string = session.userId
          let sourceDisplayName: string = session.username
          let isQuotedMessage = false

          if (quoted) {
            // 引用模式：转发被引用的消息
            isQuotedMessage = true
            
            // 详细日志：输出quoted对象的所有信息
            if (ctx.config.debug) {
              logger.info('=== 引用消息调试信息 ===')
              logger.info('quoted对象:', JSON.stringify(quoted, null, 2))
              logger.info('quoted.content:', quoted.content)
              logger.info('quoted.elements:', quoted.elements)
              logger.info('quoted类型:', typeof quoted)
              if (quoted.elements) {
                logger.info('elements详情:')
                quoted.elements.forEach((element, index) => {
                  logger.info(`  元素${index}:`, JSON.stringify(element, null, 2))
                })
              }
              logger.info('=== 引用消息调试信息结束 ===')
            }
            
            // 获取被引用消息发送者信息
            originalUserId = quoted.userId ?? quoted?.author?.userId ?? quoted?.user?.id ?? session.userId
            sourceDisplayName = quoted?.username ?? quoted?.author?.name ?? quoted?.user?.name ?? session.username
            
            // 直接使用原始消息内容，包括合并转发消息
            try {
              messageToSend = (quoted.content ?? '').toString().trim()
            } catch {}
            
            if (ctx.config.debug) {
              logger.info(`提取的messageToSend: "${messageToSend}"`)
              logger.info(`messageToSend长度: ${messageToSend.length}`)
            }
            
            if (!messageToSend) {
              return '错误：引用的消息没有可转发的内容。'
            }
          } else if (content) {
            // 直接模式：转发输入的内容
            messageToSend = content.trim()
            if (!messageToSend) {
              return '错误：输入的内容不能为空。'
            }
            // 使用当前用户信息
            originalUserId = session.userId
            sourceDisplayName = session.username
          } else {
            return '请先引用（回复）一条消息再使用该指令，或直接输入要转发的内容。'
          }

          // 获取发送者在源群的显示名（如果启用显示原发送者）
          if (rule.showOriginalSender) {
            try {
              const member = await session.bot.getGuildMember(session.guildId, originalUserId)
              if (member?.name) sourceDisplayName = member.name
              else if (member?.nick) sourceDisplayName = member.nick
            } catch (error) {
              if (ctx.config.debug) logger.warn(`(引用转发) 获取源群聊昵称失败:`, error)
            }
          }

          // 计算目标频道（可选排除来源群）
          const fullSourceChannelId = `${session.platform}:${session.channelId}`
          const targets = (rule.targetChannels ?? []).filter(ch =>
            rule.excludeSource ? ch !== fullSourceChannelId : true
          )
          if (!targets.length) return '尚未配置任何目标群组，或仅剩来源群聊被排除。'

          if (ctx.config.debug) logger.info(`(引用转发) 指令 "${rule.commandName}" 准备转发消息到 ${targets.length} 个目标频道...`)
          if (ctx.config.debug) logger.info(`待转发的消息内容: "${messageToSend}"`)
          let successCount = 0
          for (const targetChannelId of targets) {
            let finalMessage: string
            
            if (rule.showOriginalSender) {
              // 尝试获取该用户在目标群的昵称
              let targetDisplayName = sourceDisplayName
              try {
                const plainTargetId = targetChannelId.split(':')[1] || targetChannelId
                const targetMember = await session.bot.getGuildMember(plainTargetId, originalUserId)
                if (targetMember?.name) targetDisplayName = targetMember.name
                else if (targetMember?.nick) targetDisplayName = targetMember.nick
              } catch (error) {
                if (ctx.config.debug) logger.info(`(引用转发) 无法获取用户在目标频道 ${targetChannelId} 的昵称，将使用源群聊昵称。`)
              }
              finalMessage = `${targetDisplayName}：${messageToSend}`
            } else {
              // 不显示发送者，直接发送内容
              finalMessage = messageToSend
            }

            if (ctx.config.debug) logger.info(`向频道 ${targetChannelId} 发送的最终消息: "${finalMessage}"`)

            try {
              // 对于引用的消息，如果是合并转发等特殊消息，使用OneBot API获取内容
              if (isQuotedMessage && quoted.elements && quoted.elements.length > 0) {
                if (ctx.config.debug) logger.info(`检测到引用消息有elements，尝试特殊消息处理...`)
                
                // 检查是否包含特殊元素
                const hasForwardElement = quoted.elements.some(el => el.type === 'forward')
                const hasJsonElement = quoted.elements.some(el => el.type === 'json')
                const hasFileElement = quoted.elements.some(el => el.type === 'file')
                const hasAudioElement = quoted.elements.some(el => ['audio', 'record'].includes(el.type))
                const hasMfaceElement = quoted.elements.some(el => el.type === 'mface') // 表情包
                const hasMediaElement = quoted.elements.some(el => ['img', 'image', 'video'].includes(el.type))
                
                // 处理文件消息 - 直接提示无法转发
                if (hasFileElement) {
                  if (ctx.config.debug) logger.info(`检测到文件元素，提示无法转发`)
                  
                  const fileElement = quoted.elements.find(el => el.type === 'file')
                  const fileName = fileElement?.attrs?.file || fileElement?.attrs?.src || '未知文件'
                  const fileSize = fileElement?.attrs?.fileSize
                  
                  // 格式化文件大小
                  let formattedSize = '未知大小'
                  if (fileSize && !isNaN(Number(fileSize))) {
                    const sizeInBytes = Number(fileSize)
                    if (sizeInBytes >= 1024 * 1024) {
                      formattedSize = `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`
                    } else if (sizeInBytes >= 1024) {
                      formattedSize = `${(sizeInBytes / 1024).toFixed(2)} KB`
                    } else {
                      formattedSize = `${sizeInBytes} B`
                    }
                  }
                  
                  // 直接返回提示消息，不转发
                  return `⚠️ 检测到文件消息，暂不支持转发\n📁 文件: ${fileName}\n📏 大小: ${formattedSize}`
                }
                
                // 处理语音消息 - 直接提示无法转发
                if (hasAudioElement) {
                  if (ctx.config.debug) logger.info(`检测到语音元素，提示无法转发`)
                  
                  const audioElement = quoted.elements.find(el => ['audio', 'record'].includes(el.type))
                  const fileName = audioElement?.attrs?.file || '未知语音文件'
                  const fileSize = audioElement?.attrs?.fileSize
                  
                  // 格式化文件大小
                  let formattedSize = '未知大小'
                  if (fileSize && !isNaN(Number(fileSize))) {
                    const sizeInBytes = Number(fileSize)
                    if (sizeInBytes >= 1024 * 1024) {
                      formattedSize = `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`
                    } else if (sizeInBytes >= 1024) {
                      formattedSize = `${(sizeInBytes / 1024).toFixed(2)} KB`
                    } else {
                      formattedSize = `${sizeInBytes} B`
                    }
                  }
                  
                  // 直接返回提示消息，不转发
                  return `🔇 检测到语音消息，暂不支持转发\n🎵 文件: ${fileName}\n📏 大小: ${formattedSize}`
                }
                
                // 处理表情包和富媒体消息
                if (hasMfaceElement || hasMediaElement) {
                  if (ctx.config.debug) logger.info(`检测到表情包或富媒体元素，尝试下载并重新发送...`)
                  
                  try {
                    const plainTargetId = targetChannelId.split(':')[1] || targetChannelId
                    
                    // 构造完整消息内容
                    let messagesToSend = []
                    
                    // 添加发送者信息（如果需要）
                    if (rule.showOriginalSender) {
                      let targetDisplayName = sourceDisplayName
                      try {
                        const targetMember = await session.bot.getGuildMember(plainTargetId, originalUserId)
                        if (targetMember?.name) targetDisplayName = targetMember.name
                        else if (targetMember?.nick) targetDisplayName = targetMember.nick
                      } catch (error) {
                        if (ctx.config.debug) logger.info(`无法获取目标群昵称，使用源群昵称`)
                      }
                      messagesToSend.push(h('text', { content: `${targetDisplayName}：` }))
                    }
                    
                    // 处理所有元素，组合成完整消息
                    for (const element of quoted.elements) {
                      if (element.type === 'text') {
                        // 添加文本内容
                        if (element.attrs?.content) {
                          messagesToSend.push(h('text', { content: element.attrs.content }))
                        }
                      } else if (['mface', 'img', 'image', 'video'].includes(element.type)) {
                        try {
                          // 获取媒体URL
                          let url = element.attrs?.url || element.attrs?.src
                          if (!url) {
                            if (ctx.config.debug) logger.warn(`元素缺少URL: ${element.type}`)
                            // 添加占位符文本
                            messagesToSend.push(h('text', { content: `[${element.type}]` }))
                            continue
                          }
                          
                          if (ctx.config.debug) logger.info(`开始下载: ${element.type}, URL: ${url}`)
                          
                          // 下载媒体文件
                          const response = await ctx.http.get(url, { responseType: 'arraybuffer', timeout: 15000 })
                          const buffer = Buffer.from(response)
                          
                          // 检测MIME类型
                          const mime = getMimeType(buffer)
                          
                          if (ctx.config.debug) logger.info(`下载完成: ${mime}, 大小: ${buffer.length}`)
                          
                          // 添加媒体内容
                          if (element.type === 'mface' || element.type === 'img' || element.type === 'image') {
                            messagesToSend.push(h('img', { src: `data:${mime};base64,${buffer.toString('base64')}` }))
                          } else if (element.type === 'video') {
                            messagesToSend.push(h('video', { src: `data:${mime};base64,${buffer.toString('base64')}` }))
                          }
                          
                        } catch (err) {
                          logger.warn(`下载${element.type}失败: ${err.message}`)
                          // 添加错误占位符
                          messagesToSend.push(h('text', { content: `[${element.type}-下载失败]` }))
                        }
                      } else {
                        // 其他类型元素直接添加
                        messagesToSend.push(element)
                      }
                    }
                    
                    // 一次性发送完整消息
                    const result = await session.bot.sendMessage(plainTargetId, messagesToSend)
                    if (ctx.config.debug) logger.info(`完整消息发送结果:`, JSON.stringify(result, null, 2))
                    
                    if (result && result.length > 0) {
                      successCount++
                      if (ctx.config.debug) logger.info(`[成功] 完整消息已转发到 ${targetChannelId}`)
                      continue
                    }
                    
                  } catch (error) {
                    if (ctx.config.debug) logger.error(`媒体转发失败: ${error}`)
                    // 失败时继续使用文本转发作为兜底
                  }
                }
                
                if (hasForwardElement) {
                  if (ctx.config.debug) logger.info(`检测到forward元素，使用OneBot API获取合并转发内容...`)
                  
                  try {
                    // 检查平台兼容性
                    if (!['qq', 'onebot'].includes(session.platform)) {
                      if (ctx.config.debug) logger.warn(`平台 ${session.platform} 可能不支持OneBot API，尝试发送...`)
                    }
                    
                    const plainTargetId = targetChannelId.split(':')[1] || targetChannelId
                    
                    // 查找forward元素中的id
                    const forwardElement = quoted.elements.find(el => el.type === 'forward')
                    const forwardId = forwardElement?.attrs?.id
                    
                    if (!forwardId) {
                      if (ctx.config.debug) logger.warn(`未找到forward消息ID，跳过OneBot API处理`)
                    } else {
                      if (ctx.config.debug) logger.info(`找到forward ID: ${forwardId}，调用OneBot API...`)
                      
                      // 使用OneBot API获取合并转发消息内容
                      let forwardData
                      try {
                        // 尝试通过bot的OneBot适配器调用API
                        if (session.bot.platform === 'onebot') {
                          // @ts-ignore
                          forwardData = await session.bot.internal?.getForwardMsg?.(forwardId)
                        } else if (session.bot.platform === 'qq') {
                          // 对于QQ官方bot，可能需要不同的API调用方式
                          // @ts-ignore  
                          forwardData = await session.bot.internal?.getForwardMsg?.(forwardId)
                        }
                      } catch (apiError) {
                        if (ctx.config.debug) logger.warn(`调用API失败: ${apiError}`)
                      }
                      
                      if (ctx.config.debug) {
                        logger.info(`OneBot getForwardMsg 返回数据:`, JSON.stringify(forwardData, null, 2))
                      }
                      
                      if (forwardData && Array.isArray(forwardData)) {
                        if (ctx.config.debug) logger.info(`成功获取到 ${forwardData.length} 条合并转发消息`)
                        
                        // 构造Koishi格式的合并转发消息
                        const messageNodes = []
                        
                        // 将OneBot格式的消息转换为Koishi格式
                        for (const msg of forwardData) {
                          // 处理消息内容，OneBot返回的是content数组格式
                          const messageElements = []
                          if (Array.isArray(msg.content)) {
                            // 处理content数组中的各种元素
                            for (const segment of msg.content) {
                              if (segment.type === 'text' && segment.data?.text) {
                                messageElements.push(h('text', { content: segment.data.text }))
                              } else if (segment.type === 'image' && segment.data?.url) {
                                messageElements.push(h('img', { src: segment.data.url }))
                              } else if (segment.type === 'video' && segment.data?.url) {
                                messageElements.push(h('video', { src: segment.data.url }))
                              } else if (segment.type === 'at' && segment.data?.qq) {
                                messageElements.push(h('at', { id: segment.data.qq }))
                              } else if (segment.type === 'face' && segment.data?.id) {
                                messageElements.push(h('text', { content: `[表情${segment.data.id}]` }))
                              } else if (segment.type === 'record' && segment.data?.url) {
                                messageElements.push(h('audio', { src: segment.data.url }))
                              } else if (segment.type === 'file' && segment.data?.url) {
                                const fileName = segment.data.name || segment.data.file || '文件'
                                messageElements.push(h('file', { src: segment.data.url, name: fileName }))
                              } else {
                                // 其他类型的消息段
                                messageElements.push(h('text', { content: `[${segment.type}]` }))
                              }
                            }
                          } else if (typeof msg.content === 'string') {
                            messageElements.push(h('text', { content: msg.content }))
                          } else {
                            messageElements.push(h('text', { content: msg.message || '(无法解析的消息)' }))
                          }
                          
                          messageNodes.push(h('message', {
                            userId: msg.sender?.user_id?.toString() || 'unknown',
                            nickname: msg.sender?.nickname || '未知用户'
                          }, messageElements))
                        }
                        
                        // 使用h('figure')构造合并转发
                        const figureMessage = h('figure', {}, messageNodes)
                        
                        if (ctx.config.debug) {
                          logger.info(`构造的figure消息:`, JSON.stringify(figureMessage, null, 2))
                        }
                        
                        // 如果需要显示发送者，先发送发送者信息
                        if (rule.showOriginalSender) {
                          let targetDisplayName = sourceDisplayName
                          try {
                            const targetMember = await session.bot.getGuildMember(plainTargetId, originalUserId)
                            if (targetMember?.name) targetDisplayName = targetMember.name
                            else if (targetMember?.nick) targetDisplayName = targetMember.nick
                          } catch (error) {
                            if (ctx.config.debug) logger.info(`无法获取目标群昵称，使用源群昵称`)
                          }
                          
                          // 先发送发送者信息
                          await session.bot.sendMessage(plainTargetId, `${targetDisplayName} 发送了一个转发消息`)
                        }
                        
                        // 发送合并转发消息
                        const result = await session.bot.sendMessage(plainTargetId, figureMessage)
                        if (ctx.config.debug) logger.info(`figure发送返回结果:`, JSON.stringify(result, null, 2))
                        
                        if (result && result.length > 0) {
                          successCount++
                          if (ctx.config.debug) logger.info(`[成功] 使用OneBot API成功转发合并转发消息到 ${targetChannelId}`)
                          continue
                        } else {
                          if (ctx.config.debug) logger.warn(`figure方式可能成功但未返回有效结果`)
                          // 有些情况下发送成功但不返回标准格式
                          if (result !== null && result !== undefined) {
                            successCount++
                            if (ctx.config.debug) logger.info(`[成功] OneBot API转发可能已成功到 ${targetChannelId}`)
                            continue
                          }
                        }
                        } else {
                          if (ctx.config.debug) logger.warn(`OneBot API返回的数据不是数组格式: ${typeof forwardData}`)
                        }
                    }
                  } catch (error) {
                    if (ctx.config.debug) logger.warn(`OneBot API处理失败: ${error}，回退到文本模式`)
                  }
                } else if (hasJsonElement) {
                  if (ctx.config.debug) logger.info(`检测到json元素（QQ小程序），尝试提取链接...`)
                  
                  try {
                    const plainTargetId = targetChannelId.split(':')[1] || targetChannelId
                    
                    // 查找json元素
                    const jsonElement = quoted.elements.find(el => el.type === 'json')
                    if (jsonElement && jsonElement.attrs?.data) {
                      if (ctx.config.debug) logger.info(`找到json数据，尝试解析链接...`)
                      
                      // 解析 JSON 数据
                      const jsonData = JSON.parse(jsonElement.attrs.data)
                      if (ctx.config.debug) logger.info(`解析的JSON数据:`, JSON.stringify(jsonData, null, 2))
                      
                      // 提取链接信息
                      let linkMessage = ''
                      const title = jsonData.meta?.detail_1?.title || '未知应用'
                      const desc = jsonData.meta?.detail_1?.desc || jsonData.prompt || ''
                      
                      // 优先使用 qqdocurl，其次使用 url
                      let linkUrl = ''
                      if (jsonData.meta?.detail_1?.qqdocurl) {
                        linkUrl = jsonData.meta.detail_1.qqdocurl
                      } else if (jsonData.meta?.detail_1?.url) {
                        linkUrl = jsonData.meta.detail_1.url
                        // 如果url不是完整链接，添加协议
                        if (!linkUrl.startsWith('http')) {
                          linkUrl = 'https://' + linkUrl
                        }
                      }
                      
                      if (linkUrl) {
                        linkMessage = `【${title}】${desc}\n${linkUrl}`
                      } else {
                        linkMessage = `【${title}】${desc}\n(未找到可用链接)`
                      }
                      
                      if (ctx.config.debug) logger.info(`提取的链接信息: "${linkMessage}"`)
                      
                      // 如果需要显示发送者，添加发送者信息到链接消息中
                      let finalLinkMessage = linkMessage
                      if (rule.showOriginalSender) {
                        let targetDisplayName = sourceDisplayName
                        try {
                          const targetMember = await session.bot.getGuildMember(plainTargetId, originalUserId)
                          if (targetMember?.name) targetDisplayName = targetMember.name
                          else if (targetMember?.nick) targetDisplayName = targetMember.nick
                        } catch (error) {
                          if (ctx.config.debug) logger.info(`无法获取目标群昵称，使用源群昵称`)
                        }
                        
                        finalLinkMessage = `${targetDisplayName} 分享了：\n${linkMessage}`
                      }
                      
                      // 发送链接消息
                      const result = await session.bot.sendMessage(plainTargetId, finalLinkMessage)
                      if (ctx.config.debug) logger.info(`链接发送返回结果:`, JSON.stringify(result, null, 2))
                      
                      if (result && result.length > 0) {
                        successCount++
                        if (ctx.config.debug) logger.info(`[成功] 成功转发QQ小程序链接到 ${targetChannelId}`)
                        continue
                      } else {
                        if (ctx.config.debug) logger.warn(`链接发送可能成功但未返回有效结果`)
                        // 有些情况下发送成功但不返回标准格式
                        if (result !== null && result !== undefined) {
                          successCount++
                          if (ctx.config.debug) logger.info(`[成功] QQ小程序链接转发可能已成功到 ${targetChannelId}`)
                          continue
                        }
                      }
                    } else {
                      if (ctx.config.debug) logger.warn(`json元素没有data属性`)
                    }
                  } catch (error) {
                    if (ctx.config.debug) logger.warn(`QQ小程序链接解析失败: ${error}，回退到文本模式`)
                  }
                } else if (hasFileElement) {
                  if (ctx.config.debug) logger.info(`检测到file元素，暂不支持文件转发`)
                  
                  try {
                    const plainTargetId = targetChannelId.split(':')[1] || targetChannelId
                    
                    // 查找file元素
                    const fileElement = quoted.elements.find(el => el.type === 'file')
                    if (fileElement && fileElement.attrs) {
                      if (ctx.config.debug) logger.info(`找到文件数据:`, JSON.stringify(fileElement.attrs, null, 2))
                      
                      // 提取文件信息
                      const fileName = fileElement.attrs.file || fileElement.attrs.src || '未知文件'
                      const fileSize = fileElement.attrs.fileSize || '未知大小'
                      const fileId = fileElement.attrs.fileId || ''
                      
                      // 格式化文件大小
                      let formattedSize = fileSize
                      if (typeof fileSize === 'string' && !isNaN(Number(fileSize))) {
                        const sizeInBytes = Number(fileSize)
                        if (sizeInBytes >= 1024 * 1024) {
                          formattedSize = `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`
                        } else if (sizeInBytes >= 1024) {
                          formattedSize = `${(sizeInBytes / 1024).toFixed(2)} KB`
                        } else {
                          formattedSize = `${sizeInBytes} B`
                        }
                      }
                      
                      // 构造文件信息消息
                      let fileInfoMessage = `📁 文件: ${fileName}\n📏 大小: ${formattedSize}`
                      if (fileId) {
                        fileInfoMessage += `\n🆔 文件ID: ${fileId}`
                      }
                      fileInfoMessage += `\n⚠️ 注意: 暂不支持文件转发，请手动下载后重新发送`
                      
                      // 如果需要显示发送者，添加发送者信息
                      if (rule.showOriginalSender) {
                        let targetDisplayName = sourceDisplayName
                        try {
                          const targetMember = await session.bot.getGuildMember(plainTargetId, originalUserId)
                          if (targetMember?.name) targetDisplayName = targetMember.name
                          else if (targetMember?.nick) targetDisplayName = targetMember.nick
                        } catch (error) {
                          if (ctx.config.debug) logger.info(`无法获取目标群昵称，使用源群昵称`)
                        }
                        
                        fileInfoMessage = `${targetDisplayName} 发送了一个文件：\n${fileInfoMessage}`
                      }
                      
                      // 发送文件信息
                      const result = await session.bot.sendMessage(plainTargetId, fileInfoMessage)
                      if (ctx.config.debug) logger.info(`文件信息发送返回结果:`, JSON.stringify(result, null, 2))
                      
                      if (result && result.length > 0) {
                        successCount++
                        if (ctx.config.debug) logger.info(`[成功] 文件信息已发送到 ${targetChannelId}`)
                        continue
                      } else {
                        if (ctx.config.debug) logger.warn(`文件信息发送可能成功但未返回有效结果`)
                        if (result !== null && result !== undefined) {
                          successCount++
                          if (ctx.config.debug) logger.info(`[成功] 文件信息可能已成功发送到 ${targetChannelId}`)
                          continue
                        }
                      }
                    } else {
                      if (ctx.config.debug) logger.warn(`file元素没有attrs属性`)
                    }
                  } catch (error) {
                    if (ctx.config.debug) logger.warn(`文件信息处理失败: ${error}`)
                  }
                }
              }
              
              // 普通文本消息转发
              if (ctx.config.debug) logger.info(`尝试普通文本转发到: ${targetChannelId}`)
              const sentMessageIds = await ctx.broadcast([targetChannelId], finalMessage)
              if (ctx.config.debug) logger.info(`普通转发broadcast返回的消息ID: ${JSON.stringify(sentMessageIds)}`)
              if (sentMessageIds.length > 0) {
                successCount++
                if (ctx.config.debug) logger.info(`[成功] 消息已转发到 ${targetChannelId}`)
              } else {
                logger.warn(`[失败] 转发到频道 ${targetChannelId} 失败（Broadcast未返回ID）。`)
              }
            } catch (error) {
              logger.error(`[失败] 转发到频道 ${targetChannelId} 时发生错误:`, error)
            }
          }
          if (ctx.config.debug) logger.info(`(引用转发) 指令 "${rule.commandName}" 完成：成功 ${successCount}/${targets.length}`)
          
          // 根据配置决定是否发送成功消息
          if (rule.showSuccessMessage) {
            return successCount > 0 ? '消息已成功转发。' : '发送失败，请检查机器人权限与日志。'
          }
          // 不发送成功消息时，返回空字符串（不显示任何回复）
          return ''
        })
    }
  }
}