// DispatchTaskDialog — Full-featured modal that turns a Thought into a Task.
// Design language aligned with `scheduled-tasks/TaskCreateModal` and
// `cron/CronTaskSettingsModal` so the dispatch/create UX is consistent across
// product surfaces (same section headers, same INPUT_CLS, same Toggle/Checkbox
// helpers, same CustomSelect for channel picks, same footer layout).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Calendar,
  Check,
  Clock,
  FileText,
  Flag,
  Play,
  Repeat,
  Timer,
  X,
  Zap,
} from 'lucide-react';
import CustomSelect from '@/components/CustomSelect';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useConfig } from '@/hooks/useConfig';
import { useDeliveryChannels } from '@/hooks/useDeliveryChannels';
import { useToast } from '@/components/Toast';
import { taskCreateDirect, taskRun } from '@/api/taskCenter';
import { splitWithTagHighlights } from '@/utils/parseThoughtTags';
import type { Thought } from '@/../shared/types/thought';
import type {
  EndConditions,
  NotificationConfig,
  Task,
  TaskExecutionMode,
  TaskRunMode,
} from '@/../shared/types/task';

/** Shared input class — identical to TaskCreateModal for visual consistency. */
const INPUT_CLS =
  'w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none transition-colors';

// ────────────────────────────────────────────────────────────────────────────
// Small helpers — same API as TaskCreateModal/CronTaskSettingsModal

function ToggleSwitch({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
        enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${
          enabled ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-[13px] text-[var(--ink)]"
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
          checked
            ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
            : 'border-[var(--line-strong)] bg-transparent'
        }`}
      >
        {checked && <Check className="h-2.5 w-2.5" />}
      </span>
      {label}
    </button>
  );
}

function SectionHeader({
  icon: Icon,
  children,
}: {
  icon?: typeof Clock;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      {Icon && <Icon className="h-4 w-4 text-[var(--ink-muted)]" />}
      <h3 className="text-[14px] font-semibold text-[var(--ink)]">{children}</h3>
    </div>
  );
}

function PillButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
        selected
          ? 'bg-[var(--accent)] text-white'
          : 'bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
      }`}
    >
      {children}
    </button>
  );
}

function toLocalDateTimeString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ────────────────────────────────────────────────────────────────────────────

/** 执行模式 pill-tab presets, mirroring the cron ScheduleTypeTabs visual. */
const EXECUTION_TABS: Array<{
  value: TaskExecutionMode;
  label: string;
  icon: typeof Clock;
  description: string;
}> = [
  {
    value: 'once',
    label: '立即执行',
    icon: Play,
    description: '创建后立刻开始执行；任务会出现在右侧任务列表。',
  },
  {
    value: 'scheduled',
    label: '定时一次',
    icon: Calendar,
    description: '在指定时间触发一次，然后停止',
  },
  {
    value: 'recurring',
    label: '周期触发',
    icon: Timer,
    description: '每隔固定时间触发一次，可设置结束条件',
  },
  {
    value: 'loop',
    label: 'Ralph Loop',
    icon: Repeat,
    description: '完成后立即下一轮（同会话持续打磨），必须设置退出条件',
  },
];

const NOTIFICATION_EVENTS: Array<{
  value: NonNullable<NotificationConfig['events']>[number];
  label: string;
}> = [
  { value: 'done', label: '完成' },
  { value: 'blocked', label: '阻塞' },
  { value: 'stopped', label: '暂停' },
  { value: 'verifying', label: '进入验证' },
  { value: 'endCondition', label: '循环收敛' },
];

const DEFAULT_EVENTS: NonNullable<NotificationConfig['events']> = [
  'done',
  'blocked',
  'endCondition',
];

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
  }, 200);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const visibleProjects = useMemo(
    () => projects.filter((p) => !p.internal),
    [projects],
  );

  // PRD §8.4 — match any of the thought's tags to a workspace name.
  const defaultProject = useMemo(() => {
    if (visibleProjects.length === 0) return null;
    const lowerTags = thought.tags.map((t) => t.toLowerCase());
    return (
      visibleProjects.find((p) =>
        lowerTags.includes(p.name.toLowerCase()),
      ) ?? visibleProjects[0]
    );
  }, [thought.tags, visibleProjects]);

  const defaultName = useMemo(() => deriveTaskName(thought.content), [thought.content]);

  // Form state. v0.1.69 scope is AI execution only — `executor` is pinned to
  // `'agent'`; the user-as-todo variant is a future extension.
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [workspacePath, setWorkspacePath] = useState<string>(
    defaultProject?.path ?? '',
  );
  const [executionMode, setExecutionMode] = useState<TaskExecutionMode>('once');
  const [runMode, setRunMode] = useState<TaskRunMode>('new-session');
  const [taskMd, setTaskMd] = useState(thought.content);
  const [tagsInput, setTagsInput] = useState(thought.tags.join(', '));

  // Schedule-specific state (mirrors cron TaskCreateModal fields)
  const [atDateTime, setAtDateTime] = useState(() =>
    toLocalDateTimeString(new Date(Date.now() + 3600_000)),
  );
  const [intervalMinutes, setIntervalMinutes] = useState(30);

  // End conditions
  const [endConditionMode, setEndConditionMode] = useState<'forever' | 'conditional'>('forever');
  const [deadline, setDeadline] = useState('');
  const [maxExecutions, setMaxExecutions] = useState('');
  const [aiCanExit, setAiCanExit] = useState(true);

  // Notification — reuse the cron channel hook so the dropdown is identical.
  const { options: deliveryOptions, hasChannels } = useDeliveryChannels(workspacePath);
  const [notifyEnabled, setNotifyEnabled] = useState(true);
  const [deliveryBotId, setDeliveryBotId] = useState('');
  const [subscribedEvents, setSubscribedEvents] = useState<
    NonNullable<NotificationConfig['events']>
  >(DEFAULT_EVENTS);

  const [busy, setBusy] = useState(false);

  // Keep runMode aligned with PRD §9.2 defaults when the user flips modes.
  useEffect(() => {
    if (executionMode === 'loop') setRunMode('single-session');
    else if (executionMode === 'recurring') setRunMode('new-session');
  }, [executionMode]);

  const workspace = useMemo(
    () => visibleProjects.find((p) => p.path === workspacePath) ?? null,
    [workspacePath, visibleProjects],
  );

  const projectOptions = useMemo(
    () =>
      visibleProjects.map((p) => ({
        value: p.path,
        label: p.displayName || p.name || p.path.split('/').pop() || p.path,
        icon: <WorkspaceIcon icon={p.icon} size={16} />,
      })),
    [visibleProjects],
  );

  const isScheduled = executionMode === 'scheduled';
  const isRecurring = executionMode === 'recurring';
  const isLoop = executionMode === 'loop';
  const isOnce = executionMode === 'once';
  const showEndConditions = isRecurring || isLoop;
  const showSessionStrategy = isRecurring || isLoop;

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (!name.trim()) errs.push('请填写任务名');
    if (!workspace) errs.push('请选择工作区');
    if (!taskMd.trim()) errs.push('task.md 不能为空');
    if (isScheduled) {
      const ts = Date.parse(atDateTime);
      if (Number.isNaN(ts) || ts <= Date.now()) errs.push('执行时间必须在未来');
    }
    if (isRecurring && intervalMinutes < 5) errs.push('周期间隔不能小于 5 分钟');
    if (showEndConditions && endConditionMode === 'conditional' && !deadline && !maxExecutions && !aiCanExit) {
      errs.push('请至少设置一个结束条件');
    }
    return errs;
  }, [
    name,
    workspace,
    taskMd,
    isScheduled,
    atDateTime,
    isRecurring,
    intervalMinutes,
    showEndConditions,
    endConditionMode,
    deadline,
    maxExecutions,
    aiCanExit,
  ]);

  const buildEndConditions = useCallback((): EndConditions | undefined => {
    if (!showEndConditions) return undefined;
    if (endConditionMode === 'forever') return { aiCanExit };
    const out: EndConditions = { aiCanExit };
    if (deadline) {
      const ts = Date.parse(deadline);
      if (!Number.isNaN(ts)) out.deadline = ts;
    }
    if (maxExecutions) {
      const n = parseInt(maxExecutions, 10);
      if (!Number.isNaN(n) && n > 0) out.maxExecutions = n;
    }
    return out;
  }, [showEndConditions, endConditionMode, aiCanExit, deadline, maxExecutions]);

  const buildNotification = useCallback((): NotificationConfig => {
    const cfg: NotificationConfig = {
      desktop: notifyEnabled,
      events: subscribedEvents,
    };
    if (deliveryBotId) cfg.botChannelId = deliveryBotId;
    return cfg;
  }, [notifyEnabled, subscribedEvents, deliveryBotId]);

  const handleSubmit = useCallback(async () => {
    if (errors.length > 0 || busy || !workspace) return;
    setBusy(true);
    try {
      const tags = tagsInput
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      // Encode scheduled / recurring details via `endConditions.deadline`
      // for scheduled mode. `recurring` gets `intervalMinutes` persisted on
      // the CronTask side when Rust's `schedule_from_task` translates the
      // Task (TODO: direct exec-mode interval support — today we rely on
      // the backend's 60-min default; wiring the form's `intervalMinutes`
      // into the backend requires a schema extension we'll land next).
      let ec = buildEndConditions();
      if (isScheduled) {
        const ts = Date.parse(atDateTime);
        if (!Number.isNaN(ts)) {
          ec = { ...(ec ?? { aiCanExit: false }), deadline: ts };
        }
      }
      const task = await taskCreateDirect({
        name: name.trim(),
        executor: 'agent',
        description: description.trim() || undefined,
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        taskMdContent: taskMd,
        executionMode,
        runMode: isOnce ? undefined : runMode,
        endConditions: ec,
        sourceThoughtId: thought.id,
        tags,
        notification: buildNotification(),
      });
      // PRD §8.2: `once` dispatches should fire immediately — the user
      // just asked to "立即执行", they shouldn't also have to click a
      // play button in the right panel. Other modes wait for their
      // schedule / recurrence to hit naturally.
      if (isOnce) {
        try {
          await taskRun(task.id);
          toast.success(`任务「${task.name}」已派发，AI 正在执行`);
        } catch (e) {
          toast.error(`任务已创建，但启动执行失败：${extractErrorMessage(e)}`);
        }
      } else {
        toast.success(`任务「${task.name}」已创建`);
      }
      onDispatched(task);
    } catch (e) {
      toast.error(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [
    errors.length,
    busy,
    workspace,
    tagsInput,
    buildEndConditions,
    isScheduled,
    atDateTime,
    name,
    description,
    taskMd,
    executionMode,
    isOnce,
    runMode,
    thought.id,
    buildNotification,
    toast,
    onDispatched,
  ]);

  const toggleEvent = useCallback(
    (ev: NonNullable<NotificationConfig['events']>[number]) => {
      setSubscribedEvents((prev) => {
        const set = new Set(prev);
        if (set.has(ev)) set.delete(ev);
        else set.add(ev);
        return Array.from(set);
      });
    },
    [],
  );

  return (
    <OverlayBackdrop onClose={onClose} className="z-[200]">
      <div className="flex h-[82vh] w-full max-w-2xl flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-lg">
        {/* ── Header ── */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--line-subtle)] px-7 py-5">
          <div className="flex items-center gap-2.5">
            <Zap className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-[16px] font-semibold text-[var(--ink)]">
              派发为任务
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Body — generous breathing room per design review ── */}
        <div className="flex-1 space-y-8 overflow-y-auto px-7 py-7">
          {/* 基本信息 */}
          <div>
            <SectionHeader icon={FileText}>基本信息</SectionHeader>
            <div className="mt-4 space-y-5 pl-6">
              <div>
                <label className="mb-2 block text-[13px] font-medium text-[var(--ink-secondary)]">
                  任务名称
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={MAX_NAME_LEN}
                  placeholder="例如: 升级 OpenClaw lark 适配器到 v2.4"
                  className={INPUT_CLS}
                />
              </div>

              <div>
                <label className="mb-2 block text-[13px] font-medium text-[var(--ink-secondary)]">
                  简短描述
                  <span className="ml-1 font-normal text-[var(--ink-muted)]">（可选）</span>
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="一行话说明，任务卡会展示"
                  className={INPUT_CLS}
                />
              </div>

              <div>
                <label className="mb-2 block text-[13px] font-medium text-[var(--ink-secondary)]">
                  执行 Agent（工作区）
                </label>
                <CustomSelect
                  value={workspacePath}
                  options={projectOptions}
                  onChange={setWorkspacePath}
                  placeholder="选择工作区"
                />
                <p className="mt-2 text-[13px] text-[var(--ink-muted)]">
                  使用该 Agent 的默认模型与权限配置。默认按想法标签匹配工作区。
                </p>
              </div>

              <div>
                <label className="mb-2 block text-[13px] font-medium text-[var(--ink-secondary)]">
                  task.md 内容
                </label>
                <textarea
                  value={taskMd}
                  onChange={(e) => setTaskMd(e.target.value)}
                  rows={6}
                  className={`${INPUT_CLS} resize-none`}
                />
                <p className="mt-2 text-[13px] text-[var(--ink-muted)]">
                  AI 执行时看到的 prompt，默认取自想法原文。你可以补充细节、目标、约束。
                </p>
              </div>

              <div>
                <label className="mb-2 block text-[13px] font-medium text-[var(--ink-secondary)]">
                  标签
                  <span className="ml-1 font-normal text-[var(--ink-muted)]">（可选）</span>
                </label>
                <input
                  type="text"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="以逗号分隔，例如 MyAgents, 维护"
                  className={INPUT_CLS}
                />
              </div>
            </div>
          </div>

          <div className="border-t border-[var(--line)]" />

          {/* 执行模式 */}
          <div>
            <SectionHeader icon={Clock}>执行模式</SectionHeader>
            <div className="mt-4 pl-6">
              <div className="flex gap-1.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] p-1">
                {EXECUTION_TABS.map((t) => {
                  const Icon = t.icon;
                  const active = executionMode === t.value;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setExecutionMode(t.value)}
                      className={`flex flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-2 text-[13px] font-medium transition-colors ${
                        active
                          ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs'
                          : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {t.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2.5 text-[13px] text-[var(--ink-muted)]">
                {EXECUTION_TABS.find((t) => t.value === executionMode)?.description}
              </p>

              {isScheduled && (
                <div className="mt-5">
                  <label className="mb-2 block text-[13px] font-medium text-[var(--ink-secondary)]">
                    执行时间
                  </label>
                  <input
                    type="datetime-local"
                    value={atDateTime}
                    onChange={(e) => setAtDateTime(e.target.value)}
                    min={toLocalDateTimeString(new Date(Date.now() + 60_000))}
                    className={INPUT_CLS}
                  />
                </div>
              )}

              {isRecurring && (
                <div className="mt-5">
                  <label className="mb-2 block text-[13px] font-medium text-[var(--ink-secondary)]">
                    周期间隔（分钟）
                  </label>
                  <input
                    type="number"
                    min={5}
                    max={10080}
                    value={intervalMinutes}
                    onChange={(e) => setIntervalMinutes(Math.max(5, Number(e.target.value) || 5))}
                    className={INPUT_CLS}
                  />
                  <p className="mt-2 text-[13px] text-[var(--ink-muted)]">
                    最小 5 分钟。更复杂的 Cron 表达式请在详情 Overlay 中编辑。
                  </p>
                </div>
              )}

              {showSessionStrategy && (
                <div className="mt-5">
                  <label className="mb-2 block text-[13px] font-medium text-[var(--ink-secondary)]">
                    会话策略
                  </label>
                  {isLoop ? (
                    <p className="text-sm text-[var(--ink-muted)]">
                      连续对话（保持上下文）— Ralph Loop 固定使用此模式
                    </p>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <PillButton
                          selected={runMode === 'new-session'}
                          onClick={() => setRunMode('new-session')}
                        >
                          新开对话
                        </PillButton>
                        <PillButton
                          selected={runMode === 'single-session'}
                          onClick={() => setRunMode('single-session')}
                        >
                          连续对话
                        </PillButton>
                      </div>
                      <p className="mt-2 text-[13px] text-[var(--ink-muted)]">
                        {runMode === 'new-session'
                          ? '每次执行创建新会话，无历史记忆，上下文干净'
                          : '所有轮次复用同一会话，AI 能记住之前内容'}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {showEndConditions && (
            <>
              <div className="border-t border-[var(--line)]" />
              <div>
                <SectionHeader icon={Flag}>结束条件</SectionHeader>
                <div className="mt-4 space-y-3.5 pl-6">
                  <div className="flex gap-1.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] p-1">
                    <button
                      type="button"
                      onClick={() => setEndConditionMode('forever')}
                      className={`flex flex-1 items-center justify-center rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] font-medium transition-colors ${
                        endConditionMode === 'forever'
                          ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs'
                          : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                      }`}
                    >
                      永久运行
                    </button>
                    <button
                      type="button"
                      onClick={() => setEndConditionMode('conditional')}
                      className={`flex flex-1 items-center justify-center rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] font-medium transition-colors ${
                        endConditionMode === 'conditional'
                          ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs'
                          : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                      }`}
                    >
                      条件停止
                    </button>
                  </div>

                  {endConditionMode === 'conditional' && (
                    <>
                      <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)]">
                        <div
                          className="flex cursor-pointer items-center justify-between border-b border-[var(--line)] px-3 py-2.5"
                          onClick={() =>
                            setDeadline(
                              deadline
                                ? ''
                                : toLocalDateTimeString(new Date(Date.now() + 86400_000)),
                            )
                          }
                        >
                          <Checkbox
                            checked={!!deadline}
                            onChange={(v) =>
                              setDeadline(
                                v ? toLocalDateTimeString(new Date(Date.now() + 86400_000)) : '',
                              )
                            }
                            label="截止时间"
                          />
                          <input
                            type="datetime-local"
                            value={deadline}
                            onChange={(e) => setDeadline(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className={`w-44 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none ${
                              !deadline ? 'opacity-50' : ''
                            }`}
                          />
                        </div>
                        <div
                          className="flex cursor-pointer items-center justify-between px-3 py-2.5"
                          onClick={() => setMaxExecutions(maxExecutions ? '' : '10')}
                        >
                          <Checkbox
                            checked={!!maxExecutions}
                            onChange={(v) => setMaxExecutions(v ? '10' : '')}
                            label="执行次数"
                          />
                          <div
                            className="flex items-center gap-1.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="number"
                              min={1}
                              max={999}
                              value={maxExecutions || 10}
                              onChange={(e) => setMaxExecutions(e.target.value)}
                              className={`w-16 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-center text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none ${
                                !maxExecutions ? 'opacity-50' : ''
                              }`}
                            />
                            <span
                              className={`text-sm text-[var(--ink-secondary)] ${
                                !maxExecutions ? 'opacity-50' : ''
                              }`}
                            >
                              次
                            </span>
                          </div>
                        </div>
                      </div>
                      <p className="text-[13px] text-[var(--ink-muted)]">
                        可多选，满足任一条件时任务将自动停止
                      </p>
                    </>
                  )}

                  <div
                    className="flex cursor-pointer items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5"
                    onClick={() => setAiCanExit(!aiCanExit)}
                  >
                    <Checkbox
                      checked={aiCanExit}
                      onChange={setAiCanExit}
                      label="允许 AI 自主结束任务"
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="border-t border-[var(--line)]" />

          {/* 任务通知 */}
          <div>
            <SectionHeader icon={Bell}>任务通知</SectionHeader>
            <div className="mt-4 space-y-3.5 pl-6">
              <div className="flex items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
                <span className="text-sm text-[var(--ink)]">
                  每次任务状态变化时发送通知
                </span>
                <ToggleSwitch enabled={notifyEnabled} onChange={setNotifyEnabled} />
              </div>

              {notifyEnabled && (
                <>
                  {hasChannels && (
                    <div className="space-y-2">
                      <label className="text-[13px] font-medium text-[var(--ink-secondary)]">
                        投递渠道
                      </label>
                      <CustomSelect
                        value={deliveryBotId}
                        options={deliveryOptions}
                        onChange={setDeliveryBotId}
                        placeholder="桌面通知（默认）"
                      />
                    </div>
                  )}
                  <div className="space-y-2">
                    <label className="text-[13px] font-medium text-[var(--ink-secondary)]">
                      通知事件
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {NOTIFICATION_EVENTS.map((e) => {
                        const active = subscribedEvents.includes(e.value);
                        return (
                          <button
                            key={e.value}
                            type="button"
                            onClick={() => toggleEvent(e.value)}
                            aria-pressed={active}
                            className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
                              active
                                ? 'bg-[var(--accent)] text-white'
                                : 'bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                            }`}
                          >
                            {e.label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[13px] text-[var(--ink-muted)]">
                      默认订阅「完成 / 阻塞 / 循环收敛」，足以覆盖大多数场景
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="flex shrink-0 items-center justify-between border-t border-[var(--line)] px-7 py-4">
          {errors.length > 0 ? (
            <p className="text-[12px] text-[var(--error)]">{errors[0]}</p>
          ) : (
            <div />
          )}
          <div className="flex items-center gap-2.5">
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
            >
              取消
            </button>
            <button
              onClick={() => void handleSubmit()}
              disabled={errors.length > 0 || busy}
              className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white transition hover:bg-[var(--accent-warm-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? '派发中…' : '派发任务'}
            </button>
          </div>
        </div>
      </div>
    </OverlayBackdrop>
  );
}

// Derive a concise task name from thought body:
//   1. walk lines in order; pick the first one whose stripped form (tags
//      removed via the shared parser, so boundary rules match Rust) is
//      non-empty. This handles thoughts whose first line is a pure
//      `#tag1 #tag2` header — we scroll past it to the real title line.
//   2. if every line is tag-only (the user really did save "#idea"
//      alone), fall back to the first raw line so the field isn't blank.
//   3. clamp to MAX_NAME_LEN codepoints (not UTF-16 code units) so we
//      can't slice mid-surrogate on emoji / astral-plane chars.
const MAX_NAME_LEN = 40;

function stripTagRuns(line: string): string {
  return splitWithTagHighlights(line)
    .filter((seg) => seg.type !== 'tag')
    .map((seg) => seg.value)
    .join('')
    .trim();
}

function deriveTaskName(content: string): string {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  let candidate = '';
  for (const line of lines) {
    const stripped = stripTagRuns(line);
    if (stripped) {
      candidate = stripped;
      break;
    }
  }
  // Pure-tag thought (e.g. "#idea") — keep the tags visible rather than
  // handing back an empty string.
  if (!candidate && lines.length > 0) candidate = lines[0];
  const cps = Array.from(candidate);
  if (cps.length <= MAX_NAME_LEN) return candidate;
  return cps.slice(0, MAX_NAME_LEN - 1).join('') + '…';
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
