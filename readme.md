# koishi-plugin-message-relay

[![npm](https://img.shields.io/npm/v/koishi-plugin-message-relay)](https://www.npmjs.com/package/koishi-plugin-message-relay)
[![license](https://img.shields.io/npm/l/koishi-plugin-message-relay)](https://github.com/WhiteBr1ck/koishi-plugin-message-relay/blob/main/LICENSE)

一个在不同群组之间，监控并同步用户消息的 Koishi 插件。

## ✨ 功能特性

- **多用户监控**: 支持配置一个或多个用户，对其发言进行监控。
- **可配置群组**: 可为每一个被监控的用户独立设置触发关键词和目标转发频道。
- **图片支持**: 能够正确转发包括文本、图片、文件、at在内的多种消息类型。
- **支持群昵称**: 在转发消息时，优先获取并使用发言者在**目标群聊**的群昵称。
- **手动转发指令**: 提供 `传话筒` 指令，允许管理员手动向指定群聊发送消息，此外还能支持 QQ 的引用功能。
- **支持群名称发送**: `传话筒` 指令支持通过**序号**、**群名称**或**群号**来指定目标。
- **调试模式**: 内置 Debug 开关，方便在需要时开启详细的日志以供排查。

## 📦 安装

# 在 Koishi 插件市场搜索并安装


## ⚙️ 配置项

本插件的配置项分为三个区域：监控规则、手动指令和高级设置。

### 监控规则设置

- **monitoringRules**: 用户监控规则列表。这是一个数组，每一项都代表一条独立的规则。
  - **userId**: `string` - 被监控用户的完整 ID (需要带平台前缀，如 `onebot:12345678`)。
  - **keywords**: `string[]` - 触发转发的关键词列表。如果此列表为空，则该用户的所有消息都将被转发。
  - **relayTargetChannels**: `string[]` - 该用户消息的目标转发频道列表 (需要带平台前缀，如 `onebot:12345678`)。

### 手动指令设置

- **manualRelayAllowedChannels**: `string[]` - 允许 `传话筒` 指令手动转发的群组列表 (需要带平台前缀，如 `onebot:12345678`)。
- **commandAuthLevel**: `number` - 能够使用 `传话筒` 指令的最低权限等级。默认为 `3`。
- **defaultPlatform**: `string` - 手动传话时，如果未提供平台前缀，则使用此平台名称。默认为 `onebot`。

### 高级设置

- **debug**: `boolean` - 是否在控制台输出详细的调试日志。默认为 `false`。

## 🎮 指令说明

- **`支持的群聊`**
  - 功能: 显示当前机器人被允许使用 `传话筒` 指令的所有群聊列表。
  - 列表将以 `序号. 群名称 (群ID)` 的格式展示。

- **`传话筒 <目标> <内容>`**
  - 功能: 手动发送消息到指定的目标群聊。
  - `<目标>`: 可以是 `支持的群聊` 指令中列出的**序号**、**群名称**或**群号**。
  - `<内容>`: 你想要发送的文本内容。

## ✍️ 作者

**koishi-plugin-message-relay** © [WhiteBr1ck](https://github.com/WhiteBr1ck), Released under the MIT License.

## 📄 免责声明

本插件按“原样”提供，不作任何明示或暗示的保证。插件作者不对因使用或滥用本插件而造成的任何直接或间接的损害、数据丢失或任何形式的纠纷承担责任。

使用者应自行承担使用本插件的所有风险，并确保其使用行为符合相关平台的用户协议和当地法律法规。

## 授权许可

[MIT License](https://github.com/WhiteBr1ck/koishi-plugin-message-relay/blob/main/LICENSE) © 2025 WhiteBr1ck