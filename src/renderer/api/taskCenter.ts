// Task Center API — thin wrappers around Tauri invoke()
// Handles both Tauri (desktop) and browser dev mode (no-op fallback).

import type {
  Thought,
  ThoughtCreateInput,
  ThoughtUpdateInput,
} from '@/../shared/types/thought';
import type {
  Task,
  TaskCreateDirectInput,
  TaskCreateFromAlignmentInput,
  TaskListFilter,
  TaskUpdateInput,
  TaskUpdateStatusInput,
} from '@/../shared/types/task';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(
      `Task Center commands require Tauri runtime; ran in browser mode: ${cmd}`,
    );
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

// ==================== Thoughts ====================

export function thoughtCreate(input: ThoughtCreateInput): Promise<Thought> {
  return inv('cmd_thought_create', { input });
}

export function thoughtList(filter?: {
  tag?: string;
  query?: string;
  limit?: number;
}): Promise<Thought[]> {
  return inv('cmd_thought_list', { filter });
}

export function thoughtGet(id: string): Promise<Thought | null> {
  return inv('cmd_thought_get', { id });
}

export function thoughtUpdate(input: ThoughtUpdateInput): Promise<Thought> {
  return inv('cmd_thought_update', { input });
}

export function thoughtDelete(id: string): Promise<void> {
  return inv('cmd_thought_delete', { id });
}

// ==================== Tasks ====================

export function taskCreateDirect(
  input: TaskCreateDirectInput & { taskMdContent: string },
): Promise<Task> {
  return inv('cmd_task_create_direct', { input });
}

export function taskCreateFromAlignment(
  input: TaskCreateFromAlignmentInput & { alignmentSessionId: string },
): Promise<Task> {
  return inv('cmd_task_create_from_alignment', { input });
}

export function taskList(filter?: TaskListFilter): Promise<Task[]> {
  return inv('cmd_task_list', { filter });
}

export function taskGet(id: string): Promise<Task | null> {
  return inv('cmd_task_get', { id });
}

export function taskUpdate(input: TaskUpdateInput): Promise<Task> {
  return inv('cmd_task_update', { input });
}

export function taskUpdateStatus(input: TaskUpdateStatusInput): Promise<Task> {
  return inv('cmd_task_update_status', { input });
}

export function taskUpdateProgress(id: string, message: string): Promise<void> {
  return inv('cmd_task_update_progress', { id, message });
}

export function taskAppendSession(id: string, sessionId: string): Promise<Task> {
  return inv('cmd_task_append_session', { id, sessionId });
}

export function taskArchive(id: string, message?: string): Promise<Task> {
  return inv('cmd_task_archive', { id, message });
}

export function taskDelete(id: string): Promise<void> {
  return inv('cmd_task_delete', { id });
}

export function taskSetCron(id: string, cronTaskId: string | null): Promise<Task> {
  return inv('cmd_task_set_cron', { id, cronTaskId });
}

/** True if the current environment exposes Task Center commands (Tauri-only). */
export function taskCenterAvailable(): boolean {
  return isTauri();
}
