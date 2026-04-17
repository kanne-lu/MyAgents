// DispatchTaskDialog — convert a Thought into a real Task by filling in a form.
// Writes task.md under <workspace>/.task/<taskId>/ and persists the Task row.
//
// For Phase 4 we support `executionMode = 'once'` end-to-end. Scheduled /
// recurring / loop modes persist the task + runMode + endConditions but the
// actual CronTask registration with `CronTaskManager` is Phase 5 (cross-Rust
// plumbing that intersects with the scheduler lifecycle).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { taskCreateDirect } from '@/api/taskCenter';
import type { Thought } from '@/../shared/types/thought';
import type {
  Task,
  TaskExecutionMode,
  TaskExecutor,
  TaskRunMode,
  EndConditions,
} from '@/../shared/types/task';

const OVERLAY_Z = 200;

interface Props {
  thought: Thought;
  onClose: () => void;
  onDispatched: (task: Task) => void;
}

export function DispatchTaskDialog({ thought, onClose, onDispatched }: Props) {
  const toast = useToast();
  const { projects } = useConfig();
  useCloseLayer(() => {
    onClose();
    return true;
  }, OVERLAY_Z);

  const visibleProjects = useMemo(
    () => projects.filter((p) => !p.internal),
    [projects],
  );

  // Smart workspace default (PRD §8.4): prefer a project whose name matches any
  // of the thought's tags (case-insensitive).
  const defaultProject = useMemo(() => {
    if (visibleProjects.length === 0) return null;
    const lowerTags = thought.tags.map((t) => t.toLowerCase());
    const match = visibleProjects.find((p) =>
      lowerTags.includes(p.name.toLowerCase()),
    );
    return match ?? visibleProjects[0];
  }, [thought.tags, visibleProjects]);

  const defaultName = useMemo(() => deriveTaskName(thought.content), [thought.content]);

  const [name, setName] = useState(defaultName);
  const [executor, setExecutor] = useState<TaskExecutor>('agent');
  const [workspaceId, setWorkspaceId] = useState(defaultProject?.id ?? '');
  const [executionMode, setExecutionMode] = useState<TaskExecutionMode>('once');
  const [runMode, setRunMode] = useState<TaskRunMode>('new-session');
  const [aiCanExit, setAiCanExit] = useState(true);
  const [maxExecutions, setMaxExecutions] = useState<number | ''>('');
  const [deadline, setDeadline] = useState<string>('');
  const [tagsInput, setTagsInput] = useState(thought.tags.join(', '));
  const [descriptionInput, setDescriptionInput] = useState('');
  const [taskMd, setTaskMd] = useState(thought.content);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Keep runMode in sync with execution mode defaults (PRD §9.2).
  useEffect(() => {
    if (executionMode === 'loop') setRunMode('single-session');
    else if (executionMode === 'recurring') setRunMode('new-session');
  }, [executionMode]);

  const workspace = useMemo(
    () => visibleProjects.find((p) => p.id === workspaceId) ?? null,
    [workspaceId, visibleProjects],
  );

  const canSubmit =
    !!workspace && name.trim().length > 0 && taskMd.trim().length > 0 && !busy;

  const buildEndConditions = useCallback((): EndConditions | undefined => {
    if (executionMode === 'once' || executionMode === 'scheduled') return undefined;
    const out: EndConditions = { aiCanExit };
    if (typeof maxExecutions === 'number' && maxExecutions > 0) {
      out.maxExecutions = maxExecutions;
    }
    if (deadline) {
      const ts = Date.parse(deadline);
      if (!Number.isNaN(ts)) out.deadline = ts;
    }
    return out;
  }, [executionMode, aiCanExit, maxExecutions, deadline]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !workspace) return;
    setBusy(true);
    setErr(null);
    try {
      const tags = tagsInput
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const task = await taskCreateDirect({
        name: name.trim(),
        executor,
        description: descriptionInput.trim() || undefined,
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        taskMdContent: taskMd,
        executionMode,
        runMode: executionMode === 'once' ? undefined : runMode,
        endConditions: buildEndConditions(),
        sourceThoughtId: thought.id,
        tags,
      });
      toast.success(`任务「${task.name}」已派发`);
      onDispatched(task);
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [
    canSubmit,
    workspace,
    name,
    executor,
    descriptionInput,
    taskMd,
    executionMode,
    runMode,
    buildEndConditions,
    thought.id,
    tagsInput,
    toast,
    onDispatched,
  ]);

  return (
    <OverlayBackdrop onClose={onClose} className="z-[200]">
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--paper-elevated)] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--ink)]">
              派发为任务
            </h2>
            <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
              把这条想法变成一条可执行的任务
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-md)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <Field label="任务名">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="w-full rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-[13px] text-[var(--ink)] focus:border-[var(--line-strong)] focus:outline-none"
            />
          </Field>

          <Field label="简短描述（可选）">
            <input
              type="text"
              value={descriptionInput}
              onChange={(e) => setDescriptionInput(e.target.value)}
              placeholder="一行话说明，任务卡会展示"
              className="w-full rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--line-strong)] focus:outline-none"
            />
          </Field>

          <Field label="工作区">
            {visibleProjects.length === 0 ? (
              <p className="text-[12px] text-[var(--ink-muted)]">
                还没有工作区。先在 Launcher 添加一个。
              </p>
            ) : (
              <select
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                className="w-full rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-[13px] text-[var(--ink)] focus:border-[var(--line-strong)] focus:outline-none"
              >
                {visibleProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName ?? p.name} — {p.path}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="执行者">
            <Segmented
              value={executor}
              options={[
                { value: 'agent', label: 'AI 执行' },
                { value: 'user', label: '我自己做（当 todo 用）' },
              ]}
              onChange={(v) => setExecutor(v as TaskExecutor)}
            />
          </Field>

          <Field label="执行模式">
            <Segmented
              value={executionMode}
              options={[
                { value: 'once', label: '立刻跑一次' },
                { value: 'scheduled', label: '定时一次' },
                { value: 'recurring', label: '周期触发' },
                { value: 'loop', label: 'Ralph Loop' },
              ]}
              onChange={(v) => setExecutionMode(v as TaskExecutionMode)}
            />
            {executionMode === 'loop' && (
              <p className="mt-1.5 text-[11px] text-[var(--ink-muted)]">
                Loop：完成后 3 秒缓冲即再触发；AI 可主动终止。MVP 支持创建，调度注册在 Phase 5。
              </p>
            )}
            {(executionMode === 'scheduled' ||
              executionMode === 'recurring') && (
              <p className="mt-1.5 text-[11px] text-[var(--ink-muted)]">
                v0.1.69 MVP 先持久化字段；CronTaskManager 挂载在 Phase 5 完成。
              </p>
            )}
          </Field>

          {(executionMode === 'recurring' || executionMode === 'loop') && (
            <>
              <Field label="会话策略">
                <Segmented
                  value={runMode}
                  options={[
                    { value: 'single-session', label: '同一 session 反复打磨' },
                    { value: 'new-session', label: '每轮新 session' },
                  ]}
                  onChange={(v) => setRunMode(v as TaskRunMode)}
                />
              </Field>

              <Field label="结束条件">
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-[12px] text-[var(--ink)]">
                    <input
                      type="checkbox"
                      checked={aiCanExit}
                      onChange={(e) => setAiCanExit(e.target.checked)}
                    />
                    允许 AI 主动结束
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-[var(--ink-muted)] w-20">
                      最大轮次
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={maxExecutions}
                      onChange={(e) =>
                        setMaxExecutions(
                          e.target.value === ''
                            ? ''
                            : Math.max(1, Number(e.target.value)),
                        )
                      }
                      placeholder="留空不限"
                      className="w-24 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-[13px] text-[var(--ink)] focus:border-[var(--line-strong)] focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-[var(--ink-muted)] w-20">
                      截止时间
                    </span>
                    <input
                      type="datetime-local"
                      value={deadline}
                      onChange={(e) => setDeadline(e.target.value)}
                      className="rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-[13px] text-[var(--ink)] focus:border-[var(--line-strong)] focus:outline-none"
                    />
                  </div>
                </div>
              </Field>
            </>
          )}

          <Field label="task.md 内容">
            <textarea
              value={taskMd}
              onChange={(e) => setTaskMd(e.target.value)}
              rows={5}
              className="w-full resize-y rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-[13px] leading-relaxed text-[var(--ink)] focus:border-[var(--line-strong)] focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-[var(--ink-muted)]">
              AI 执行时看到的 prompt。默认取自想法原文，你可以补充细节。
            </p>
          </Field>

          <Field label="标签">
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="以逗号分隔，例如 MyAgents, 维护"
              className="w-full rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--line-strong)] focus:outline-none"
            />
          </Field>
        </div>

        {err && (
          <div className="border-t border-[var(--error)]/30 bg-[var(--error-bg)] px-5 py-2 text-[12px] text-[var(--error)]">
            {err}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-[var(--radius-md)] bg-[var(--button-secondary-bg)] px-4 py-1.5 text-[13px] font-medium text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="rounded-[var(--radius-full)] bg-[var(--button-primary-bg)] px-5 py-1.5 text-[13px] font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
          >
            {busy ? '派发中…' : '派发任务'}
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block mb-1.5 text-[12px] font-medium text-[var(--ink-secondary)]">
        {label}
      </label>
      {children}
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`rounded-[var(--radius-md)] px-3 py-1 text-[12px] transition-colors ${
            value === o.value
              ? 'bg-[var(--accent-warm-muted)] text-[var(--accent-warm)] font-medium'
              : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function deriveTaskName(content: string): string {
  const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? '';
  const stripped = firstLine.replace(/#[^\s]+/g, '').trim();
  return stripped.length > 60 ? stripped.slice(0, 57) + '…' : stripped;
}

function extractErrorMessage(e: unknown): string {
  const s = String(e);
  try {
    const parsed = JSON.parse(s) as { code?: string; message?: string };
    if (parsed && parsed.message) return parsed.message;
  } catch {
    /* not JSON */
  }
  return s;
}

export default DispatchTaskDialog;
