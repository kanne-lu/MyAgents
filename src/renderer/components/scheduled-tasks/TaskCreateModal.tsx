/**
 * TaskCreateModal — Full-featured modal for creating scheduled tasks independently.
 * Entry: TaskCenterOverlay [+ 新建] button, RecentTasks [+ 新建] button.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { X, Clock, Check } from 'lucide-react';
import { v4 as uuid } from 'uuid';

import ScheduleTypeTabs from './ScheduleTypeTabs';
import CustomSelect from '@/components/CustomSelect';
import { useConfig } from '@/hooks/useConfig';
import { useToast } from '@/components/Toast';
import * as cronClient from '@/api/cronTaskClient';
import type { CronSchedule, CronEndConditions } from '@/types/cronTask';
import { MIN_CRON_INTERVAL } from '@/types/cronTask';

/** Format a Date as local YYYY-MM-DDTHH:mm for datetime-local input */
function toLocalDateTimeString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface TaskCreateModalProps {
  onClose: () => void;
  onCreated?: () => void;
}

/** Shared input class */
const INPUT_CLS = 'w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none transition-colors';

/** Custom checkbox */
function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-[13px] text-[var(--ink-muted)]"
    >
      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
        checked
          ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
          : 'border-[var(--line-strong)] bg-transparent'
      }`}>
        {checked && <Check className="h-2.5 w-2.5" />}
      </span>
      {label}
    </button>
  );
}

/** Section title (11px uppercase, matches design_guide Section Header spec) */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
      {children}
    </h3>
  );
}

export default function TaskCreateModal({ onClose, onCreated }: TaskCreateModalProps) {
  const { projects } = useConfig();
  const toast = useToast();

  // Form state
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>(projects[0]?.path ?? '');
  const [schedule, setSchedule] = useState<CronSchedule | null>(null);
  const [intervalMinutes, setIntervalMinutes] = useState(30);
  const [notifyEnabled, setNotifyEnabled] = useState(true);

  // End conditions
  const [endConditionMode, setEndConditionMode] = useState<'conditional' | 'forever'>('forever');
  const [deadline, setDeadline] = useState('');
  const [maxExecutions, setMaxExecutions] = useState('');
  const [aiCanExit, setAiCanExit] = useState(true);

  const [isCreating, setIsCreating] = useState(false);

  const isAtSchedule = schedule?.kind === 'at';

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const projectOptions = useMemo(() =>
    projects.map(p => ({ value: p.path, label: p.name || p.path.split('/').pop() || p.path })),
    [projects]
  );

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (!prompt.trim()) errs.push('请输入 AI 指令');
    if (!selectedProjectPath) errs.push('请选择工作区');
    if (!schedule && intervalMinutes < MIN_CRON_INTERVAL) errs.push(`间隔不能小于 ${MIN_CRON_INTERVAL} 分钟`);
    if (schedule?.kind === 'at') {
      const atTime = new Date(schedule.at).getTime();
      if (isNaN(atTime) || atTime <= Date.now()) errs.push('执行时间必须在未来');
    }
    if (endConditionMode === 'conditional' && !isAtSchedule && !deadline && !maxExecutions && !aiCanExit) {
      errs.push('请至少设置一个结束条件');
    }
    return errs;
  }, [prompt, selectedProjectPath, schedule, intervalMinutes, endConditionMode, deadline, maxExecutions, aiCanExit, isAtSchedule]);

  const handleScheduleChange = useCallback((newSchedule: CronSchedule | null, newInterval: number) => {
    setSchedule(newSchedule);
    setIntervalMinutes(newInterval);
  }, []);

  const handleCreate = useCallback(async () => {
    if (errors.length > 0 || isCreating) return;
    setIsCreating(true);
    try {
      const sessionId = `cron-standalone-${uuid()}`;
      const endConditions: CronEndConditions = isAtSchedule
        ? { aiCanExit: false }
        : endConditionMode === 'forever'
          ? { aiCanExit }
          : {
              deadline: deadline ? new Date(deadline).toISOString() : undefined,
              maxExecutions: maxExecutions ? parseInt(maxExecutions, 10) : undefined,
              aiCanExit,
            };

      const task = await cronClient.createCronTask({
        workspacePath: selectedProjectPath,
        sessionId,
        prompt: prompt.trim(),
        intervalMinutes: schedule?.kind === 'every' ? schedule.minutes : intervalMinutes,
        endConditions,
        runMode: 'new_session',
        notifyEnabled,
        schedule: schedule ?? undefined,
        name: name.trim() || undefined,
      });

      await cronClient.startCronTask(task.id);
      await cronClient.startCronScheduler(task.id);
      toast.success('定时任务已创建');
      onCreated?.();
      onClose();
    } catch (err) {
      toast.error(`创建失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsCreating(false);
    }
  }, [errors, isCreating, name, prompt, selectedProjectPath, schedule, intervalMinutes, endConditionMode, deadline, maxExecutions, aiCanExit, notifyEnabled, onClose, onCreated, toast, isAtSchedule]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={handleBackdropClick}
    >
      <div className="flex h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-lg">
        {/* ── Header ── */}
        <div className="flex shrink-0 items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Clock className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-[15px] font-semibold text-[var(--ink)]">新建定时任务</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-[var(--radius-sm)] p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Body (scrollable) ── */}
        <div className="flex-1 overflow-y-auto px-6 pb-6">

          {/* Section: 基本信息 */}
          <div className="space-y-4">
            <SectionTitle>基本信息</SectionTitle>

            {/* Task Name */}
            <div>
              <label className="mb-1 block text-[13px] font-medium text-[var(--ink-secondary)]">
                任务名称<span className="ml-1 font-normal text-[var(--ink-muted)]">（可选）</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={50}
                placeholder="例如: 每日新闻摘要"
                className={INPUT_CLS}
              />
            </div>

            {/* Agent */}
            <div>
              <label className="mb-1 block text-[13px] font-medium text-[var(--ink-secondary)]">执行 Agent</label>
              <CustomSelect
                value={selectedProjectPath}
                options={projectOptions}
                onChange={setSelectedProjectPath}
                placeholder="选择工作区"
              />
              <p className="mt-1 text-[11px] text-[var(--ink-muted)]/50">使用该 Agent 的默认模型与权限配置</p>
            </div>

            {/* Prompt */}
            <div>
              <label className="mb-1 block text-[13px] font-medium text-[var(--ink-secondary)]">AI 指令</label>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                rows={3}
                placeholder="描述你希望 AI 定时执行的任务..."
                className={`${INPUT_CLS} resize-none`}
              />
            </div>
          </div>

          {/* Divider */}
          <div className="my-5 border-t border-[var(--line-subtle)]" />

          {/* Section: 执行计划 */}
          <div>
            <SectionTitle>执行计划</SectionTitle>
            <div className="mt-3">
              <ScheduleTypeTabs
                value={schedule}
                intervalMinutes={intervalMinutes}
                onChange={handleScheduleChange}
              />
            </div>
          </div>

          {/* Divider */}
          <div className="my-5 border-t border-[var(--line-subtle)]" />

          {/* Section: 结束条件与通知 (always visible, hidden only for at) */}
          {!isAtSchedule && (
            <div>
              <SectionTitle>结束条件与通知</SectionTitle>
              <div className="mt-3 space-y-3">
                {/* Mode toggle */}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEndConditionMode('conditional')}
                    className={`rounded-[var(--radius-sm)] border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                      endConditionMode === 'conditional'
                        ? 'border-[var(--accent)] bg-[var(--accent-warm-subtle)] text-[var(--accent)]'
                        : 'border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--line-strong)]'
                    }`}
                  >
                    条件停止
                  </button>
                  <button
                    type="button"
                    onClick={() => setEndConditionMode('forever')}
                    className={`rounded-[var(--radius-sm)] border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                      endConditionMode === 'forever'
                        ? 'border-[var(--accent)] bg-[var(--accent-warm-subtle)] text-[var(--accent)]'
                        : 'border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--line-strong)]'
                    }`}
                  >
                    永久运行
                  </button>
                </div>

                {endConditionMode === 'conditional' && (
                  <div className="space-y-2.5 pl-0.5">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={!!deadline}
                        onChange={v => setDeadline(v ? toLocalDateTimeString(new Date(Date.now() + 86400000)) : '')}
                        label="截止时间"
                      />
                      {deadline && (
                        <input
                          type="datetime-local"
                          value={deadline}
                          onChange={e => setDeadline(e.target.value)}
                          className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-2 py-1 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
                        />
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={!!maxExecutions}
                        onChange={v => setMaxExecutions(v ? '10' : '')}
                        label="最大执行次数"
                      />
                      {maxExecutions && (
                        <input
                          type="number"
                          min={1}
                          max={999}
                          value={maxExecutions}
                          onChange={e => setMaxExecutions(e.target.value)}
                          className="w-16 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-2 py-1 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
                        />
                      )}
                    </div>
                  </div>
                )}

                {/* Always visible */}
                <div className="space-y-2.5 pl-0.5">
                  <Checkbox checked={aiCanExit} onChange={setAiCanExit} label="允许 AI 自主结束任务" />
                  <Checkbox checked={notifyEnabled} onChange={setNotifyEnabled} label="每次执行完发送通知" />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex shrink-0 items-center justify-between border-t border-[var(--line)] px-6 py-3.5">
          {errors.length > 0 ? (
            <p className="text-xs text-[var(--error)]">{errors[0]}</p>
          ) : <div />}
          <div className="flex items-center gap-2.5">
            <button
              onClick={onClose}
              className="rounded-[var(--radius-md)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={errors.length > 0 || isCreating}
              className="rounded-[var(--radius-md)] bg-[var(--button-primary-bg)] px-5 py-2 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isCreating ? '创建中...' : '创建并启动'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
