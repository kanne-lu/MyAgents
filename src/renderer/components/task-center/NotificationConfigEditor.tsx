// NotificationConfigEditor — shared UI for configuring per-task notifications.
// Used inside DispatchTaskDialog (at task creation) and TaskDetailOverlay
// (edit after the fact). PRD §7.3 / §8.2 / §12.
//
// Current UI surface (trimmed for v0.1.69 — the `chat_id` input and event
// subscription pills were deemed too power-usery for a first-time user
// and removed):
//   • desktop toggle
//   • bot channel dropdown
//
// `botThread` is still carried on `NotificationConfig`; the backend
// projects it through to CronTask.delivery's chat_id. For now it's set
// to `undefined` (→ server-side `_auto_` sentinel → bot router picks
// the default chat). `events` is also preserved on the payload and
// defaults to `['done','blocked','endCondition']` which is the same set
// the dispatch_notification path uses. If either becomes
// user-configurable again, re-expose here without touching backend
// contracts.

import { useMemo } from 'react';
import { useConfig } from '@/hooks/useConfig';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import { getPlatformLabel } from '@/utils/platformLabel';
import type { NotificationConfig } from '@/../shared/types/task';

const DEFAULT_EVENTS: NonNullable<NotificationConfig['events']> = [
  'done',
  'blocked',
  'endCondition',
];

interface Props {
  value?: NotificationConfig;
  onChange: (next: NotificationConfig) => void;
}

export function NotificationConfigEditor({ value, onChange }: Props) {
  // Sourced from `config.agents` + `projects` instead of the 5s-polled
  // `useAgentStatuses`. Two reasons:
  //   1. Stability — `statuses` is re-fetched on a 5s interval and the
  //      `Object.values()` iteration order can shift between ticks, so
  //      the dropdown would silently reshuffle while the user had it open.
  //   2. Label quality — `statuses` carries `agentName` + a per-channel
  //      `name` that is usually the bot's handle (e.g. "@mino115_bot"),
  //      not useful context. Users want to recognise their workspace, so
  //      we show `workspace displayName · 平台`.
  const { config, projects } = useConfig();

  const channelOptions: SelectOption[] = useMemo(() => {
    // agentId → workspace displayName, for the left half of each label.
    const workspaceNameByAgentId = new Map<string, string>();
    for (const p of projects) {
      if (p.agentId) {
        workspaceNameByAgentId.set(p.agentId, p.displayName || p.name);
      }
    }

    interface Row {
      value: string;
      workspaceName: string;
      platformLabel: string;
    }
    const rows: Row[] = [];
    for (const agent of config.agents ?? []) {
      // Skip agents the user has disabled — picking a channel on a disabled
      // agent means notifications would never arrive.
      if (!agent.enabled) continue;
      const workspaceName = workspaceNameByAgentId.get(agent.id) || agent.name;
      for (const ch of agent.channels ?? []) {
        if (!ch.enabled) continue;
        rows.push({
          value: ch.id,
          workspaceName,
          platformLabel: getPlatformLabel(ch.type),
        });
      }
    }
    // Stable sort: workspace name (locale-aware) → platform label. The
    // underlying arrays are driven by React state that may arrive in any
    // order; explicit sort guarantees the dropdown never reshuffles as
    // long as workspaces/channels don't actually change.
    rows.sort((a, b) => {
      const ws = a.workspaceName.localeCompare(b.workspaceName, 'zh-Hans-CN');
      if (ws !== 0) return ws;
      return a.platformLabel.localeCompare(b.platformLabel, 'zh-Hans-CN');
    });
    const out: SelectOption[] = [{ value: '', label: '不发送到 Bot' }];
    for (const r of rows) {
      out.push({ value: r.value, label: `${r.workspaceName} · ${r.platformLabel}` });
    }
    return out;
  }, [config.agents, projects]);

  const current: NotificationConfig = {
    desktop: value?.desktop ?? true,
    botChannelId: value?.botChannelId,
    botThread: value?.botThread,
    events: value?.events ?? DEFAULT_EVENTS,
  };

  const patch = (p: Partial<NotificationConfig>) => onChange({ ...current, ...p });

  return (
    <div className="flex flex-col gap-2.5 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5">
      <div className="flex items-center justify-between text-[12px] text-[var(--ink)]">
        <span>桌面通知</span>
        <Toggle
          checked={current.desktop}
          onChange={(v) => patch({ desktop: v })}
          ariaLabel="桌面通知开关"
        />
      </div>

      <div>
        <label className="mb-1 block text-[12px] text-[var(--ink-secondary)]">
          发送到 IM Bot（可选）
        </label>
        <CustomSelect
          value={current.botChannelId ?? ''}
          options={channelOptions}
          onChange={(v) => patch({ botChannelId: v || undefined })}
          placeholder="不发送到 Bot"
          compact
        />
      </div>
    </div>
  );
}

/**
 * Design-system-compliant toggle switch (DESIGN.md §6.6). 44×24px capsule
 * with a 20px white slider. Uses `--accent` when on, `--line-strong` when off.
 */
function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-150 ${
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-150 ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export default NotificationConfigEditor;
