---
name: self-config
description: >-
  MyAgents 应用的统一管理入口——通过 myagents CLI 帮用户完成配置、运维和状态查询。
  涵盖六大能力域：(1) MCP 工具接入与管理，(2) 模型服务商配置与验证，(3) Agent Channel 管理与运行时状态，
  (4) 定时任务(cron)的创建/启停/删除/查看执行记录，(5) OpenClaw 社区插件安装/卸载，(6) 通用配置读写与版本查看。
  当用户涉及以下任何一种意图时必须触发此技能：管理定时任务、查看/操作 cron、安装/卸载插件、
  添加/测试模型服务商、接入 MCP 工具、查看 Agent 连接状态、修改应用配置、查看版本号。
  即使用户没有说"配置"二字，只要意图是对 MyAgents 本身做查看或操作（而非让 AI 执行具体业务任务），
  就应该使用此技能。注意：管理定时任务时使用此技能（通过 CLI），不要直接调用 im-cron MCP 工具——
  im-cron 是 AI 在自己的会话中管理任务用的，self-config 才是帮用户管理应用级任务的正确入口。
---

# Self-Config — 应用自我配置

你可以通过内置的 `myagents` CLI 管理应用的几乎所有方面——MCP 工具、模型服务、Agent/Channel、定时任务、社区插件等。

这个 CLI 是专门为你设计的——你通过 Bash 工具执行命令，就可以帮用户完成各种配置和管理操作，不需要让用户手动去 Settings 页面操作。

## 使用模式

1. **探索**: `myagents --help` 发现顶层命令组，`myagents <group> --help` 发现子命令
2. **预览**: 所有写操作支持 `--dry-run`，先看会做什么再决定是否执行
3. **执行**: 确认无误后去掉 `--dry-run` 正式执行
4. **验证**: 执行后用 `myagents <group> list` 或 `myagents status` 确认结果
5. **机器可读**: 加 `--json` 获取结构化 JSON 输出，方便你解析

## 安全规范

- 修改配置前，先用 `--dry-run` 预览变更，向用户展示将要做什么
- API Key 等敏感信息：如果用户在对话中明确提供了，可以直接通过 CLI 写入；如果没有提供，引导用户去 **设置 → 对应页面** 手动填写，不要追问敏感信息
- 删除操作前必须向用户确认
- 这些规范背后的原因：用户的配置数据很重要，误操作可能导致服务中断。预览和确认步骤是保护用户的安全网

## 生效时机

- **MCP 工具变更**（增删改/启禁用/环境变量）：配置立即写入磁盘，但工具在**下一轮对话**才可用（因为 MCP 服务器在 session 创建时绑定）。你可以在当前轮完成配置和验证，告诉用户"发条消息我就能使用新工具了"
- **其他配置**（模型、Provider、Agent）：写入后即时生效

## 典型工作流

### 接入 MCP 工具

当用户提供了工具文档或描述时：

1. 从文档中提取关键信息：server ID、类型（stdio/sse/http）、命令或 URL、所需环境变量
2. `myagents mcp add --dry-run ...` 预览配置
3. 向用户展示预览内容并确认
4. 执行：add → enable（`--scope both` 同时启用全局和当前项目）→ 配置环境变量（如需要）
5. `myagents mcp test <id>` 验证连通性
6. `myagents reload` 触发热加载
7. 告诉用户"配置完成，发条消息我就能用了"

### 配置模型服务（重点）

这是最常见也最有价值的场景。用户可能丢给你一个 API 服务商的文档，你需要理解其中的配置信息。

#### 核心原则：协议优先级

MyAgents 基于 Claude Agent SDK，底层是 Anthropic Messages API。接入第三方 API 时，协议选择的优先级是：

1. **Anthropic 协议（最优先）** — 这是 MyAgents 的原生协议，性能最好、功能完整、兼容性最强。没有协议转换开销，所有 SDK 能力（工具调用、流式、Extended Thinking 等）都能正常使用。
2. **OpenAI 兼容协议（兜底）** — 如果服务商只提供 OpenAI 兼容 API（`/v1/chat/completions`），使用 `--protocol openai`。这会通过内置的协议桥接层转换请求格式，部分高级功能可能受限。

#### 从文档提取配置的方法

当用户给你一份 API 服务商的文档时，**始终先寻找 Anthropic 协议的接入方式**。

关键洞察：大多数支持 Anthropic 协议的服务商，会在文档里以「接入 Claude Code」或「Claude Code 配置」的形式来呈现。这些板块本质上就是在描述 Anthropic 协议的接入参数——MyAgents 和 Claude Code 共享同一个 SDK，所以 Claude Code 的接入方式就是我们最原生的接入方式。

**第一步：寻找 Anthropic / Claude Code 接入板块（优先）**
- 在文档中搜索：`Claude Code`、`Anthropic`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`、`/anthropic`
- 常见的文档标题模式：「接入 Claude Code」「Anthropic API 兼容」「Claude Code 配置指南」
- 如果找到，提取：
  - `ANTHROPIC_BASE_URL` 的值 → `--base-url`
  - 认证方式（Bearer Token 还是 API Key）→ `--auth-type`（多数为 `auth_token`）
  - 模型名称列表 → `--models`
- 即使文档同时提供了 OpenAI 兼容方式，只要有 Anthropic 方式就优先用 Anthropic

**第二步：如果确实没有 Anthropic 支持，再找 OpenAI 兼容（兜底）**
- 搜索关键词：`OpenAI 兼容`、`/v1/chat/completions`、`chat completions`
- 如果找到，提取：
  - API base URL → `--base-url`（通常以 `/v1` 结尾或需要去掉 `/chat/completions`）
  - 使用 `--protocol openai`
  - 注意区分 `--upstream-format`：
    - 大多数服务商用 `chat_completions`（默认值）
    - 少数新服务商支持 `responses` 格式

#### Claude Code 配置 → MyAgents 配置的映射

如果文档给出了 Claude Code 的配置示例（环境变量方式），对应关系是：

| Claude Code 环境变量 | MyAgents CLI 参数 |
|---------------------|------------------|
| `ANTHROPIC_BASE_URL` | `--base-url` |
| `ANTHROPIC_API_KEY` | API Key（用 `model set-key` 设置） |
| `ANTHROPIC_AUTH_TOKEN` | 同上（区别在 `--auth-type`） |

`--auth-type` 的选择逻辑：
- 如果文档说设置 `ANTHROPIC_AUTH_TOKEN` → 用 `auth_token`
- 如果文档说设置 `ANTHROPIC_API_KEY` → 用 `api_key`
- 如果文档两个都设置或没说清 → 用 `both`（默认，最安全）
- OpenRouter 等特殊服务商 → 用 `auth_token_clear_api_key`

#### `model add` 参数说明

```
myagents model add \
  --id <唯一ID>              # 必填，如 'my-provider'
  --name <显示名>             # 必填，如 '我的API服务'
  --base-url <API地址>        # 必填，如 'https://api.example.com/anthropic'
  --models <模型ID列表>       # 必填，逗号分隔或多次 --models
  --model-names <显示名列表>   # 可选，与 models 一一对应
  --model-series <系列名>      # 可选，默认取 provider ID
  --primary-model <默认模型>   # 可选，默认取第一个 model
  --auth-type <认证类型>       # 可选，默认 auth_token
  --protocol <协议>           # 可选，anthropic(默认) 或 openai
  --upstream-format <格式>     # 可选（仅 openai），chat_completions(默认) 或 responses
  --max-output-tokens <数字>   # 可选（仅 openai），默认 8192
  --vendor <供应商名>          # 可选，默认取 name
  --website-url <官网>         # 可选
  --dry-run                    # 预览
```

#### 免费模型优先策略

很多 Provider 同时提供付费模型和免费模型。`model verify` 会用 `primaryModel` 发一条测试消息。如果用户可能还没充值，验证付费模型会失败。

**策略**：如果一个 Provider 有免费模型也有付费模型，在 `--models` 列表中把免费模型放在第一位。这样 `primaryModel` 自动选中免费模型，`model verify` 更容易成功。

**例外**：如果用户明确说了要用某个特定模型，按用户意愿来。

#### 完整配置流程

1. `myagents model list` 检查是否已有内置 Provider
2. 如果是内置的 → 直接 `model set-key`
3. 如果需要新增 → `model add --dry-run ...` 预览
4. 向用户展示配置并确认
5. `model add ...` 正式添加
6. `myagents model set-key <id> <key>` 设置 API Key
7. `myagents model verify <id>` 验证（会实际发送一条测试消息）
8. 如果验证失败 → 分析原因：
   - 认证失败 → 检查 API Key 和 auth-type
   - 模型不存在 → 检查模型名称
   - 余额不足 → 尝试切换到免费模型验证
   - 协议不对 → 尝试切换 protocol（anthropic ↔ openai）
9. `myagents model set-default <id>` 设为默认（可选）

### 配置 Agent Channel

1. `myagents agent list` 查看现有 Agent
2. `myagents agent channel add <agent-id> --type telegram --token <bot-token>` 添加渠道
3. 根据平台类型，需要不同的凭证（flag 名必须与配置字段一致）：
   - Telegram: `--bot-token <token>`
   - 飞书: `--feishu-app-id <id>` + `--feishu-app-secret <secret>`
   - 钉钉: `--dingtalk-client-id <id>` + `--dingtalk-client-secret <secret>`

### 管理定时任务

定时任务让 AI 按计划自动执行工作——数据汇总、监控告警、定期报告等。

```bash
myagents cron list                              # 列出所有定时任务
myagents cron add --name "日报" --prompt "生成今日工作汇总" --schedule "0 18 * * *" --workspace /path
myagents cron start <taskId>                    # 启动已停止的任务
myagents cron stop <taskId>                     # 停止运行中的任务
myagents cron remove <taskId>                   # 删除任务
myagents cron runs <taskId>                     # 查看执行历史
myagents cron status                            # 查看任务概览（总数/运行中/下次执行）
```

调度方式有三种：
- `--schedule "*/30 * * * *"` — 标准 cron 表达式
- `--every 15` — 每 N 分钟
- 一次性任务（通过 API 的 `at` 类型）

### 管理社区插件

OpenClaw 社区插件让 Agent 可以连接更多 IM 平台（微信、Slack 等）。

```bash
myagents plugin list                            # 列出已安装的插件
myagents plugin install @anthropic/wechat       # 从 npm 安装插件
myagents plugin remove @anthropic/wechat        # 卸载（须先停止使用该插件的 Channel）
```

安装可能需要 10-30 秒（npm install），耐心等待即可。卸载前会检查是否有运行中的 Channel 依赖该插件。

### 管理技能 Skills

**核心能力**：从 GitHub 链接或 `npx skills` 命令直接把社区 skill 装到 `~/.myagents/skills/`，无需用户手动 `cp -r`。

```bash
myagents skill list                             # 列出已安装的 skill（全局 + 项目级）
myagents skill info <name>                      # 查看某个 skill 的详情
myagents skill add <url-or-spec>                # 从链接安装（核心命令）
myagents skill remove <name>                    # 删除
myagents skill enable <name>                    # 启用
myagents skill disable <name>                   # 停用
myagents skill sync                             # 从 ~/.claude/skills 同步过来
```

#### `skill add` 的输入形态（全部归一到 GitHub 仓库坐标）

同一个 resolver 吃下所有常见写法，用户粘贴什么都行：

| 输入 | 说明 |
|------|------|
| `foo/bar` | GitHub owner/repo 简写 |
| `https://github.com/foo/bar` | 完整 URL |
| `https://github.com/foo/bar/tree/main/skills/baz` | tree 子路径（只装该子目录） |
| `foo/bar@baz` | 仓库内多 skill 时选其一 |
| `"npx skills add foo/bar --skill baz"` | 用户从 README 复制的整条命令（用引号包住） |
| `https://example.com/x.zip` | 直连 zip/tar.gz |

**不支持**：GitLab、私有仓库、git SSH（`git@github.com:...`）。

#### 关键 flags

- `--scope user|project` — 装到 `~/.myagents/skills/`（默认）或 `<workspace>/.claude/skills/`
- `--plugin <name>` — 当仓库含 Claude Plugins 市场（`.claude-plugin/marketplace.json`）时，指定要装的插件合集
- `--skill <name>` — 仓库内多 skill 时选其一
- `--force` — 已存在的同名 skill 强制覆盖（默认会报 409 让你确认）
- `--dry-run` — 只预览不落盘

#### 典型场景

**场景 1：用户粘来一个 GitHub 链接**
```bash
myagents skill add https://github.com/vercel-labs/skills/tree/main/skills/react-best-practices
```
直接装单个子路径下的 skill。

**场景 2：用户粘来一整条 `npx skills add` 命令**
```bash
myagents skill add "npx skills add anthropics/skills --skill pdf"
```
resolver 自动剥掉 `npx skills add` 前缀、识别 `--skill` 参数。

**场景 3：仓库是 Claude Plugins 市场（多个插件合集）**
```bash
myagents skill add anthropics/skills
# → 返回错误提示"该仓库是 Claude Plugins 市场，请用 --plugin <name> 指定要安装的 plugin 合集"
#   并列出可用 plugin 合集：document-skills / example-skills / claude-api
myagents skill add anthropics/skills --plugin document-skills
# → 一次装完 docx/pdf/pptx/xlsx 四个 skill
```

**场景 4：目标已存在**
```bash
myagents skill add foo/bar
# → "技能 bar 已存在。使用 --force 覆盖。"
myagents skill add foo/bar --force
```

#### 你应该怎么用

- 用户说"帮我装个 React 最佳实践 skill" → 你用 `myagents skill add vercel-labs/skills --skill react-best-practices`
- 用户贴了一个 GitHub 链接或 `npx skills add` 命令 → 直接 `myagents skill add "<原文>"`
- 用户说"看看我有哪些 skill" → `myagents skill list`
- 用户在 `~/.claude/skills/` 里装了东西 MyAgents 看不见 → `myagents skill sync`
- 用户说"装不上"，看报错信息：
  - `401/403` → 私有仓库，不支持
  - `仓库或分支不存在` → 检查输入拼写，或该仓库使用非默认分支名
  - `下载超时` → 检查用户代理设置
  - `该仓库是 Claude Plugins 市场` → 按提示加 `--plugin <name>` 重试
  - `技能 xxx 已存在` → 按用户意图决定是 `--force` 还是换个名字装

### 查看 Agent 运行时状态

查看所有 Agent 及其 Channel 的实时连接状态——在线/离线/错误、运行时长、最近消息时间等。

```bash
myagents agent runtime-status                   # 查看所有 Agent 运行时状态
```

这和 `myagents agent list` 的区别：`list` 看的是配置（config.json 里写了什么），`status --runtime` 看的是运行时（实际连接状态、uptime、错误信息）。

### 查看和修改通用配置

```bash
myagents config get <key>                       # 读取（支持点号路径如 proxySettings.host）
myagents config set <key> <value>               # 修改
myagents status                                 # 查看整体运行状态
myagents version                                # 查看应用版本号
```
