import React, { useCallback, useMemo } from 'react';

interface ToolGroup {
    id: string;
    name: string;
    description: string;
    toolCount: number;
    /** If false, this group is sensitive and opt-in only */
    sensitive?: boolean;
}

const FEISHU_TOOL_GROUPS: ToolGroup[] = [
    { id: 'doc', name: '文档', description: '云文档创建/读取/更新', toolCount: 6 },
    { id: 'chat', name: '消息', description: '群聊信息/成员查询', toolCount: 2 },
    { id: 'wiki_drive', name: '知识库 & 云盘', description: '知识库/云盘文件管理', toolCount: 3 },
    { id: 'bitable', name: '多维表格', description: '表格/记录/字段 CRUD', toolCount: 5 },
    { id: 'calendar', name: '日历', description: '日历/日程/参会人/空闲查询', toolCount: 4 },
    { id: 'task', name: '任务', description: '任务/任务列表/评论/子任务', toolCount: 4 },
    { id: 'sheet', name: '电子表格', description: '电子表格读写', toolCount: 1 },
    { id: 'search', name: '搜索', description: '搜索文档和知识库', toolCount: 1 },
    { id: 'im', name: 'IM 操作', description: '消息发送/资源获取/已读状态', toolCount: 4, sensitive: true },
    { id: 'common', name: '用户信息', description: '查询/搜索飞书用户', toolCount: 2 },
    { id: 'perm', name: '权限管理', description: '文档权限设置（敏感操作）', toolCount: 1, sensitive: true },
];

const TOOL_GROUPS_BY_PLUGIN: Record<string, ToolGroup[]> = {
    'openclaw-lark': FEISHU_TOOL_GROUPS,
};

interface OpenClawToolGroupsSelectorProps {
    enabledGroups: string[] | undefined;
    onChange: (groups: string[] | undefined) => void;
    pluginId: string;
}

export default function OpenClawToolGroupsSelector({
    enabledGroups,
    onChange,
    pluginId,
}: OpenClawToolGroupsSelectorProps) {
    const toolGroups = TOOL_GROUPS_BY_PLUGIN[pluginId];

    // undefined = all groups enabled (no restriction). Only becomes explicit when user customizes.
    const isAllEnabled = enabledGroups === undefined;

    const handleToggle = useCallback((groupId: string) => {
        if (isAllEnabled) {
            // First customization: start from "all enabled", remove the toggled group
            const allIds = toolGroups?.map(g => g.id) ?? [];
            onChange(allIds.filter(id => id !== groupId));
        } else {
            const isEnabled = enabledGroups!.includes(groupId);
            const newGroups = isEnabled
                ? enabledGroups!.filter(id => id !== groupId)
                : [...enabledGroups!, groupId];
            // If user re-enables everything, revert to undefined (= all enabled)
            if (toolGroups && newGroups.length >= toolGroups.length
                && toolGroups.every(g => newGroups.includes(g.id))) {
                onChange(undefined);
            } else {
                onChange(newGroups);
            }
        }
    }, [isAllEnabled, enabledGroups, toolGroups, onChange]);

    // If no tool groups defined for this plugin, don't render
    if (!toolGroups) return null;

    return (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
            <h3 className="mb-4 text-sm font-semibold text-[var(--ink)]">工具组</h3>
            <p className="mb-3 text-xs text-[var(--ink-muted)]">
                {isAllEnabled
                    ? '当前已启用全部工具组。取消勾选可减少 Token 消耗。'
                    : '选择插件可使用的工具组，关闭不需要的工具组可减少 Token 消耗'}
            </p>
            <div className="space-y-2">
                {toolGroups.map((group) => {
                    const checked = isAllEnabled || enabledGroups!.includes(group.id);
                    return (
                        <label
                            key={group.id}
                            className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--line)] p-3 transition-colors hover:border-[var(--line-strong)]"
                        >
                            <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => handleToggle(group.id)}
                                className="h-4 w-4 rounded border-[var(--line)]"
                            />
                            <div className="flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-medium text-[var(--ink)]">{group.name}</p>
                                    <span className="rounded-full bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-subtle)]">
                                        {group.toolCount} 个工具
                                    </span>
                                    {group.sensitive && (
                                        <span className="rounded-full bg-[var(--warning-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--warning)]">
                                            敏感
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs text-[var(--ink-muted)]">{group.description}</p>
                            </div>
                        </label>
                    );
                })}
            </div>
        </div>
    );
}
