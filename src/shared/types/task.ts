// Task types (v0.1.69 Task Center)
// Workspace-scoped execution units. Persisted to ~/.myagents/tasks.jsonl.
// Associated markdown documents live under <workspace>/.task/<taskId>/.
// See PRD §3.2 for the full schema and §9.1 for the state machine.

import type { RuntimeType } from './runtime';

/**
 * Task status — see PRD §9.1 state machine.
 *
 * `'deleted'` is a synthetic pseudo-state used only as the `to` of a soft-delete
 * audit entry (PRD §10.2.2) — it is never accepted as the target of
 * `update-status` and a task whose `status === 'deleted'` is equivalent to
 * `deleted === true` (filtered out of list queries by default).
 */
export type TaskStatus =
  | 'todo'
  | 'running'
  | 'verifying'
  | 'done'
  | 'blocked'
  | 'stopped'
  | 'archived'
  | 'deleted';

/** Statuses accepted by the CLI `task update-status`. `archived` is user-only (see §9.1). */
export type CliSettableStatus = 'running' | 'verifying' | 'done' | 'blocked' | 'stopped';

/** Who actually triggered the transition. */
export type TransitionActor = 'system' | 'user' | 'agent';

/** Fine-grained transition source for audit/statistics. */
export type TransitionSource =
  | 'cli'
  | 'ui'
  | 'watchdog'
  | 'crash'
  | 'scheduler'
  | 'endCondition'
  | 'rerun';

/** Execution mode — see PRD §9.2. */
export type TaskExecutionMode = 'once' | 'scheduled' | 'recurring' | 'loop';

/** Session strategy across multiple runs. Mirrors cron_task.rs `RunMode`. */
export type TaskRunMode = 'single-session' | 'new-session';

/** Who is responsible for carrying out the task. */
export type TaskExecutor = 'user' | 'agent';

/**
 * How the task was created — governs the initial prompt construction on dispatch
 * (see PRD §9.3.1) and which of the four `.task/` files are expected to exist.
 */
export type TaskDispatchOrigin = 'direct' | 'ai-aligned';

/** One append-only entry in `Task.statusHistory`. See PRD §3.2. */
export interface StatusTransition {
  from: TaskStatus | null;
  to: TaskStatus;
  /** Timestamp (ms since epoch) */
  at: number;
  actor: TransitionActor;
  /** Free-form note; all target states can carry a message. */
  message?: string;
  source?: TransitionSource;
}

/** Auto-termination conditions for recurring/loop tasks. Mirrors cron_task.rs `EndConditions`. */
export interface EndConditions {
  /** Absolute timestamp (ms). After this point, no new round starts. */
  deadline?: number;
  /** Cap on total rounds run. */
  maxExecutions?: number;
  /** Whether AI may call `task update-status done` to exit a loop. Default `true`. */
  aiCanExit: boolean;
}

/** Per-task notification configuration. Falls back to global defaults when `null`. */
export interface NotificationConfig {
  /** Show OS desktop notification. Default `true`. */
  desktop: boolean;
  /** Target IM bot channel id (AgentChannel/ImBot unique id). */
  botChannelId?: string;
  /** Specific chat id within the bot (e.g. feishu chat_id, telegram chat_id). */
  botThread?: string;
  /**
   * Which transitions trigger a push.
   * Default: `['done', 'blocked', 'endCondition']`. Loop single-round completion is NOT a
   * status change and therefore not listed (see PRD §11.5).
   */
  events?: Array<'done' | 'blocked' | 'stopped' | 'verifying' | 'endCondition'>;
}

/** Runtime-scoped config snapshot captured at dispatch. */
export interface RuntimeConfigSnapshot {
  model?: string;
  permissionMode?: string;
  [key: string]: unknown;
}

/** A Task — workspace-scoped execution unit. */
export interface Task {
  id: string;
  name: string;
  executor: TaskExecutor;
  description?: string;
  workspaceId: string;
  /**
   * Absolute filesystem path of the workspace. Captured at create time so
   * background executors (scheduler, CLI) can locate `.task/<id>/` without
   * re-resolving the workspace. Not meant for UI display — prefer `workspaceId`.
   */
  workspacePath?: string;
  executionMode: TaskExecutionMode;
  /** Points into CronTaskManager when executionMode is scheduled/recurring/loop. */
  cronTaskId?: string;
  runMode?: TaskRunMode;
  endConditions?: EndConditions;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfigSnapshot;
  /** The thought this task was derived from. v1 requires this; v2 may relax. */
  sourceThoughtId?: string;
  sessionIds: string[];
  status: TaskStatus;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastExecutedAt?: number;
  /** Append-only audit log of status changes. See PRD §3.2 / §10.2.1. */
  statusHistory: StatusTransition[];
  notification?: NotificationConfig;
  /** How the task was created; governs first-message construction. See PRD §9.3.1. */
  dispatchOrigin: TaskDispatchOrigin;
  /** Set to `true` by `task delete` (soft delete with 30-day retention, §9.5). */
  deleted?: boolean;
  /** Set when `deleted = true`. Used for retention cleanup. */
  deletedAt?: number;
}

/** Payload for `cmd_task_create_direct` (PRD §10.2.2). */
export interface TaskCreateDirectInput {
  name: string;
  executor: TaskExecutor;
  description?: string;
  workspaceId: string;
  workspacePath: string;
  taskMdContent: string;
  executionMode: TaskExecutionMode;
  runMode?: TaskRunMode;
  endConditions?: EndConditions;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfigSnapshot;
  sourceThoughtId?: string;
  tags?: string[];
  notification?: NotificationConfig;
}

/**
 * Payload for `cmd_task_create_from_alignment`.
 * `alignmentSessionId` identifies the pending directory `<workspace>/.task/<sessionId>/`.
 */
export interface TaskCreateFromAlignmentInput {
  name: string;
  executor: TaskExecutor;
  description?: string;
  workspaceId: string;
  workspacePath: string;
  alignmentSessionId: string;
  executionMode: TaskExecutionMode;
  runMode?: TaskRunMode;
  endConditions?: EndConditions;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfigSnapshot;
  sourceThoughtId?: string;
  tags?: string[];
  notification?: NotificationConfig;
}

/** Payload for `cmd_task_update`. */
export interface TaskUpdateInput {
  id: string;
  name?: string;
  executor?: TaskExecutor;
  description?: string;
  executionMode?: TaskExecutionMode;
  runMode?: TaskRunMode;
  endConditions?: EndConditions;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfigSnapshot;
  tags?: string[];
  notification?: NotificationConfig;
}

/**
 * Payload for `cmd_task_update_status`. See PRD §10.2.1.
 *
 * UI callers MUST NOT send `actor` / `source` — these are authoritatively
 * stamped server-side at the Tauri command layer (`user` / `ui` for any
 * renderer-originated call). The fields are present in the shared type only for
 * internal Admin API / CLI transport payloads. A buggy renderer that sends them
 * anyway has them ignored.
 */
export interface TaskUpdateStatusInput {
  id: string;
  status: TaskStatus;
  message?: string;
  /** Internal only — ignored by the renderer-facing `cmd_task_update_status`. */
  actor?: TransitionActor;
  /** Internal only — ignored by the renderer-facing `cmd_task_update_status`. */
  source?: TransitionSource;
}

/** Filters accepted by `cmd_task_list`. Accepts a single status or an array. */
export interface TaskListFilter {
  workspaceId?: string;
  status?: TaskStatus | TaskStatus[];
  tag?: string;
  /** If `true`, include soft-deleted rows (default `false`). */
  includeDeleted?: boolean;
}
