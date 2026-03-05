# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.36] - 2026-03-06

### Added
- **Session 智能标题自动生成**：首轮 QA 后 AI 自动生成语义化短标题（≤30 字），贯穿 Tab 栏、Chat 顶栏、历史记录、任务中心；支持 Chat 顶栏内联点击重命名，手动重命名后不再自动覆盖（`titleSource` 三态：default/auto/user）
- **触控板双指水平滑动切换 Tab**：跟手动画 + 惯性检测 + 边界回弹，支持 macOS 触控板自然手势
- **对话文件路径菜单「打开」选项**：右键文件路径可直接在系统中打开
- **模型用量分布表格供应商筛选器**：使用统计页支持按供应商筛选模型用量

### Fixed
- **飞书群聊管理未识别群组** (#11)：飞书 Bot 仅通过生命周期事件发现群组，新增与钉钉相同的消息级自动发现机制
- **Gemini 工具调用 400 错误** (#10)：OpenAI 桥接层丢失 Gemini 思考模型的 `thought_signature` 字段，全链路增加透传
- **代码块选中复制换行问题**：视觉换行被当成真实换行复制
- **输入框工具栏窄屏换行**：工具栏按钮在窄宽度下自动隐藏文字标签，模型名称截断显示
- **Rust 代理层缺少 PATCH 方法**：`proxy_http_request` 不支持 PATCH，导致 session 更新（重命名等）静默失败
- **AI 分析内容误触发 Agent error 横幅**：非流式供应商正常响应被误显示为错误
- **会话统计弹窗层级错误**：Modal 嵌套在 dropdown 内导致输入框浮于遮罩之上，改用 Portal 渲染到 document root
- **会话统计弹窗样式**：卡片/表头背景与设置页使用统计面板风格统一（paper-elevated）
- **飞书 Bot 权限缺失**：补充 `contact:contact.base:readonly` 权限

---

## [0.1.35] - 2026-03-05

### Fixed
- **「不再提示」全局配置覆盖弹窗**：重启应用后弹窗仍然显示，修复持久化逻辑
- **Bridge thinking 模式 tool_call**：thinking 模式下 tool_call 消息缺失 reasoning_content
- **IM Bot im-media 工具丢失**：IM 频道发送图片/文件时工具不可用 + 首消息 SSE 超时
- **AI 小助理面板圆角**：底部圆角被子元素背景色遮挡，添加 overflow-hidden

### Changed
- **Design Polish v2.2**：CSS Token 重建 + 组件样式统一 + 页面视觉打磨
- **模型选择器重构**：从两级菜单（先选供应商 → 再选模型）改为单级分组菜单，按供应商分组平铺所有可用模型；空状态显示引导跳转设置页
- **Settings 文案修正**："工具 & MCP" → "工具 MCP"

---

## [0.1.34] - 2026-03-04

### Added
- **Edge TTS 语音合成**：新增免费 TTS MCP 工具，基于自研 WebSocket 协议实现（绕过 Bun ws polyfill 限制），支持 400+ 语音、语速/音量/音调调节、多种输出格式
- **Gemini Image 工具前端组件**：AI 生成图片支持内联预览展示
- **AI 消息操作栏**：新增复制/重试按钮，用户消息操作栏布局重构
- **Google Gemini 预设供应商**：添加 Gemini（OpenAI 协议兼容）预设配置
- **Playwright MCP 设置面板升级**：结构化控件替代通用对话框
- **Chat 工具弹窗设置入口**：增加设置图标，点击跳转 Settings MCP 配置面板
- **MCP 预设工具「免费」标签**：帮助用户识别无需 API Key 的免费工具
- **Telegram Draft 流式打字机**：sendMessageDraft 实验性流式打字效果

### Fixed
- **Bridge 429 无限重试**：区分 quota-exhausted（永久限速）与临时 429，避免无限循环
- **Session 死亡自动恢复**：防止 generator 死亡导致消息队列卡死
- **MCP Streamable HTTP 验证**：Accept 头不符合规范导致智谱等端点 400 错误
- **Feishu IM 稳定性**：撤回通知处理 + 排队消息响应丢失 + cross-turn 防护
- **IM Bot MCP 工具**：取消勾选失败 + Telegram Draft 默认开启
- **消息操作栏样式**：hover 时间戳残留 + 图标对齐 + 间距优化
- **非流式供应商误报错**：正常响应被误显示为 Agent error 横幅

### Changed
- **Builtin MCP 注册模式重构**：统一 registry pattern + config fingerprint 变更检测
- **CSP 安全策略更新**：添加 media-src 指令支持音频 Blob URL 播放

---

## [0.1.33] - 2026-03-03

### Added
- **钉钉 Bot 集成**：新增钉钉机器人 IM 渠道，支持私聊和群聊；Windows 单实例防护避免多开冲突
- **OpenAI Bridge Responses API**：兼容 OpenAI Responses API 格式 (`upstreamFormat: 'responses'`)，支持 `maxOutputTokens` 配置上限
- **全局 Token 使用统计**：Settings 页新增使用统计面板，含 5 项汇总卡片、每日用量趋势 SVG 柱状图、模型用量分布表，支持 7 天 / 30 天 / 60 天时间范围切换
- **项目设置重构**：双 Tab 布局（系统提示词 + 项目设置），支持多文件系统提示词管理
- **MCP 运行环境弹窗**：增加「让 AI 小助理安装」按钮，一键委托 AI 安装 MCP 依赖
- **全局配置覆盖弹窗**：增加「不再提示」选项，避免重复确认

### Fixed
- **MCP 超尺寸图片**：工具返回超大 base64 图片导致 Claude API 400 错误，增加尺寸检测与压缩
- **供应商验证竞态**：并发验证请求中，超时的过期请求覆盖已成功的验证状态，使用 generation counter 丢弃过期结果
- **OpenAI 协议验证 max_tokens 超限**：验证流程未传递 `maxOutputTokens` 导致 Bridge 无法限制默认 token 上限
- **cron_task ProviderEnv 构造补全**：定时任务缺失 provider 环境变量字段
- **日志降噪**：恢复重要 SDK 消息日志，截断超长字符串；AI 反馈答疑文案改为"AI 小助理"
- **项目设置 Overlay**：删除文件后编辑态未重置 + tooltip 被 overflow 裁切不可见

### Changed
- **GitHub Release 上传脚本拆分**：发布上传逻辑拆分为独立脚本，`publish_release.sh` / `publish_windows.ps1` 调用
- **CLAUDE.md 精简**：从 562 行精简至 126 行最佳实践
- **OpenAI Bridge 代码清理**：重构 Bridge 模块 + Settings UI 优化

---

## [0.1.32] - 2026-03-02

### Added
- **AI 智能 Bug 上报**：一键向开发者报告问题，AI 自动收集运行日志、系统环境、对话上下文，生成结构化 Bug Report
  - 支持图片上传、粘贴和拖拽附加截图
  - 模型菜单只显示可用 provider，无可用 provider 时引导跳转设置
  - 重构为 bundled-agents 文件化架构（`bundled-agents/myagents_helper/`）
- **内置助手 v2**：全新 `myagents_helper` Agent，增加产品定位与开发者愿景、工作区写保护约束
- **Launcher 无 Provider 引导**：未配置任何 API Key 时显示「配置模型供应商」引导入口

### Fixed
- **RecentTasks 显示数量修复**：列表条目计数逻辑修正
- **关闭 AI 对话中的 Tab**：不再弹确认框，改为 toast 提示
- **`.gitignore` 修正**：只忽略根目录 `.claude/`，允许子目录 `.claude/` 被 Git 跟踪

### Changed
- **统一系统提示词架构**：重构为三层 Prompt 架构（L1 基础身份 + L2 交互方式 + L3 场景指令），所有场景统一使用 append 模式
  - AI 始终知道自己运行在 MyAgents 产品中（桌面聊天、IM Bot、Cron 任务）
  - 旧 SystemPromptConfig（preset/replace/append 三模式）替换为 InteractionScenario 类型
  - IM Bot 启动时传递 botName，AI 感知自身 Bot 名称
  - 模板内容内联为字符串常量（bun build 禁止 `__dirname`）
- **IM Bot 文件存储重构**：运行时状态文件从 `~/.myagents/im_{botId}_*.json` 扁平散落迁移到 `~/.myagents/im_bots/{botId}/` 子目录组织
  - 三代自动迁移（v1 单 bot → v2 flat 多 bot → v3 子目录）
  - 孤儿文件启动时自动清理，删除 bot 时清理持久化数据
- **统一日志优化**：本地化时间戳、减少噪音
- **Settings 页面 UI 重构**：「报告问题」从「关于」移至「通用」运行日志下方

---

## [0.1.31] - 2026-03-01

### Fixed
- **agent-browser 反检测配置路径统一**：使用 `~/.agent-browser/config.json`（agent-browser 默认路径），移除 `AGENT_BROWSER_CONFIG` 环境变量，避免路径不一致
- **agent-browser Profile 路径统一**：与 Playwright MCP 共享 `~/.playwright-mcp-profile/`，避免重复登录
- **agent-browser comma-in-args bug**：`--window-size=1440,900` 被 Rust CLI 按逗号拆分导致参数错误，改用 `--start-maximized`
- **Windows agent-browser 不可用**：上游 daemon 在 Windows 使用 Unix socket 导致连接失败（vercel-labs/agent-browser#398），暂时在 Windows 上跳过 agent-browser 技能加载
- **agent-browser 反检测参数优化**：禁用自动化控制标志、匹配系统 locale、最大化窗口绕过 viewport 指纹

### Changed
- **平台技能屏蔽机制**：新增 `PLATFORM_BLOCKED_SKILLS` 集中配置，支持按平台跳过不可用的内置技能（seed / wrapper / symlink / API 列表统一过滤）
- **发布脚本集成 GitHub Release 上传**：`publish_release.sh` 和 `publish_windows.ps1` 在 R2 上传后自动将构建产物上传到 GitHub Release

---

## [0.1.30] - 2026-02-28

### Added
- **agent-browser 内置浏览器自动化**：集成 agent-browser CLI 作为内置技能，支持网页截图、表单填写、数据提取
  - Chromium 自动安装（文件锁防并发）
  - 开发模式自动安装 + 首次使用提示
  - 项目技能右键「同步至全局技能」
- **IM Bot 多媒体发送**：SDK 自定义工具 send_media，支持发送图片/文档到 IM
- **代理配置热更新**：Settings 修改代理后实时传播到所有运行中 Sidecar
- **MCP 添加面板 JSON 批量导入**：支持一次性导入多个 MCP 服务器 + DDG-Search 预设
- **工作区右键「用默认应用打开」**：文件可用系统默认程序打开
- **检测并清除 settings.json 环境变量覆盖**：防止 CLAUDE_CONFIG_DIR 等覆盖影响认证
- **agent-browser 反检测默认配置 + Profile 持久化**：自动生成 headed 模式、真实 UA、持久化 Profile 的反检测配置，解决知乎/微博等网站被拦截问题

### Fixed
- **Windows Sidecar 启动失败**：UNC 路径前缀导致 Bun 无法识别资源路径
- **Windows agent-browser 浏览器自动化不可用**：daemon 启动失败（无 Node.js）+ 命令找不到（Git Bash 不识别 .cmd）
- **Windows 技能同步失败**：symlink junction 删除需要 recursive 选项
- **Windows 启动诊断增强**：崩溃日志跨平台 + 启动 beacon + 健康检查可见化
- **agent-browser 构建产物缺失**：运行时报 "No binary found"
- **agent-browser 构建脚本预装卡死**：改用预生成 lockfile 秒级安装
- **macOS 公证失败**：agent-browser 原生二进制未签名
- **Global Sidecar pre-warm 异常**：无效 pre-warm 启动 + Tab pre-warm 超时误杀 + 僵尸进程
- **Global Sidecar 意外加载 MCP**：Settings/Launcher 不应加载用户 MCP 配置
- **IM Bot 重启后 "No conversation found" 死循环**
- **新会话首条消息 loading 状态闪断**
- **Windows 文件重命名导致文件被移到 AppData 目录**
- **供应商选择菜单溢出屏幕**
- **工作区大目录无法展开**（条目上限 50000）
- **macOS 全屏退出后 Tab 遮挡红绿灯**
- **Provider 验证 auth 错误未正确检测**：SDK 返回 403/401 时误报验证成功

### Changed
- **路径 normalize Pit of Success 重构**：源头统一处理，消除消费端重复 strip
- **Bun 输出接入统一日志**：Sidecar stdout/stderr 可在日志面板查看
- **消除 Rust 编译 warning**：平台分离 graceful shutdown 逻辑
- **Code Review 修复**：构建版本校验 + 签名失败硬中断 + 死代码清理

---

## [0.1.29] - 2026-02-27

### Added
- **火山方舟双供应商拆分**：原「火山引擎」拆分为两个独立供应商
  - 「火山方舟 Coding Plan」：baseUrl `/api/coding`，预设 Doubao Seed 2.0 Code、GLM 4.7、DeepSeek V3.2、Kimi K2.5
  - 「火山方舟 API调用」：baseUrl `/api/compatible`，预设 Doubao Seed 2.0 Pro/Code Preview/Lite
- **用户级 Skill 原生可用**：Skill enable/disable 通过 SDK staging directory 过滤，支持项目级 symlink 同步
- **远程 MCP 连接验证**：新增 SSE/HTTP 类型 MCP 服务器的连接可达性检测
- **新增阿里云百炼供应商**：Coding Plan 预设，支持 Qwen 3.5 Plus、Kimi K2.5、GLM 5、MiniMax M2.5

### Fixed
- **系统代理泄漏导致网络超时**：清理继承的代理环境变量 + 禁用 SDK 非必要流量
- **IM Bot "No conversation found" 死循环**：过期 session 自动重置
- **飞书 WebSocket 死连接检测**：增加 read timeout 及时发现断线
- **Skill symlink 完整性**：CRUD 同步 + 悬空清理 + 死代码清除
- **全局 Command 同步到项目目录**：SDK 静默错误在持久 Session 中可靠展示
- **供应商切换按钮可点击区域过小**：增大 hover/click 区域提升交互体验

### Changed
- **Skill 同步改用项目级 symlink**：避免 CLAUDE_CONFIG_DIR 破坏订阅认证
- **Code Review 修复**：is_error 错误样式 + 函数重命名 + Windows 注释

---

## [0.1.28] - 2026-02-26

### Added
- **IM Bot 群聊完整支持**：实现群聊全链路功能
  - 群授权审批流程：Bot 入群 → 桌面端 pending/approved 管理 → 群内提示消息
  - 智能触发模式：mention 模式（@Bot / 回复 Bot / `/ask`）+ always 模式（NO_REPLY 静默）
  - 群聊上下文增强：发送者身份 `[from: name]`、Pending History 积累、群聊系统提示
  - 安全隔离：群工具黑名单（SDK disallowedTools）、Heartbeat 屏蔽群聊
  - 前端 UI：群权限管理列表（折叠/徽标）+ 激活模式切换
  - 飞书：用户名 LRU 缓存、群事件检测、@mention 检测
  - Telegram：my_chat_member 订阅、reply-to-bot 检测、大小写不敏感 @mention
- **ultra-research bundled skill**：新增 ultra-research 内置技能

### Fixed
- **定时任务不执行**：SDK 升级后要求 `--resume` 参数为标准 UUID 格式，旧 `cron-im-{uuid}` 前缀格式被拒绝导致进程退出。Session ID 改用纯 UUID，并增加三级 UUID 校验策略兼容历史数据
- **用户消息换行符双倍渲染**：`whitespace-pre-wrap` CSS 与 `remarkBreaks` 插件冲突，ReactMarkdown 在块元素间插入的 `\n` 文本节点被二次渲染为可见换行
- **图片自动缩放移至后端统一处理**：前端 Canvas API 缩放无法覆盖 IM Bot 图片路径（Telegram/飞书图片走 Rust→Bun 管道），且 GIF 缩放后 mimeType 不一致。迁移到后端 `enqueueUserMessage()` 使用 jimp 统一处理

---

## [0.1.27] - 2026-02-25

### Added
- **Cron 工具 runs/status/wake 能力增强**：IM Bot 的 `cron` 工具新增三个 action
  - `runs`：查询任务历次执行记录（JSONL 持久化，上限 500 条）
  - `status`：查询当前 Bot 的任务统计（总数/运行中/最近执行/下次执行）
  - `wake`：手动触发即时心跳检查，支持注入文本到 Bot Sidecar
- **Cron 任务 `updatedAt` 字段**：记录最后活动时间（创建/启动/停止/执行/编辑），任务列表按最近操作排序

### Fixed
- **Heartbeat 502 Bad Gateway**：HeartbeatRunner 的 reqwest 客户端缺少 `.no_proxy()`，系统代理拦截 localhost 请求
- **Cron 结果未投递到 IM**：`deliver_cron_result_to_bot()` 使用 `reqwest::Client::new()` 同样缺少 `.no_proxy()`，system-event POST 失败导致心跳触发普通提示而非 Cron 结果注入
- **IM Bot Cron 定时任务结果投递链路三层修复**：一次性定时任务执行后立即停止导致跳过投递、heartbeat JSON 解析 `sidecar_port` 类型不匹配、Cron session_id 与 IM peer session_id 不一致
- **Tab 间 Provider/Model 交叉污染**：`selectedProviderId` 从全局变量改为 Tab 局部状态，避免切换 Tab 时污染其他 Tab 的供应商选择
- **用户消息气泡换行符不显示**：`<HEARTBEAT>` 标签触发 Markdown HTML block 模式，绕过 remarkBreaks，通过 `whitespace-pre-wrap` 修复
- **任务中心列表不刷新**：重启任务后列表不更新，新增 `cron:task-started` 事件从 Rust 同步发射，前端即时监听刷新
- **Session 消息计数归零**：Sidecar 重启后首条消息触发 `createSessionMetadata()` + `saveSessionMetadata()` 全量替换 sessions.json 条目，导致累积 stats 被清空。改为先检查已有 metadata 再决定创建或更新
- **统一日志日期不一致**：Bun 侧 `toISOString()` 产生 UTC 日期，与 Rust 本地日期不同，UTC+8 时区下日志分散到不同文件

### Changed
- **`local_http` 模块集中化**：所有 localhost reqwest 客户端统一通过 `crate::local_http::builder()` 创建，内置 `.no_proxy()`，消除散落在 7 个文件中 11 处 `.no_proxy()` 调用的遗漏风险
- **定时任务列表排序优化**：running 组按 nextExecutionAt 升序，stopped 组按 updatedAt 降序（最近有操作的在前）

---

## [0.1.26] - 2026-02-24

### Changed
- **前端配置服务域拆分**：将 1028 行 configService.ts 上帝模块拆分为 6 个域模块（configStore / appConfigService / providerService / mcpService / projectService / projectSettingsService），原文件保留为 barrel re-export，所有现有 import 无需修改
- **ConfigProvider 共享状态架构**：新增 ConfigProvider 双 Context（ConfigDataContext + ConfigActionsContext），消除 useConfig 独立 hook 多调用者状态不同步问题。useConfig 改为兼容 wrapper，现有消费者零改动
- **消除 CONFIG_CHANGED DOM 事件桥接**：配置变更通过 ConfigProvider 的 setState 直接同步，不再依赖 window.dispatchEvent 临时方案
- **im:bot-config-changed 监听上移**：从 ImBotDetail 移入 ConfigProvider，所有消费者通过 Context 自动获得最新配置
- **atomicModifyConfig 统一写入模式**：providerService 和 mcpService 的 9 处写入函数从手动 lock+read+write 改为 atomicModifyConfig，_writeAppConfigLocked 收为模块私有
- **IM Bot 配置架构统一**：建立 Rust 层作为 IM Bot 配置唯一管理者，前端和 IM 命令共享同一条配置变更通道

### Fixed
- **safeWriteJson 并发读写竞态**：备份步骤从 rename（删除原文件）改为 copyFile（保留原文件），消除并发读取时 "No such file or directory" 错误
- **safeLoadJson 读操作中写文件竞态**：改为纯只读恢复，不在读操作中触发写入
- **共享 isLoading 全局闪烁**：移除 Launcher/Settings 的冗余 reloadConfig 调用，避免 ConfigProvider 共享 isLoading 导致 ImSettings 等组件闪烁
- **Windows 手动检查更新误报「已是最新版本」**

---

## [0.1.25] - 2026-02-23

### Added
- **任务中心（Task Center）**：新增全局任务面板，集中查看所有会话（对话、定时任务、IM Bot 后台会话）
  - 会话列表支持分类标签（对话/定时/IM）和最后一条消息预览
  - 定时任务详情面板，展示 cron 信息和运行状态
  - 后端支持 cron 信息聚合、后台会话查询、IM 事件上报
- **会话列表 Hover 菜单**：会话列表项支持悬停显示统计信息和删除操作，ConfirmDialog 支持键盘操作（Enter/Escape）
- **PlanMode 方案审核**：接入 SDK 的 ExitPlanMode/EnterPlanMode 工具
  - ExitPlanMode 卡片展示 AI 生成的方案内容，用户可批准/拒绝
  - 卡片在用户决策后保留显示「已批准/已拒绝」状态
  - 支持权限模式热切换（运行中切换 Plan ↔ Auto）
  - EnterPlanMode 自动批准，无需用户手动确认

### Fixed
- **中文文件名图片预览 500 错误**：含中文字符的图片路径导致预览接口返回 500
- **Agent 错误展示**：报错时展示详细错误描述，而非仅显示错误码
- **ExitPlanMode 卡片位置错位**：卡片从 Message 外部移入内部（slot 模式），解决用户批准后新内容「插入」到卡片上方的视觉问题

### Changed
- **全局 Overlay 毛玻璃遮罩统一**：所有 Overlay 遮罩统一使用 `bg-black/30 backdrop-blur-sm`
- **ExitPlanMode 卡片样式**：宽度与工具行对齐（撑满父容器），方案内容区高度增加 30%
- **ProcessRow 简化**：移除 thinking 指示器的特殊颜色样式

---

## [0.1.24] - 2026-02-23

### Added
- **OpenAI 兼容协议桥接**：内置 Anthropic → OpenAI Chat Completions API 转译桥，支持 OpenAI 兼容端点（DeepSeek、Qwen 等）通过 loopback 架构接入 Claude Agent SDK。包含完整的请求/响应转译、SSE 流式传输、`reasoning_content` ↔ thinking block 双向映射、代理感知上游请求
- **统一日志导出**：设置 > 通用 > 运行日志区域新增导出按钮，将近 3 天统一日志打包为 zip 导出到桌面

### Fixed
- **IM Bot `/provider` & `/model` 命令配置持久化**：命令切换 Provider/Model 后持久化到 config.json 并同步 Sidecar，前端设置页实时刷新
- **IM Bot Session ID 失同步**：第三方 → Anthropic 供应商切换时 Bun 内部新建 session，Rust 侧通过 `upgrade_peer_session_id()` 同步 PeerSession + SidecarManager
- **IM Bot auto-start availableProvidersJson 缺失**：前端启动时持久化 `availableProvidersJson` 到磁盘，Rust auto-start 迁移逻辑兼容旧配置
- **IM Bot `/model` 动态模型列表**：`/model` 命令显示当前供应商可用模型索引列表，支持按序号选择

---

## [0.1.23] - 2026-02-22

### Fixed
- **IM Bot 第三方模型 auto-start 失败**：`providerEnvJson`（含 baseUrl/apiKey/authType）只在前端手动启动时构建，Rust auto-start 从磁盘读不到 → 第三方供应商（DeepSeek、Moonshot 等）报 "所选模型不可用"。现在前端在启动/切换 Provider 时持久化 `providerEnvJson` 到 config.json
- **IM Bot auto-start 向前兼容迁移**：Rust 侧新增 `migrate_provider_env()`，对旧配置（无 `providerEnvJson` 字段）从 `providerApiKeys` + 预设供应商 baseUrl 映射自动重建，确保升级后首次 auto-start 即可用
- **IM Bot `/new` 命令 port 0 崩溃**：App 重启后恢复的 session `sidecar_port` 为 0，`/new` 发起 HTTP 请求到 `127.0.0.1:0` 导致报错。现在检测 port 0 时本地重置 session 元数据
- **IM Bot SDK 错误透传与本地化**：SDK `is_error` 标志正确透传到 IM 端、图片历史污染自动重置 session、新增 6 类错误中文本地化（认证失败、频率限制、余额不足、模型不可用等）
- **更新检查 Toast 重复**：后台下载进行中时重复弹出"正在下载更新"提示

---

## [0.1.22] - 2026-02-22

### Added
- **飞书 Bot 多媒体接收**：支持接收图片、文件、音频、视频附件，图片走 SDK Vision，文件保存到工作区
- **MCP 内置服务器 args/env 配置**：内置 MCP 服务器支持自定义启动参数和环境变量
- **download-anything 内置 Skill**：新增文件下载 bundled skill
- **Mermaid 图表预览/代码切换**：Mermaid 代码块新增预览/源码切换按钮和复制按钮
- **YAML Frontmatter 代码高亮**：文件预览中 YAML frontmatter 渲染为语法高亮代码块
- **上传文件功能升级**：Plus 菜单「上传图片」升级为「上传文件」，支持更多文件类型

### Fixed
- **心跳/IM 消息竞态条件**：心跳 runner 未获取 peer_lock 导致与用户消息并发访问 imStreamCallback，造成响应丢失和双重 "(No response)"。现在心跳与用户消息通过 peer_lock 串行化，Bun 侧增加纵深防御
- **Monaco 编辑器 CJK 输入法**：修复中日韩输入法组合输入时的闪烁和异常行为（两轮修复）
- **Mermaid 图表加载卡死**：多图表场景下 Mermaid 渲染卡在 loading 状态
- **模态框拖拽误关闭**：拖拽选中文本到遮罩层时不再误触发关闭
- **Bot 工作区复制校验**：从 bundled mino 复制工作区时增加校验和 fallback
- **飞书向导步骤优化**：「添加应用能力-机器人」提前到 Step 1，减少配置遗漏

### Changed
- **Launcher 工作区选择器**：从输入框上方浮动 pill 移入输入框工具栏内，布局更紧凑
- **README 更新**：同步当前功能列表、支持的供应商和架构说明

---

## [0.1.21] - 2026-02-21

### Added
- **Bot 创建向导新增工作区步骤**：创建 Bot 时可直接配置独立工作区路径
- **飞书 Post 富文本消息支持**：Bot 接收飞书 Post 类型消息（含代码块、加粗、列表等富文本），解析 text/a/at/img/emotion/code_block 元素为纯文本
- **IM Bot /help 命令**：飞书和 Telegram Bot 均支持 `/help` 查看所有可用命令
- **IM Bot /mode 命令**：通过 `/mode plan|auto|full` 切换权限模式（计划/自动/全自主）
- **工作区文件单击预览**：右侧「项目工作区」面板中单击文件直接触发预览（原需双击），Ctrl+单击多选保持不变

### Fixed
- **飞书 Bot 幽灵消息**：dedup 缓存持久化到磁盘（TTL 72h），App 重启后不再重复处理飞书重传的旧事件
- **飞书消息静默丢失**：含代码块/加粗等格式的消息（msg_type: post）不再被忽略
- **IM 来源标签错误**：飞书消息不再显示 "via Telegram 群聊"，改用 SOURCE_LABELS 映射正确显示平台名
- **Provider API Key 验证超时**：使用 project-level settingSources 和 bypassPermissions 避免用户级插件加载阻塞
- **文件预览 FileReader 挂起**：添加 onerror/reject 处理，防止 Blob 损坏时 isPreviewLoading 永久卡死
- **Tab 关闭确认误弹**：持久 Owner 保持 Sidecar 存活时跳过关闭确认
- **Telegram 向导输入顺序**：修正向导步骤输入框顺序，跳过按钮改为返回按钮
- **绑定消息误处理**：已绑定用户的 BIND 消息静默忽略，避免重复处理

### Performance
- **前端流式消息隔离**：Playwright tool.result 从前端剥离，流式消息状态独立管理，减少不必要的重渲染

### Changed
- **飞书代码块输出样式**：AI 回复中的代码块使用 `─── ✦ ───` 分隔线 + 斜体缩进，内联代码映射为加粗+斜体
- **IM Bot 热更新**：权限模式、MCP 服务器、Provider 等配置变更无需重启 Bot
- **Heartbeat 系统提示词**：心跳检查使用独立 system prompt，修复 Bot 停止/重启可靠性

---

## [0.1.20] - 2026-02-19

### Added
- **飞书 Bot 平台支持**：新增飞书适配器（WebSocket 长连接 + protobuf），与 Telegram 共享多 Bot 架构、Session 路由、消息缓冲
- **IM Bot 交互式权限审批**：非 fullAgency 模式下，工具权限请求通过飞书交互卡片 / Telegram Inline Keyboard 展示，用户点击按钮或回复文本完成审批
- **ZenMux 预设供应商**：新增 ZenMux 云服务商聚合平台，支持 9 个预设模型（zenmux/auto、Gemini 3.1 Pro、Claude Sonnet/Opus 4.6 等）

### Fixed
- **飞书 WebSocket 事件重放**：新增数据帧 ACK 机制，dedup 缓存 TTL 从 30 分钟延长至 24 小时，防止断连重连后消息重复处理
- **IM Bot 停止按钮状态回弹**：`toggleBot` 写盘后未调用 `refreshConfig()` 同步 React 状态，导致轮询 fallback 到过期的 `cfg.enabled`
- **工具输入截断 UTF-8 panic**：权限审批卡片中 `tool_input[..200]` 字节截断改为 `char_indices().nth(200)` 字符安全截断

---

## [0.1.19] - 2026-02-18

### Added
- **IM 多 Bot 架构**：支持创建和管理多个 Telegram Bot 实例，独立配置工作区、权限、AI 供应商和 MCP 工具
- **IM Bot AI 配置**：每个 Bot 独立设置 Provider/Model/MCP 服务，支持 Telegram `/model` 和 `/provider` 命令切换
- **Telegram 多媒体消息支持**：支持图片（SDK Vision）、语音、音频、视频、文档（保存到工作区）、贴纸、位置、相册（500ms 缓冲合并）
- **IM Bot 自动启动**：应用启动时自动恢复上次运行中的 Bot

### Fixed
- **Telegram 代理支持**：文件下载复用代理配置的 HTTP 客户端
- **IM Bot 启停按钮状态回弹**：轮询跳过正在操作的 Bot，避免覆盖乐观更新；toggleBot 使用 ref 读取最新状态消除闭包陈旧
- **TodoWriteTool 白屏崩溃**：流式 JSON 解析中间态 `todos` 可能为对象而非数组，改用 `Array.isArray()` 守卫
- **IM 私聊 emoji 移除**：去掉 Telegram 私聊消息的手机 emoji，群聊保留群组图标
- **IM Bot 列表页 UI 闪烁**：消除空状态闪烁和按钮颜色闪烁
- **多媒体安全加固**：文件名路径穿越防护（sanitize_filename）、下载大小限制（20MB）、图片编码限制（10MB）、异步文件 I/O

### Changed
- **IM 会话列表标签化**：用平台标签替代 emoji 标识 IM 来源
- **SDK 升级**：claude-agent-sdk 升级至 0.2.45
- **模型更新**：新增 Sonnet 4.6，移除 Opus 4.5

---

## [0.1.18] - 2026-02-17

### Added
- **用户消息气泡 Hover 菜单**：鼠标悬停显示操作菜单（复制、时间回溯），Tooltip 提示
- **时间回溯功能**：回溯对话到指定用户消息之前的状态，回退文件修改，被回溯的消息文本恢复到输入框
- **Launcher 工作区设置双向同步**：工作区卡片设置面板变更实时同步到已打开的 Tab

### Performance
- **持久 Session 架构**：SDK subprocess 全程存活，消除每轮对话的 spawn → init → MCP 连接 → 历史重放开销
  - 事件驱动 Promise 门控替代 100ms 轮询，消息交付零延迟
  - 对话延迟不再随历史消息增长线性退化
  - 净减少约 106 行代码（删除 `executeRewind` 等死代码）

### Fixed
- **permissionMode 映射错误**：「自主行动」（auto）和「规划模式」（plan）权限模式实际使用了 `default`，现已正确映射到 SDK 的 `acceptEdits` 和 `plan`
- **订阅供应商误显可用**：未验证订阅的供应商不再显示为可用，发送按钮和 Enter 键增加供应商可用性守卫
- **持久 Session 启动超时死锁**：startup timeout 改用统一中止 `abortPersistentSession()`，解除 generator Promise 门控阻塞
- **Rewind SDK 历史未截断**：`resumeSessionAt` 在 pre-warm 中正确传递，确保 SDK 历史与前端同步截断
- **Rewind 后 AI 重复已回答内容**：assistant `sdkUuid` 改存最后一条消息（text）而非第一条（thinking），确保 `resumeSessionAt` 保留完整回复
- **超时链路对齐**：Cron 执行超时 11min → 60min，智谱 AI 超时 50min → 10min，Permission 等待 5min → 10min
- **用户消息气泡宽度**：最大宽度改为容器 2/3，文字先横向扩展再换行

---

## [0.1.17] - 2026-02-16

### Added
- **工作区记住模型和权限模式**：每个工作区独立保存最近使用的 model 和 permissionMode，切换时自动恢复

### Performance
- **Tab 切换性能深度优化**：隔离 isActive 到独立 TabActiveContext，content-visibility 延迟渲染，组件 memo + ref 稳定化，消除切换时全量重渲染

### Fixed
- **启动页图片粘贴报错** + Tab 栏单击不选中
- **首次启动卡死**：projects.json 损坏恢复 + 日志重复修复
- **Windows 更新重启 bun 进程未清理**：kill_process 改用 taskkill /T /F 杀进程树，新增 shutdown_for_update 阻塞等待所有进程退出，Settings 页更新按钮同步修复
- **JSON 持久化加固**：所有 JSON 配置文件统一使用原子写入（.tmp → .bak → rename），三级恢复链（.json → .bak → .tmp）+ 结构校验，防止进程崩溃导致数据丢失

---

## [0.1.16] - 2026-02-14

### Added
- **启动页改版——任务优先模式**：左侧 BrandSection 新增全功能输入框 + 工作区选择器，支持直接发送消息启动工作区
  - 工作区选择器：默认/最近打开分组、向上展开菜单
  - 输入框复用 SimpleChatInput，支持文本、图片、Provider/Model、权限模式、MCP 工具选择
  - 发送设置自动持久化，下次启动恢复上次选择
- **默认工作区 mino**：内置 openmino 预设工作区，首次启动自动复制到用户目录
- **Settings 默认工作区配置**：通用设置新增默认工作区选择，自定义 CustomSelect 替换原生 select
- **Windows setup 补充 mino 克隆**：`setup_windows.ps1` 与 macOS `setup.sh` 对齐

### Changed
- **Launcher 右侧面板精简**：移除快捷功能区块，工作区卡片精简为可点击双列紧凑卡片
  - 移除 Provider 选择器、启动按钮、三点菜单
  - 整卡点击启动，右键上下文菜单移除工作区
  - 工作区列表从单列改为双列 grid 布局
- **视觉统一与细节打磨**
  - Launcher 左右区域背景色统一，分割线改为不到顶的浮动线
  - Settings 侧边栏分割线同步改为浮动线
  - 品牌标题字号调小、字间距加宽，Slogan 更新为中文
  - MCP 工具菜单开关样式对齐设置页（accent 暖色 + 白色滑块）
  - Provider/MCP 静态卡片移除无效 hover 阴影
- **日志面板改版**：过滤器三组重构、新增导出功能、默认隐藏 stream/analytics

### Removed
- 移除 Launcher 死代码：subscriptionStatus 无用 API 调用、onOpenSettings 死 prop、QuickAccess 组件

---

## [0.1.15] - 2026-02-13

### Added
- **文件预览器 Markdown 本地图片加载**：相对路径引用的图片通过 download API 解析显示，支持 `./`、`../` 路径
- **MiniMax 预设新增模型**：M2.5、M2.5-lightning，M2.5 设为默认
- **文件预览器顶部信息优化**：文件大小改 KB/MB 格式、副标题改路径显示、新增「打开所在文件夹」按钮
- **macOS 路径显示缩短**：全局路径展示将 `/Users/<name>/` 替换为 `~/`

### Performance
- 流式渲染性能优化：消除级联重渲染，输入框/侧边栏不再卡顿

### Fixed
- 修复流式回复中段落分裂（防御性合并相邻文本块）
- 修复系统暗色主题导致 UI 颜色异常（强制日间模式）

---

## [0.1.14] - 2026-02-11

### Added
- **后台会话完成**：AI 流式回复中切换对话/关闭标签页不再丢失数据，旧 Sidecar 在后台继续运行直到回复完成
- **手动检查更新**：设置页「关于」区域增加检查更新按钮与下载进度展示
- **MCP 服务器编辑**：自定义 MCP 卡片增加设置按钮，复用添加弹窗编辑配置
- **新增预设供应商**：硅基流动 SiliconFlow（Kimi K2.5、GLM 4.7、DeepSeek V3.2、MiniMax M2.1、Step 3.5 Flash）
- **供应商「去官网」链接**：7 个预设供应商卡片增加官网入口
- **智谱 AI 新增 GLM 5 模型**
- **Settings 双栏布局**：供应商、MCP、技能、Agent 页面统一为双栏卡片网格

### Changed
- Settings 页面样式全面统一（Toggle、Button、Card、Input、Modal 共 24 处对齐）

### Fixed
- 修复首消息 5~13 秒延迟（stale resumeSessionId + 模型未同步导致阻塞）
- 修复编辑供应商保存时 API Key 被清空（React config 状态覆盖磁盘数据）
- 修复定时任务超时导致流式数据丢失（四层防御）
- 修复自定义 MCP 启用检测找不到系统 npx/node（PATH 环境变量未传递）
- 修复 MCP 设置按钮无响应 & 切换 Tab 残留 MCP 面板（Modal 渲染位置错误）
- 修复 Launcher 移除按钮使用未定义 CSS 变量 `--danger`
- 修复 Windows CSP 配置缺失导致 IPC 通信失败

---

## [0.1.13] - 2026-02-10

### Added
- **消息队列**：AI 响应中可追加发送消息，排队消息在当前响应完成后自动执行
  - 排队消息合并为右对齐半透明面板，支持取消和立即发送操作
  - 采用 Optimistic UI 模式，回车即清空输入框
  - 与心跳循环兼容：Cron 消息走正常队列，不中断当前 AI 响应
- **后台任务实时统计**：后台 Agent 运行时显示实时运行时间和工具调用次数
  - 通过轮询 output_file 获取增量数据，3 秒刷新
  - 折叠视图显示"后台"徽标和"(后台)"标签后缀
- **自定义服务商认证方式选择器**：创建/编辑自定义服务商时可选择 AUTH_TOKEN 或 API_KEY
- **工作区文件夹右键刷新**：文件夹右键菜单新增「刷新」按钮，ContextMenu 组件支持分隔线

### Changed
- **停止按钮三态交互**：点击停止按钮立即显示"停止中"视觉反馈（Loader 旋转），后端中断超时从 10s 缩短至 5s

### Fixed
- 修复历史会话切换供应商时 "Session ID already in use" 错误（区分历史/新会话的 resume 策略）
- 修复 Provider 切换时 pre-warm 未完成导致 resume 无效 session ID 的错误
- 修复 Cron single_session 模式下误中断当前 AI 响应
- 修复队列 SSE 事件未注册导致前端排队面板不显示
- 修复心跳循环状态栏背景透明导致内容透出
- 修复排队面板与心跳状态栏层级顺序（心跳始终紧贴输入框）

### Security
- 修复后台任务轮询端点路径穿越漏洞（resolve + homeDir 校验）
- 错误消息 ID 改用 crypto.randomUUID() 避免碰撞
- queue:started 广播携带 attachments，消除前端附件数据源不可靠隐患

---

## [0.1.12] - 2026-02-08

### Added
- **AI 输出路径可交互**：对话中内联代码如果是真实存在的文件/文件夹路径，自动显示虚线下划线，点击或右键弹出快捷菜单（预览、引用、打开所在文件夹）

### Fixed
- **Tab 栏触控板交互优化**：Mac 触控板轻触切换 Tab 不再误触发拖拽
- **Tab 关闭按钮偶尔无响应**：缩小拖拽监听范围至标题区域，扩大关闭按钮热区
- **Monaco Editor 大文件卡死**：延迟挂载编辑器 + 大文件自动降级纯文本模式
- **图片文件右键预览菜单**：右键菜单的「预览」选项现在对图片文件也可用

---

## [0.1.11] - 2026-02-06

### Added
- **Sub-Agent 能力管理**：为 AI 配备多种"专家角色"，模型自主判断何时委派
  - 支持全局 Agent（`~/.myagents/agents/`）和项目 Agent（`.claude/agents/`）双层管理
  - Agent 定义文件与 Claude Code 格式完全兼容（Markdown + YAML Frontmatter）
  - 可配置工具限制、模型选择、权限模式、最大轮次等
  - 项目工作区支持引入全局 Agent（引用机制，实时同步）
  - 启用/禁用控制，禁用的 Agent 不注入 SDK
  - 从 Claude Code 同步全局 Agent
- **Chat 侧边栏「Agent 能力」面板**：展示当前项目已启用的 Sub-Agents / Skills / Commands
  - 折叠/展开面板，按类型分组显示
  - 悬停查看描述，点击 Skill/Command 插入到输入框
  - 右键菜单快速跳转设置页
- **预置内置技能**：开箱即用 6 个常用技能
  - docx（Word 文档）、pdf、pptx（PPT）、xlsx（Excel）、skill-creator（技能创建向导）、summarize（内容摘要）
  - 首次启动自动种子到 `~/.myagents/skills/`，不覆盖用户已有内容
- **全局技能启用/禁用**：Settings 技能列表支持 toggle 开关
  - 禁用的技能不出现在 `/` 斜杠命令和能力面板中
  - 状态持久化到 `~/.myagents/skills-config.json`

### Changed
- **统一 Session ID 架构**：通过 SDK 0.2.33 新特性消除双 ID 映射，新 session 在产品层和 SDK 层使用同一 ID
- 升级 Claude Agent SDK 到 0.2.34
- **SDK 预热机制**：打开 Tab 时提前启动 SDK 子进程和 MCP 服务器，消除首次发送消息的冷启动延迟
  - 500ms 防抖批量处理快速配置变更
  - 预热失败自动重试（最多 3 次），配置变更时重置
  - 预热会话对前端不可见，首条消息时无缝切换为活跃状态
- **MCP 版本锁定**：预设 MCP 服务（Playwright）锁定到具体版本号，避免每次启动的 npm 注册表查询延迟（2-5s）
- **网络代理设置移至「通用」**：从「关于 - 开发者模式」移至「通用设置」，普通用户可直接使用
- Settings 页面新增 Agents 分区，与 Skills 平级
- WorkspaceConfigPanel 新增 Agents Tab

---

## [0.1.10] - 2026-02-05

### Added
- **定时任务功能**：让 AI Agent 按设定周期自动执行任务
  - 支持设置任务间隔时间（分钟）
  - 多种结束条件：截止时间、执行次数、AI 主动退出
  - 运行模式：单 Session 持续执行 / 每次新建 Session
  - 任务运行时输入框显示状态遮罩，支持查看设置和停止任务
  - 历史记录中显示「定时」标签标识
- **后台运行支持**：应用可最小化到系统托盘持续运行
  - 点击关闭按钮最小化到托盘（可在设置中关闭）
  - 托盘右键菜单：打开、设置、退出
  - macOS 点击 Dock 图标恢复窗口
  - macOS 菜单栏使用标准模板图标
  - 退出时若有运行中任务会弹窗确认
- **通用设置页面**：新增「通用」设置 Tab
  - 开机启动开关
  - 最小化到托盘开关
  - 任务消息通知开关
- **技术架构升级**：Session-Centric Sidecar 管理，支持多入口（Tab/定时任务）共享 Agent 实例

---

## [0.1.9] - 2026-02-02

### Added
- **MCP 零门槛使用**：预设 MCP（如 Playwright）使用内置 bun 执行，无需安装 Node.js
- **MCP 运行时检测**：启用自定义 MCP 时自动检测命令是否存在，不存在则弹窗引导下载
- **系统通知**：AI 任务完成、权限请求、问答确认时自动发送系统通知（窗口失焦时）
- 技能/指令卡片展示作者信息
- Chat 页面顶部显示当前项目名称

### Changed
- 项目设置只展示项目级数据，新增「查看用户技能/指令」跳转链接
- 项目设置图标改为黑底白色齿轮
- 输入框视觉优化：更大的字号和行高
- 快捷功能卡片改为横向布局
- 项目工作区折叠按钮移至标题栏最右端

### Fixed
- 彻底修复 Chat 页面滚动回弹问题
- **Windows 10 1909 兼容性修复**：安装程序自动安装 Git for Windows（Claude Agent SDK 依赖）

---

## [0.1.8] - 2026-02-01

### Added
- **Analytics 系统**
  - 匿名使用统计，帮助改进产品体验
  - 默认关闭，需通过环境变量 `MYAGENTS_ANALYTICS_ENABLED=true` 启用
  - 支持事件批量发送、防抖、节流（每分钟最多 200 事件）
  - 数据加密传输，不收集任何敏感信息（代码、对话内容等）
  - device_id 持久化存储到 `~/.myagents/device_id`（跨安装保持一致）


---

## [0.1.7] - 2026-01-31

### Added
- Windows 平台开发工具（`build_dev_win.ps1`）
- 设置页面「关于」新增用户交流群二维码（自动缓存，离线可用）
- 代理配置支持（Settings > About > Developer Mode）
  - 支持 HTTP/HTTPS/SOCKS5 协议
  - 自动应用于 Claude Agent SDK 和应用更新下载

### Changed
- 改进 Windows 安装器升级体验，支持直接覆盖安装（无需先卸载旧版本）
- 优化网络连接池配置（降低资源占用）

### Fixed
- **Windows 平台关键修复**：
  - 修复 Windows 生产包无法启动的问题
  - 修复 Sidecar 连接失败（代理配置冲突）
  - 修复 Windows Tauri IPC 通信错误（CSP 配置不完整）
  - 修复构建脚本导致的配置缓存问题
  - 修复启动页工作区名称显示完整路径（应显示文件夹名）
  - 修复工具徽章 Windows 路径显示问题（3 处）
- 修复二维码加载失败问题（Windows CSP 限制）
- 修复代理环境下 localhost 连接失败
- 修复 Tab 关闭确认对话框无效（正在生成时关闭未被阻止）
- 修复 Windows 关闭最后一个 Tab 时程序退出
- 修复 React ref 在渲染期间更新（ESLint 警告）
- 修复多项代码质量问题（进程清理竞态、错误处理等）

### Technical
- 统一代理配置模块，消除代码重复
- Tab 关闭确认重构：使用 ConfirmDialog 替代 window.confirm()（符合 React 声明式编程）
- 路径处理标准化：优先使用 Tauri `basename()` API，同步场景使用 `/[/\\]/` 正则
- 完善错误处理和日志记录
- 增强构建脚本健壮性（清理验证、容错处理）
- 新增技术文档：代理配置、构建问题排查、Windows 平台指南

**详见**: [specs/prd/prd_0.1.7.md](./specs/prd/prd_0.1.7.md)

---

## [0.1.6] - 2026-01-30

### Added
- **Windows 客户端支持**
  - NSIS 安装包 (`MyAgents_x.x.x_x64-setup.exe`)
  - 便携版 ZIP (`MyAgents_x.x.x_x86_64-portable.zip`)
  - 自动更新支持（共用 Tauri 签名密钥）
- 新增 Windows 构建脚本
  - `setup_windows.ps1` - 环境初始化
  - `build_windows.ps1` - 构建脚本
  - `publish_windows.ps1` - 发布脚本（含 `latest_win.json` 生成）
- 新增 `src/server/utils/platform.ts` 跨平台工具模块
- **支持 `server_tool_use` 内容块类型**（第三方 API 如智谱 GLM-4.7 的服务端工具调用）
- **设置页面添加用户交流群二维码**
  - 位于「关于」页面，从 R2 动态加载
  - 网络异常时自动隐藏
  - 新增 `upload_qr_code.sh` 上传脚本
- **MCP 表单 UI 改进**
  - 优化服务器配置表单交互体验

### Changed
- `runtime.ts` 支持 Windows 路径检测 (`bun.exe`, `%USERPROFILE%\.bun`, etc.)
- `sidecar.rs` 支持 Windows 进程管理 (`wmic` + `taskkill`)
- 统一跨平台环境变量处理（消除 10+ 处重复代码）
- **全局视觉优化与设计规范更新**
- 工作区右键菜单「快速预览」改为「预览」
- **会话统计 UI 优化**
  - 「缓存读取」改为「输入缓存」（= cache_read + cache_creation）
  - 消息明细新增「输入缓存」列

### Fixed
- 修复 Windows 自定义标题栏按钮无效（缺少 Tauri 权限）
- 修复 UI 卡在 loading 状态（`chat:system-status` 事件未注册 + React 批量更新延迟）
- 修复 `MultiEdit` 工具完成后工作区不刷新
- 修复 MCP 服务器和命令系统的 Windows 跨平台路径问题
- 修复智谱 GLM-4.7 `server_tool_use` 的输入解析（JSON 字符串 → 对象）
- 过滤智谱 API 返回的装饰性工具文本（避免干扰正常内容显示）
- **Token 统计修复**
  - 从 SDK result 消息提取统计数据（更可靠）
  - 支持多模型分别统计（新增 `modelUsage` 字段）
  - 修复智谱/Anthropic 等供应商统计数据为 0 的问题
- 修复流式输出中空白 chunk 过滤（保留有效换行和空格）
- 修复进程终止信号被错误保存为错误消息
- 为未知工具添加兜底图标 (Wrench)

### Technical
- Windows 数据目录：`%APPDATA%\MyAgents\`
- 添加 `buildCrossPlatformEnv()` 统一子进程环境变量构建
- 使用 `flushSync` 强制同步关键 UI 状态更新
- 装饰性文本过滤使用多条件匹配，避免误伤正常内容
- 新增 `ModelUsageEntry` 类型支持按模型分组存储 token 统计

**详见**: [specs/prd/prd_0.1.6.md](./specs/prd/prd_0.1.6.md)

---

## [0.1.5] - 2026-01-29

### Added
- 添加网络代理设置功能（开发者模式）
  - 支持 HTTP/SOCKS5 协议
  - 设置入口：设置 → 关于 → 点击 Logo 5次 → 开发者区域
  - Sidecar 启动时自动注入 HTTP_PROXY/HTTPS_PROXY 环境变量

### Changed
- 升级 Claude Agent SDK 从 0.2.7 到 0.2.23
- 建立 E2E 测试基础设施（Anthropic/Moonshot 双供应商测试）
- 统一 `/api/commands` 端点的命令解析逻辑
  - 使用 `parseFullCommandContent()` 替代 `parseYamlFrontmatter()`
  - 优先使用 frontmatter.name，回退到文件名
  - 提取 `scanCommandsDir()` 消除代码重复
- 统一版本记录到 CHANGELOG.md（移除 specs/version.md）

### Fixed
- 修复全局用户指令在对话 `/` 菜单中不显示的问题
  - `/api/commands` 端点新增扫描 `~/.myagents/commands/` 目录

### Technical
- 代理设置提取 `PROXY_DEFAULTS` 常量，消除魔数
- 添加 `isValidProxyHost()` 验证函数
- Rust 侧同步添加默认值常量

---

## [0.1.4] - 2026-01-29

### Added
- 支持编辑自定义供应商的名称、云服务商标签、Base URL、模型列表
- 编辑面板内增加「删除」按钮，附确认弹窗
- 删除供应商时自动切换受影响项目到其他可用供应商
- 模型标签 hover 显示删除按钮（用户添加的模型可删除）
- 预设供应商支持用户添加自定义模型
- 预设模型显示「预设」标签，不可删除
- 历史记录显示消息数和 Token 消耗统计
- 新增统计详情弹窗（按模型分组、消息明细）
- 无 MCP 工具时显示引导文案，链接至设置页面
- 工作区右键菜单「引用」（文件/文件夹/多选均支持插入 `@路径`）
- 新建技能对话框增加「导入文件夹」选项（桌面端）
- Moonshot 供应商新增 Kimi K2.5 模型

### Changed
- 消息存储升级为 JSONL 格式（O(1) 追加，崩溃容错）
- 增量统计计算、行数缓存、文件锁机制
- Tab 切换时自动同步供应商、API Key、MCP 配置
- Slash 命令菜单键盘导航时自动滚动保持选中项可见

### Fixed
- 修复消息中断后 Thinking Block 卡在加载状态
- 修复 API Key 模式切换到订阅模式报错（`Invalid signature in thinking block`）
- 修复长文本（如 JSON）在消息气泡中不换行
- 修复历史记录「当前」标签不更新
- 修复历史记录按钮点击无法关闭
- 修复加载历史会话后新消息统计不更新
- 修复 switchToSession 未终止旧 session 导致模型/供应商切换失效
- 修复三方供应商切换到 Anthropic 官方时 thinking block 签名冲突
- 修复第三方供应商模型切换后 UI 卡住（thinking/tool 块加载状态未结束）
- 修复 AI 回复完成后 Loading 指示器和停止按钮卡住（补全 9 种结束场景的 sessionState 重置）
- 修复发送消息后不自动滚动到底部
- 修复系统任务（如 Compact）期间显示停止按钮的误导
- 修复进程泄露问题（SDK/MCP 子进程随应用关闭正确清理）
- 优化文件预览性能（React.lazy + useMemo 缓存）

### Technical
- 应用退出支持 Cmd+Q 和 Dock 右键退出的进程清理（RunEvent::ExitRequested）
- 进程清理函数重构，统一 SIGTERM → SIGKILL 两阶段关闭
- 启动时清理扩展至 SDK 和 MCP 子进程

**详见**: [specs/prd/prd_0.1.4.md](./specs/prd/prd_0.1.4.md)

---

## [0.1.3] - 2026-01-27

### Added
- 支持从 Claude Code 同步 Skills 配置（`~/.claude/skills/` → `~/.myagents/skills/`）
- ProcessRow 显示任务运行时间
- 展开状态显示实时统计信息（工具调用次数、Token 消耗）
- 新增 Trace 列表查看子代理工具调用记录
- Settings 页面增加 Rust 日志监听

### Changed
- 技能/指令详情页焦点控制优化
- 描述区域支持多行输入
- 内容区域高度自适应视口

### Fixed
- 修复 Toast/ImagePreview Context 稳定性问题
- 统一 useEffect 依赖数组规范
- 统一定时器初始化模式
- 修复权限弹框重复弹出问题
- 修复 Settings 页面事件监听竞态条件
- 修复 tauri-plugin-updater 架构目标识别问题
- 移除非标准 platform 字段，符合 Tauri v2 官方 schema
- 修复事件发射错误处理
- 修复更新按钮样式（emerald 配色 + rounded-full）

### Technical
- 增加文件描述符限制至 65536，防止 Bun 启动失败
- 添加 `--myagents-sidecar` 标记精确识别进程
- 实现两阶段清理机制（SIGTERM → SIGKILL）
- 明确 Tab Sidecar 与 Global Sidecar 使用边界
- Settings/Launcher 不再包裹 TabProvider
- Release 构建启用 INFO 级别日志支持诊断
- 调试日志包装 `isDebugMode()` 避免生产环境刷屏

**详见**: [specs/prd/prd_0.1.3.md](./specs/prd/prd_0.1.3.md)

---

## [0.1.2] - 2026-01-25

### Added
- 实现自定义服务商完整的 CRUD 功能
- 服务商配置持久化到 `~/.myagents/providers/`

### Fixed
- 修复 MCP 开关状态与实际请求不一致问题
- 初始化时始终同步 MCP 配置（包括空数组）
- MCP 变化时正确重启 SDK 会话
- 切换配置时保持对话上下文（通过 resume session_id）
- 修复 AI "失忆" 问题
- 实现用户级 Skill 按需复制到项目目录
- `/` 菜单去重（项目级优先）
- 修复详情页交互问题（保存后自动关闭、名称字段、路径重命名）
- 修复 `/cost` 和 `/context` 命令输出不显示问题
- 正确处理 `<local-command-stdout>` 包裹的字符串内容

### Changed
- 设置页版本号动态读取
- 日志规范化（生产环境不输出调试日志）

**详见**: [specs/prd/prd_0.1.2.md](./specs/prd/prd_0.1.2.md)

---

## [0.1.1] - 2026-01-26

### Added
- 添加订阅凭证真实验证功能
- 设置页显示验证状态（验证中/已验证/验证失败）
- 支持拖拽文件到工作区文件夹
- 支持 Cmd+V 粘贴文件到工作区
- 支持拖拽/粘贴文件到对话输入框（自动复制到 `myagents_files/`）
- AskUserQuestion 工具向导式问答 UI
- 单选自动跳转 / 多选手动确认
- 自定义输入框支持
- 进度指示器和回退修改
- Agent 日志懒加载创建
- 日志存储到 `~/.myagents/logs/`
- React/Bun/Rust 日志统一到 UnifiedLogs 面板

### Fixed
- 修复 Anthropic 订阅检测逻辑（`~/.claude.json` 中的 `oauthAccount`）

### Changed
- 文件名冲突自动重命名
- Cmd+Z 撤销支持
- 30 天日志自动清理

**详见**: [specs/prd/prd_0.1.1.md](./specs/prd/prd_0.1.1.md)

---

## [0.1.0] - 2026-01-24

### Added
- Initial open source release
- Native macOS desktop application with Tauri v2
- Multi-tab support with independent Sidecar processes
- Multi-project management
- Claude Agent SDK integration
- Support for multiple AI providers:
  - Anthropic (Claude Sonnet/Haiku/Opus 4.5)
  - DeepSeek
  - Moonshot (Kimi)
  - Zhipu AI
  - MiniMax
  - Volcengine
  - OpenRouter
- Slash Commands (built-in and custom)
- MCP integration (STDIO/HTTP/SSE)
- Tool permission management (Act/Plan/Auto modes)
- Visual configuration editor for CLAUDE.md, Skills, and Commands
- Keyboard shortcuts (Cmd+T, Cmd+W)
- Local data storage in `~/.myagents/`

### Technical
- React 19 + TypeScript frontend
- Bun runtime bundled in app
- Rust HTTP/SSE proxy layer
- Chrome-style frameless window
- 零外部依赖（内置 Bun 运行时）

**详见**: [specs/prd/prd_0.1.0/](./specs/prd/prd_0.1.0/) (21 个迭代 PRD)

---
