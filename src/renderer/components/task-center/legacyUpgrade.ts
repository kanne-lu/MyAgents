// Legacy cron → new Task upgrade helper (PRD §11.4 "批量升级入口").
//
// Maps an existing CronTask (no `task_id` back-pointer) into a brand-new
// Task without losing schedule, prompt, workspace, end conditions, delivery
// config, runtime snapshot, or the cron's own run history. The existing
// CronTask is kept running; only its back-pointer is rewritten so the Task
// Center drives it through the v0.1.69 detail overlay from here on.
//
// Flow:
//   1. Create a user-level Thought with the cron's original prompt so the
//      new Task has a proper `sourceThoughtId` (v1 requires it).
//   2. Derive `TaskCreateDirectInput` from the cron — type / schedule /
//      end conditions / notification / runtime snapshot all carry over.
//   3. `taskCreateDirect` writes the jsonl row + `.task/<id>/task.md`.
//   4. `taskSetCron` writes `Task.cron_task_id` → existing cron id.
//   5. `cmd_cron_set_task_id` writes `CronTask.task_id` → new task id.
//      After this, the legacy-surfacing filter hides the row from the
//      legacy list, and the Task Center drives it through
//      TaskDetailOverlay instead of LegacyCronOverlay.

import {
  cronSetTaskId,
  taskCreateDirect,
  taskDelete,
  taskSetCron,
  thoughtCreate,
  thoughtDelete,
} from '@/api/taskCenter';
import type { Project } from '@/config/types';
import type {
  EndConditions,
  NotificationConfig,
  RuntimeConfigSnapshot,
  Task,
  TaskCreateDirectInput,
  TaskExecutionMode,
  TaskRunMode,
} from '@/../shared/types/task';
import type { RuntimeType } from '@/../shared/types/runtime';

/**
 * CronTask's wire-shape `EndConditions`. Deliberately NOT typed as the
 * Task-layer `EndConditions` — the cron side stores `deadline` as a
 * `DateTime<Utc>` (ISO string over the wire) while Task uses `i64` (ms
 * epoch). We transform at the boundary, see `transformLegacyEndConditions`.
 */
interface CronEndConditionsRaw {
  deadline?: string | number | null;
  maxExecutions?: number;
  max_executions?: number;
  aiCanExit?: boolean;
  ai_can_exit?: boolean;
}

export interface LegacyCronRaw {
  id?: string;
  name?: string;
  prompt?: string;
  status?: string;
  workspacePath?: string;
  workspaceId?: string;
  schedule?: Record<string, unknown> | null;
  intervalMinutes?: number;
  endConditions?: CronEndConditionsRaw;
  /** Rust-side snake_case variant — defend against either. */
  end_conditions?: CronEndConditionsRaw;
  notifyEnabled?: boolean;
  notify_enabled?: boolean;
  delivery?: { botId?: string; chatId?: string; platform?: string };
  runMode?: TaskRunMode;
  run_mode?: TaskRunMode;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfigSnapshot;
  runtime_config?: RuntimeConfigSnapshot;
  model?: string;
  permissionMode?: string;
  permission_mode?: string;
  [key: string]: unknown;
}

/** Map `CronSchedule.kind` onto `TaskExecutionMode`. */
function deriveExecutionMode(
  schedule: Record<string, unknown> | null | undefined,
): TaskExecutionMode {
  const kind = (schedule?.kind as string | undefined) ?? '';
  if (kind === 'at') return 'scheduled';
  if (kind === 'loop') return 'loop';
  // 'every' / 'cron' / unknown → treat as recurring (matches the current
  // legacy overlay's `describeSchedule` fallback).
  return 'recurring';
}

/**
 * Transform a CronTask-shape `EndConditions` into the Task-shape. The
 * critical fix here is `deadline`: the cron side serialises it as an RFC
 * 3339 string (because the Rust field is `Option<DateTime<Utc>>`), while
 * Task expects an `i64` ms-epoch. Passing the raw cron shape into
 * `taskCreateDirect` triggers `expected i64, got string` in serde.
 *
 * Also tolerates snake_case variants for defense in depth (older writes
 * might have bypassed the top-level `rename_all = camelCase`).
 */
function transformLegacyEndConditions(ec: CronEndConditionsRaw | undefined): EndConditions {
  const aiCanExit = ec?.aiCanExit ?? ec?.ai_can_exit ?? true;
  const out: EndConditions = { aiCanExit };
  const rawDeadline = ec?.deadline;
  if (typeof rawDeadline === 'string') {
    const ts = Date.parse(rawDeadline);
    if (!Number.isNaN(ts)) out.deadline = ts;
  } else if (typeof rawDeadline === 'number') {
    out.deadline = rawDeadline;
  }
  const maxExec = ec?.maxExecutions ?? ec?.max_executions;
  if (typeof maxExec === 'number' && maxExec > 0) out.maxExecutions = maxExec;
  return out;
}

function deriveNotification(legacy: LegacyCronRaw): NotificationConfig {
  const enabled = legacy.notifyEnabled ?? legacy.notify_enabled ?? true;
  const cfg: NotificationConfig = {
    desktop: enabled,
    events: ['done', 'blocked', 'endCondition'],
  };
  if (legacy.delivery?.botId) cfg.botChannelId = legacy.delivery.botId;
  if (legacy.delivery?.chatId) cfg.botThread = legacy.delivery.chatId;
  return cfg;
}

/** Look up workspaceId from the projects list by matching `workspacePath`. */
function resolveWorkspaceId(path: string, projects: Project[]): string | null {
  const hit = projects.find((p) => p.path === path);
  return hit?.id ?? null;
}

function deriveName(legacy: LegacyCronRaw): string {
  const candidate = (legacy.name ?? '').trim();
  if (candidate) return candidate.length <= 120 ? candidate : candidate.slice(0, 118) + '…';
  // Fall back to the first non-empty line of the prompt (PRD §8.2 pattern).
  const firstLine =
    (legacy.prompt ?? '').split('\n').find((l) => l.trim().length > 0) ?? '';
  const body = firstLine.trim() || '未命名定时任务';
  return body.length <= 60 ? body : body.slice(0, 57) + '…';
}

export interface UpgradeResult {
  task: Task;
  thoughtId: string;
}

/** Can this legacy row be upgraded automatically — without the user
 *  confirming? The upgrade creates a Thought + Task, so we need the
 *  prerequisites: a valid prompt and a resolvable workspace. Rows that
 *  fail this check remain in the legacy list and the user can still
 *  trigger a manual upgrade via LegacyCronOverlay (where they'd see the
 *  resolvable-workspace error up front). */
export function canAutoUpgrade(legacy: LegacyCronRaw, projects: Project[]): boolean {
  if (!String(legacy.id ?? '').trim()) return false;
  if (!String(legacy.prompt ?? '').trim()) return false;
  const path = String(legacy.workspacePath ?? '').trim();
  if (!path) return false;
  return projects.some((p) => p.path === path);
}

/**
 * Upgrade one legacy cron into a new-model Task. Reuses the existing
 * CronTask (schedule uninterrupted) and wires both-sided back-pointers.
 *
 * Concurrency-safe: `cronSetTaskId` runs as a link-if-null primitive
 * server-side, so two concurrent upgrade flows (auto sweep + manual
 * button, or two windows) can't both "win" — the loser sees
 * `ALREADY_LINKED` and this function rolls back the Task/Thought it
 * optimistically created.
 *
 * Full rollback: if ANY step after thought-creation fails, we delete the
 * partially-created Thought + Task before rethrowing so the next reload
 * doesn't show orphan rows.
 */
export async function upgradeLegacyCron(
  legacy: LegacyCronRaw,
  projects: Project[],
): Promise<UpgradeResult> {
  const cronTaskId = String(legacy.id ?? '').trim();
  if (!cronTaskId) throw new Error('缺少 CronTask id，无法升级');
  const workspacePath = String(legacy.workspacePath ?? '').trim();
  if (!workspacePath) throw new Error('缺少工作区路径，无法升级');
  const workspaceId = resolveWorkspaceId(workspacePath, projects);
  if (!workspaceId) {
    throw new Error(
      `找不到工作区：${workspacePath}。请先在启动页添加该工作区，然后重试升级。`,
    );
  }

  const prompt = String(legacy.prompt ?? '').trim();
  if (!prompt) throw new Error('旧任务没有 prompt，无法派生 task.md');

  // Step 1: mint a thought whose content == the cron's original prompt,
  // satisfying the v1 invariant that every Task has a `sourceThoughtId`.
  const thought = await thoughtCreate({ content: prompt });

  // Rollback helper — called on any failure after the thought is minted.
  // Each cleanup is best-effort; if a cleanup step fails we log but
  // continue so the most recent failure doesn't mask the original error.
  const rollback = async (taskId: string | null): Promise<void> => {
    if (taskId) {
      try {
        await taskSetCron(taskId, null);
      } catch (e) {
        console.warn('[legacyUpgrade] rollback taskSetCron failed', e);
      }
      try {
        await taskDelete(taskId);
      } catch (e) {
        console.warn('[legacyUpgrade] rollback taskDelete failed', e);
      }
    }
    try {
      await thoughtDelete(thought.id);
    } catch (e) {
      console.warn('[legacyUpgrade] rollback thoughtDelete failed', e);
    }
  };

  // Step 2: derive the input.
  const input: TaskCreateDirectInput = {
    name: deriveName(legacy),
    executor: 'agent',
    workspaceId,
    workspacePath,
    taskMdContent: prompt,
    executionMode: deriveExecutionMode(legacy.schedule),
    runMode: legacy.runMode ?? legacy.run_mode ?? 'new-session',
    // `transformLegacyEndConditions` converts the cron-side ISO
    // `deadline` into the Task-side ms-epoch representation — without
    // this, Rust's serde rejects `taskCreateDirect` with
    // `expected i64, got string`.
    endConditions: transformLegacyEndConditions(
      legacy.endConditions ?? legacy.end_conditions,
    ),
    sourceThoughtId: thought.id,
    tags: [],
    notification: deriveNotification(legacy),
  };
  if (legacy.runtime) input.runtime = legacy.runtime;
  const runtimeConfig = legacy.runtimeConfig ?? legacy.runtime_config;
  if (runtimeConfig) input.runtimeConfig = runtimeConfig;

  // Step 3: create the Task. Rust will NOT touch the cron here.
  let task: Task;
  try {
    task = await taskCreateDirect(input);
  } catch (e) {
    await rollback(null);
    throw e;
  }

  // Step 4/5: wire both back-pointers. cronSetTaskId runs as link-if-null
  // server-side (see `cmd_cron_set_task_id`) — when another upgrader got
  // there first, this rejects with ALREADY_LINKED, we tear down the
  // partial work we created in this attempt, and surface the error.
  try {
    await taskSetCron(task.id, cronTaskId);
    await cronSetTaskId(cronTaskId, task.id, true);
  } catch (e) {
    await rollback(task.id);
    throw e;
  }

  return { task, thoughtId: thought.id };
}
