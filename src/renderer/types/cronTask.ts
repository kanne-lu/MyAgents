// Types for scheduled (cron) tasks

/**
 * Run mode for cron tasks
 */
export type CronRunMode = 'single_session' | 'new_session';

/**
 * Task status (simplified: only Running and Stopped)
 * Stopped includes: manual stop, end conditions met, AI exit
 */
export type CronTaskStatus = 'running' | 'stopped';

/**
 * End conditions for a cron task
 * Note: Uses camelCase to match Rust's serde(rename_all = "camelCase")
 */
export interface CronEndConditions {
  /** Task will stop after this time (ISO timestamp) */
  deadline?: string;
  /** Task will stop after this many executions */
  maxExecutions?: number;
  /** Allow AI to exit the task via ExitCronTask tool */
  aiCanExit: boolean;
}

/**
 * Flexible schedule types for cron tasks (mirrors Rust CronSchedule)
 */
export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; minutes: number }
  | { kind: 'cron'; expr: string; tz?: string };

/**
 * A scheduled cron task (returned from Rust)
 * Note: Uses camelCase to match Rust's serde(rename_all = "camelCase")
 */
export interface CronTask {
  id: string;
  workspacePath: string;
  sessionId: string;
  prompt: string;
  intervalMinutes: number;
  endConditions: CronEndConditions;
  runMode: CronRunMode;
  status: CronTaskStatus;
  executionCount: number;
  createdAt: string;
  lastExecutedAt?: string;
  notifyEnabled: boolean;
  tabId?: string;
  exitReason?: string;
  permissionMode?: string;
  model?: string;
  providerEnv?: { baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; upstreamFormat?: 'chat_completions' | 'responses' };
  lastError?: string;
  /** Source IM Bot ID that created this task */
  sourceBotId?: string;
  /** Flexible schedule (overrides intervalMinutes when present) */
  schedule?: CronSchedule;
  /** Human-readable name for the task */
  name?: string;
  /** Computed next execution time (enriched by Rust) */
  nextExecutionAt?: string;
  /** Internal SDK session ID where conversation data is stored.
   *  Differs from sessionId (Sidecar session key) for IM Bot cron tasks. */
  internalSessionId?: string;
  /** Last activity timestamp — updated on create, start, stop, execute */
  updatedAt?: string;
}

/**
 * Provider environment for third-party API access
 */
export interface CronTaskProviderEnv {
  baseUrl?: string;
  apiKey?: string;
  authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
  apiProtocol?: 'anthropic' | 'openai';
  maxOutputTokens?: number;
  upstreamFormat?: 'chat_completions' | 'responses';
}

/**
 * Configuration for creating a new cron task
 * Note: Uses camelCase to match Rust's serde(rename_all = "camelCase")
 */
export interface CronTaskConfig {
  workspacePath: string;
  sessionId: string;
  prompt: string;
  intervalMinutes: number;
  endConditions: CronEndConditions;
  runMode: CronRunMode;
  notifyEnabled: boolean;
  tabId?: string;
  permissionMode?: string;
  model?: string;
  providerEnv?: CronTaskProviderEnv;
}

/**
 * Payload sent from Rust scheduler to trigger task execution
 */
export interface CronTaskTriggerPayload {
  taskId: string;
  prompt: string;
  isFirstExecution: boolean;
  aiCanExit: boolean;
  workspacePath: string;
  sessionId: string;
  runMode: CronRunMode;
  notifyEnabled: boolean;
  tabId?: string;
}

/**
 * Preset interval options (in minutes)
 */
export const CRON_INTERVAL_PRESETS = [
  { label: '15 分钟', value: 15 },
  { label: '30 分钟', value: 30 },
  { label: '1 小时', value: 60 },
  { label: '8 小时', value: 480 },
  { label: '24 小时', value: 1440 },
] as const;

/**
 * Minimum interval in minutes
 */
export const MIN_CRON_INTERVAL = 5;

/**
 * Format interval for display
 */
export function formatCronInterval(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} 分钟`;
  } else if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
  } else {
    const days = Math.floor(minutes / 1440);
    const remainingMins = minutes % 1440;
    const hours = Math.floor(remainingMins / 60);
    if (hours > 0) {
      return `${days} 天 ${hours} 小时`;
    }
    return `${days} 天`;
  }
}

/**
 * Get human-readable status text
 */
export function getCronStatusText(status: CronTaskStatus): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'stopped':
      return '已停止';
    default:
      return status;
  }
}

/**
 * Get status color class
 */
export function getCronStatusColor(status: CronTaskStatus): string {
  switch (status) {
    case 'running':
      return 'text-green-600';
    case 'stopped':
      return 'text-gray-600';
    default:
      return 'text-[var(--ink-muted)]';
  }
}

/**
 * Format schedule description for display
 */
export function formatScheduleDescription(task: CronTask): string {
  if (task.schedule) {
    switch (task.schedule.kind) {
      case 'at':
        return `定时执行: ${new Date(task.schedule.at).toLocaleString('zh-CN')}`;
      case 'every':
        return `每 ${formatCronInterval(task.schedule.minutes)}`;
      case 'cron':
        return `Cron: ${task.schedule.expr}${task.schedule.tz ? ` (${task.schedule.tz})` : ''}`;
    }
  }
  return `每 ${formatCronInterval(task.intervalMinutes)}`;
}

/**
 * Check if a stopped task can be meaningfully resumed.
 * Returns { canResume: true } or { canResume: false, reason: string }.
 */
export function checkCanResume(task: CronTask): { canResume: true } | { canResume: false; reason: string } {
    if (task.status !== 'stopped') {
        return { canResume: false, reason: '任务正在运行中' };
    }

    // One-shot (schedule.kind === 'at') that has already executed → auto-deleted, shouldn't appear, but guard anyway
    if (task.schedule?.kind === 'at' && task.executionCount > 0) {
        return { canResume: false, reason: '单次定时任务已执行完毕' };
    }

    // Deadline already passed
    if (task.endConditions.deadline) {
        if (new Date(task.endConditions.deadline).getTime() <= Date.now()) {
            return { canResume: false, reason: '截止时间已过' };
        }
    }

    // Max executions already reached
    if (task.endConditions.maxExecutions != null) {
        if (task.executionCount >= task.endConditions.maxExecutions) {
            return { canResume: false, reason: '已达最大执行次数' };
        }
    }

    return { canResume: true };
}

/**
 * Format next execution time for display
 */
export function formatNextExecution(nextAt: string | undefined, status: CronTaskStatus): string {
  if (status === 'stopped') return '已停止';
  if (!nextAt) return '—';
  const date = new Date(nextAt);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  if (diffMs <= 0) return '即将执行';
  const diffMins = Math.floor(diffMs / (1000 * 60));
  if (diffMins < 1) return '不到 1 分钟后';
  if (diffMins < 60) return `${diffMins} 分钟后`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} 小时后`;
  return date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
