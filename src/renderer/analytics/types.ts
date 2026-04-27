/**
 * Analytics Types
 * 埋点统计类型定义
 */

/**
 * 基础事件参数（SDK 自动填充）
 */
export interface BaseEventParams {
  device_id: string;
  platform: string;
  app_version: string;
  client_timestamp: string;
}

/**
 * 触发来源 — GUI/CLI/Cron/IM 共用枚举。
 *
 * 适用规则：当一个事件可以由多个入口触发（例如任务创建既可以通过 GUI
 * 的"+ 新建"按钮，也可以通过 `myagents task create-direct` CLI），就必须
 * 带上这个字段，方便后续按渠道做拆分分析。详见 `analytics_design.md` §4.3。
 *
 * 取值约定：
 *   - `desktop`     桌面端 GUI（未来若有移动端 app，再加 `mobile`）
 *   - `cli`         用户在终端手动跑 `myagents` 命令
 *   - `cli_agent`   AI 子进程（agent）通过 CLI 调用（`MYAGENTS_PORT` 在环境里）
 *   - `cron`        定时任务调度器
 *   - `im`          IM Bot（飞书 / Telegram / 钉钉）
 */
export type Source = 'desktop' | 'cli' | 'cli_agent' | 'cron' | 'im';

/**
 * 事件名称枚举
 *
 * 注意：每个事件都必须有对应的 track() 调用实现
 * 已移除的事件（规划时定义但实际不需要）：
 * - app_ready: 与 app_launch 功能重叠
 * - session_end: 会话只有切换/新建，无明确结束点
 */
export type EventName =
  // 应用生命周期
  | 'app_launch'
  // 会话管理
  | 'session_new'
  | 'session_switch'
  | 'session_rewind'
  | 'session_title_edit'
  // 核心交互
  | 'message_send'
  | 'message_complete'
  | 'message_stop'
  | 'message_error'
  | 'message_retry'
  | 'message_copy'
  // 工具使用
  | 'tool_use'
  // 权限控制
  | 'permission_grant'
  | 'permission_deny'
  // 配置变更
  | 'provider_switch'
  | 'model_switch'
  | 'mcp_add'
  | 'mcp_remove'
  // Agent & Skill
  | 'agent_add'
  | 'agent_remove'
  | 'agent_channel_create'
  | 'agent_channel_remove'
  | 'agent_channel_toggle'
  | 'skill_use'
  // IM Bot
  | 'im_bot_create'
  | 'im_bot_toggle'
  | 'im_bot_remove'
  // 功能使用
  | 'tab_new'
  | 'tab_close'
  | 'settings_open'
  | 'workspace_open'
  | 'workspace_create'
  | 'history_open'
  | 'file_drop'
  | 'tts_play'
  | 'task_center_open'
  | 'bug_report_submit'
  // 系统事件
  | 'update_check'
  | 'update_install'
  // 心跳循环
  | 'cron_enable'
  | 'cron_start'
  | 'cron_stop'
  | 'cron_recover'
  // 任务中心（GUI + CLI 双触发面，带 source 字段）
  | 'task_create'
  | 'task_run'
  | 'task_stop'
  | 'task_delete'
  | 'task_align_discuss'
  // 启动页 / 想法输入
  | 'launcher_mode_switch'
  | 'thought_create';

/**
 * message_send 事件参数
 */
export interface MessageSendParams {
  mode: string;           // 权限模式: auto | confirm | deny
  model: string;          // 当前模型
  skill?: string | null;  // 技能/指令名称
  has_image: boolean;     // 是否含图片
  has_file: boolean;      // 是否含文件
  is_cron: boolean;       // 是否为心跳循环任务发送
}

/**
 * message_complete 事件参数
 */
export interface MessageCompleteParams {
  model?: string;                // 主模型名称
  input_tokens: number;          // 输入 tokens
  output_tokens: number;         // 输出 tokens
  cache_read_tokens: number;     // 缓存读取 tokens
  cache_creation_tokens: number; // 缓存创建 tokens
  tool_count: number;            // 工具调用次数
  duration_ms: number;           // 响应耗时（毫秒）
}

/**
 * task_create 事件参数
 */
export interface TaskCreateParams {
  source: Source;
  /**
   * 创建路径来源 — 区分"凭空新建"和"从想法派发"两种业务语义，
   * 跟 `source` 字段（触发渠道）正交。
   */
  origin: 'manual' | 'thought_dispatch';
  has_workspace: boolean;
}

/**
 * task_run 事件参数
 */
export interface TaskRunParams {
  source: Source;
  /**
   * 第几次执行 — 1 = 首次派发；>1 = 重新派发（rerun）。
   * 取值来自任务的 `sessionIds.length + 1`，即"如果这次执行成功，将是第几次"。
   *
   * `null` 仅出现在 CLI 路径上，且当且仅当预读任务记录失败时（罕见 — 例如
   * Rust Mgmt API 临时不可达）。前端永远填实数。
   */
  run_count: number | null;
}

/**
 * task_stop / task_delete 事件参数
 */
export interface TaskStopParams {
  source: Source;
}

export interface TaskDeleteParams {
  source: Source;
  /** 删除时任务所处状态（todo / running / done / archived 等） */
  status: string;
}

/**
 * agent_channel_create / agent_channel_remove 事件参数
 *
 * 双触发面：
 *   - GUI（ChannelWizard / ChannelDetailView）→ source: 'desktop'
 *   - CLI（`myagents agent channel add/remove`）→ source: cliSource()
 */
export interface AgentChannelMutationParams {
  source: Source;
  /**
   * 渠道类型：`'feishu'` / `'telegram'` / `'dingtalk'` / `'openclaw:<plugin>'`
   * / `'unknown'`（仅 GUI 删除路径，channelRef 已被清空时的兜底）。
   */
  platform: string;
}

/**
 * agent_channel_toggle 事件参数
 *
 * 当前 GUI 独有（CLI 没有 enable/disable 子命令）。如果未来 CLI 加上等价
 * 命令，再扩展为带 `source` 的形式。
 */
export interface AgentChannelToggleParams {
  platform: string;
  enabled: boolean;
}

/**
 * launcher_mode_switch 事件参数
 *
 * GUI 独有 —— CLI 没有 launcher 概念，所以不带 `source` 字段。
 */
export interface LauncherModeSwitchParams {
  to: 'task' | 'thought';
  via: 'click' | 'shortcut';
}

/**
 * thought_create 事件参数
 */
export interface ThoughtCreateParams {
  source: Source;
  /**
   * UI 上的入口位置 —— 仅在 `source === 'desktop'` 时有意义；
   * CLI 触发时为 `null`。
   */
  location: 'launcher' | 'task_center' | null;
}

/**
 * 通用事件参数类型
 */
export type EventParams = Record<string, string | number | boolean | null | undefined>;

/**
 * 待发送的事件
 */
export interface TrackEvent {
  event: EventName | string;
  device_id: string;
  platform: string;
  app_version: string;
  params: EventParams;
  client_timestamp: string;
}

/**
 * API 请求体
 */
export interface TrackRequest {
  events: TrackEvent[];
}

/**
 * API 响应
 */
export interface TrackResponse {
  success: boolean;
  received?: number;
  error?: string;
}
