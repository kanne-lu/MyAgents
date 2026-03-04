/**
 * SessionTagBadge - Tag badges for session sources (IM, Cron, Background)
 * Design v2: desaturated warm-toned badges with left accent border
 */

import type { SessionTag } from '@/hooks/useTaskCenterData';

/** Per-platform accent colors (desaturated to blend with warm palette) */
const IM_BORDER_COLORS: Record<string, string> = {
    feishu: '#8ca0b6',
    telegram: '#7d9eb5',
    dingtalk: '#8a9eb0',
};

export default function SessionTagBadge({ tag }: { tag: SessionTag }) {
    if (tag.type === 'im') {
        const borderColor = IM_BORDER_COLORS[tag.platform] ?? '#8ca0b6';
        return (
            <span
                className="shrink-0 rounded border-l-2 bg-[var(--paper-elevated)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]"
                style={{ borderLeftColor: borderColor }}
            >
                {tag.platform}
            </span>
        );
    }
    if (tag.type === 'cron') {
        return (
            <span className="shrink-0 rounded border-l-2 border-l-[#b08878] bg-[var(--paper-elevated)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]">
                心跳
            </span>
        );
    }
    if (tag.type === 'background') {
        return (
            <span className="shrink-0 rounded border-l-2 border-l-[#b09a6a] bg-[var(--paper-elevated)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]">
                后台
            </span>
        );
    }
    return null;
}
