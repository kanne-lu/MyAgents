/**
 * Unified system prompt assembly for MyAgents.
 *
 * Three-layer prompt architecture:
 *   L1 — Base identity (always included)
 *   L2 — Interaction channel (desktop vs IM, mutually exclusive)
 *   L3 — Scenario instructions (cron-task / heartbeat, stacked as needed)
 *
 * Template content is inlined below (not loaded from filesystem) because
 * bun build hardcodes __dirname at compile time, breaking production builds.
 */

// ===== Scenario types =====

export type InteractionScenario =
  | { type: 'desktop' }
  | { type: 'im'; platform: 'telegram' | 'feishu'; sourceType: 'private' | 'group'; botName?: string }
  | { type: 'agent-channel'; platform: string; sourceType: 'private' | 'group'; botName?: string; agentName?: string }
  | { type: 'cron'; taskId: string; intervalMinutes: number; aiCanExit: boolean };

// ===== Inline templates =====

const TMPL_BASE_IDENTITY = `<myagents-identity>
你正运行在 MyAgents —— 一款基于 Claude Agent SDK 的桌面端 AI Agent 应用中。
用户全局配置目录: ~/.myagents
当对话涉及日期、时间或星期时，先用 Bash 执行 \`date\` 获取准确的当前时间再作判断——系统信息中的日期可能已过期。
</myagents-identity>`;

const TMPL_CHANNEL_DESKTOP = `<myagents-interaction-channel>
用户正通过 MyAgents 桌面客户端与你对话。
</myagents-interaction-channel>`;

const TMPL_CHANNEL_IM = `<myagents-interaction-channel>
你正通过 {{platformLabel}} 作为 IM 聊天机器人与用户对话，{{sourceTypeLabel}}。{{#if botName}}你的昵称为「{{botName}}」。{{/if}}
</myagents-interaction-channel>`;

const TMPL_CRON_TASK = `<myagents-cron-task-instructions>
你正处于心跳循环任务模式 (Task ID: {{taskId}})。每隔 {{intervalText}} 系统触发唤醒你一次。
{{#if aiCanExit}}

如果任务目标已完全达成，无需继续定时执行，请调用 \`mcp__cron-tools__exit_cron_task\` 工具来结束任务。
{{/if}}
</myagents-cron-task-instructions>`;

const TMPL_HEARTBEAT = `<myagents-heartbeat-instructions>
You will periodically receive heartbeat messages (a user message wrapped in tags like \`<HEARTBEAT>\\nThis is a heartbeat from the system.\\n……\\n</HEARTBEAT>\`).
When you receive one, follow its instructions.
</myagents-heartbeat-instructions>`;

const TMPL_BROWSER_STORAGE_STATE = `<myagents-browser-storage-instructions>
当你在浏览器中执行了登录操作或用户帮你完成了登录（输入账号密码、OAuth 授权、扫码登录等），必须在登录成功后**立即**调用 browser_storage_state 工具将登录状态保存到 ~/.myagents/browser-storage-state.json，然后再继续执行后续任务。这样即使后续任务中断或会话异常终止，登录态也不会丢失，后续对话可以复用。
</myagents-browser-storage-instructions>`;

// ===== Variable replacement =====
// Supports {{varName}} simple substitution + {{#if varName}}...{{else}}...{{/if}} conditional blocks

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  // Conditional blocks: {{#if key}}...{{else}}...{{/if}} or {{#if key}}...{{/if}}
  result = result.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
    (_, key, ifBlock, elseBlock) => vars[key] ? ifBlock : (elseBlock ?? '')
  );
  // Simple variable substitution
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
  return result;
}

// ===== Main entry =====

export interface SystemPromptOptions {
  /** Whether Playwright MCP with storage capability is enabled in this session */
  playwrightStorageEnabled?: boolean;
}

export function buildSystemPromptAppend(scenario: InteractionScenario, options?: SystemPromptOptions): string {
  const parts: string[] = [];

  // L1: Base identity (always)
  parts.push(TMPL_BASE_IDENTITY);

  // L2: Interaction channel (mutually exclusive)
  if (scenario.type === 'im' || scenario.type === 'agent-channel') {
    const platformMap: Record<string, string> = { feishu: '飞书', telegram: 'Telegram', dingtalk: '钉钉' };
    const platformLabel = platformMap[scenario.platform] ?? scenario.platform;
    const sourceTypeLabel = scenario.sourceType === 'private' ? '私聊模式' : '群聊模式';
    parts.push(renderTemplate(TMPL_CHANNEL_IM, {
      botName: scenario.botName ?? '',
      platformLabel,
      sourceTypeLabel,
    }));
  } else {
    // desktop and cron both use desktop channel
    parts.push(TMPL_CHANNEL_DESKTOP);
  }

  // L3: Scenario instructions (stacked as needed)
  if (scenario.type === 'cron') {
    const intervalText = scenario.intervalMinutes >= 60
      ? `${Math.floor(scenario.intervalMinutes / 60)} 小时${scenario.intervalMinutes % 60 > 0 ? ` ${scenario.intervalMinutes % 60} 分钟` : ''}`
      : `${scenario.intervalMinutes} 分钟`;
    parts.push(renderTemplate(TMPL_CRON_TASK, {
      taskId: scenario.taskId,
      intervalText,
      aiCanExit: scenario.aiCanExit ? 'true' : '',  // non-empty = truthy for {{#if}}
    }));
  }

  if (scenario.type === 'im' || scenario.type === 'agent-channel') {
    parts.push(TMPL_HEARTBEAT);
  }

  // L3: Browser storage state save instruction (when Playwright with --caps=storage is active)
  if (options?.playwrightStorageEnabled) {
    parts.push(TMPL_BROWSER_STORAGE_STATE);
  }

  return parts.join('\n\n');
}
