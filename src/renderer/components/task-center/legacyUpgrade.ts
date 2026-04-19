// Legacy cron → new Task upgrade (PRD §11.4, §16.2).
//
// The whole pipeline — create Thought, derive TaskCreateDirectInput,
// write both back-pointers, roll back on any failure — lives in Rust
// (`src-tauri/src/legacy_upgrade.rs`) so the cross-module type drift we
// hit twice in TypeScript (deadline ISO/i64, run_mode snake/kebab)
// can't happen again: conversions are strongly typed Rust-to-Rust and
// any future field mismatch fails at `cargo check`, not at the user's
// open-overlay moment.
//
// This file is now a thin renderer-side shim: resolve `workspace_path
// → workspace_id` from the projects list (the config is renderer-
// owned), then call the Rust primitive.

import { taskUpgradeLegacyCron } from '@/api/taskCenter';
import type { Project } from '@/config/types';
import type { Task } from '@/../shared/types/task';

/** Minimal subset of the raw CronTask object we need in the renderer
 *  — we only read `id`, `workspacePath`, and `prompt` (for eligibility).
 *  Any actual upgrade conversion now happens server-side. */
export interface LegacyCronRaw {
  id?: string;
  prompt?: string;
  workspacePath?: string;
  /** Tolerated for defense — a few code paths surface snake_case. */
  workspace_path?: string;
  [key: string]: unknown;
}

export interface UpgradeResult {
  task: Task;
}

function getWorkspacePath(legacy: LegacyCronRaw): string {
  return String(legacy.workspacePath ?? legacy.workspace_path ?? '').trim();
}

function resolveWorkspaceId(path: string, projects: Project[]): string | null {
  if (!path) return null;
  return projects.find((p) => p.path === path)?.id ?? null;
}

/** Cheap pre-flight: does this row have enough metadata for the Rust
 *  primitive to succeed without the user being prompted? Used by the
 *  auto-upgrade sweep to skip rows that would deterministically fail
 *  (missing prompt, deleted workspace). Manual upgrade surfaces the
 *  actual Rust error for the rest. */
export function canAutoUpgrade(legacy: LegacyCronRaw, projects: Project[]): boolean {
  if (!String(legacy.id ?? '').trim()) return false;
  if (!String(legacy.prompt ?? '').trim()) return false;
  return resolveWorkspaceId(getWorkspacePath(legacy), projects) !== null;
}

export async function upgradeLegacyCron(
  legacy: LegacyCronRaw,
  projects: Project[],
): Promise<UpgradeResult> {
  const cronTaskId = String(legacy.id ?? '').trim();
  if (!cronTaskId) throw new Error('缺少 CronTask id，无法升级');
  const workspacePath = getWorkspacePath(legacy);
  if (!workspacePath) throw new Error('缺少工作区路径，无法升级');
  const workspaceId = resolveWorkspaceId(workspacePath, projects);
  if (!workspaceId) {
    throw new Error(
      `找不到工作区：${workspacePath}。请先在启动页添加该工作区，然后重试升级。`,
    );
  }
  return taskUpgradeLegacyCron(cronTaskId, workspaceId);
}
