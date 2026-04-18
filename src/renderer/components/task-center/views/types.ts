// Shared row-model types for the task panel views. Both TaskCardItem and
// TaskListRow render either a native Task or a legacy cron surfaced via
// PRD §11.4; this file owns the legacy shape so the view components
// don't import from the parent panel.

export interface LegacyCronRow {
  id: string;
  name: string;
  status: 'running' | 'stopped';
  /** Raw CronTask object — forwarded to LegacyCronOverlay on click. */
  raw: Record<string, unknown>;
  workspacePath: string;
  updatedAt: number;
}
