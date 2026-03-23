---
name: support
description: MyAgents 用户问题响应与客服支持。当用户通过"报告问题"入口或直接描述遇到的困难时触发。覆盖：(1) 功能异常或 BUG 诊断，(2) 配置错误导致功能失效的排查与修复指引，(3) 功能使用困惑的解答，(4) 产品建议与功能需求收集。先诊断理解问题，能解决的直接解决，确认是 BUG 时生成报告提交 Issue，是建议时提交 Feature Request。
---

# 用户问题响应

## 核心原则

**先理解，后行动。大多数用户"问题"不是 Bug，而是配置或理解问题 —— 直接帮用户解决，不要急于提交 Issue。**

**行动优先：你有 `/self-config` 技能，可以通过 `myagents` CLI 直接帮用户修复配置、管理定时任务、查看运行时状态等。能直接修的就直接修，不要输出一堆操作步骤让用户自己去 Settings 页面点。**

## 工作流

### Step 1: 诊断

1. 搜索 `./logs/unified-*.log`（今天的），grep 用户描述中的关键词和对应模块标签
2. 读取 `config.json`（**脱敏 API Key**），了解 Provider / MCP / 代理配置
3. **主动用 CLI 获取运行时信息**（通过 `/self-config` 技能）：
   - `myagents status` — 整体运行状态
   - `myagents cron list` — 定时任务状态（用户问定时任务相关问题时）
   - `myagents agent runtime-status` — Agent/Channel 连接状态（用户问 IM Bot 相关问题时）
   - `myagents plugin list` — 已安装插件列表（用户问插件相关问题时）
   - `myagents mcp list` — MCP 工具状态
4. 结合 CLAUDE.md 中的「错误模式速查表」和「Provider 验证链路」，还原问题全貌

### Step 2: 分类并响应

| 类型 | 判断依据 | 响应 |
|------|----------|------|
| **配置错误** | 日志有 401/403、Key 格式异常、URL 错误 | 告知原因 + **直接用 `/self-config` 修复**（如 `myagents model set-key`、`myagents mcp enable`），不要让用户手动去 Settings 页面 |
| **使用困惑** | 无异常日志，用户不理解功能 | 用通俗语言解释功能 + 操作指引；如果用户想做的事可以通过 CLI 完成（管理定时任务、安装插件等），直接帮用户做 |
| **产品 Bug** | 日志有非用户原因的异常（崩溃、逻辑错误、已知 Bug） | → Step 3 提交 Bug Report |
| **功能建议** | 用户表达"希望..."、"能不能..."、"建议..." | → Step 3 提交 Feature Request |
| **无法判断** | 日志和配置都正常，但问题确实存在 | 先向用户追问复现步骤，仍无法定位则 → Step 3 |

**关键**：配置错误和使用困惑要**直接解决**，不提交 Issue。只有确认是 Bug 或用户明确提建议时才进入 Step 3。

### Step 3: 提交（仅 Bug / Feature Request）

#### 3a. 输出分析报告

**先将报告直接输出给用户看**，让用户了解诊断结论，再决定是否提交。

**Bug Report 模板**：
```markdown
## 环境信息
- App 版本: [版本号]
- 操作系统: [从日志路径推断: D:\ = Windows, /Users/ = macOS]

## 问题描述
[用户原始描述 + AI 补充的复现条件]

## 日志分析
[关键错误行，附时间戳，按时间线排列]

## 环境配置（已脱敏）
[相关 Provider/MCP/代理配置]

## 分析结论
[根因推断，区分确认的和疑似的]
```

**Feature Request 模板**：
```markdown
## 需求描述
[用户原始需求]

## 使用场景
[AI 理解的使用场景]

## 当前替代方案
[如有]
```

#### 3b. 检测提交能力并询问用户

输出报告后，通过 bash 检测用户环境，然后询问用户是否愿意提交：

```bash
# 检测 gh CLI 是否可用且已登录
gh --version && gh auth status
```

根据检测结果，向用户提供对应的提交选项：

**情况 1：gh CLI 可用** → 询问用户"是否帮你直接提交到 GitHub？"，确认后执行：
```bash
# Bug
gh issue create --repo hAcKlyc/MyAgents --title "bug: [标题]" --label "bug,user-report" --body "[报告]"
# Feature
gh issue create --repo hAcKlyc/MyAgents --title "feat: [标题]" --label "enhancement,user-report" --body "[报告]"
```

**情况 2：gh CLI 不可用** → 询问用户"是否帮你打开 GitHub Issue 页面？"，确认后用浏览器打开预填 Issue 页面：`open`(macOS) / `start`(Windows)

**关键**：无论哪种情况都必须先询问用户确认，不得自动提交。

## 注意事项

- **必须脱敏**：API Key、App Secret 等敏感信息
- **通俗沟通**：不暴露内部实现细节（不说"Sidecar"、"SDK subprocess"），用用户能理解的语言
- **给具体步骤**：不说"检查配置"，要说"请到 设置 → 模型供应商 → 点击对应供应商右侧的刷新按钮重新验证"
