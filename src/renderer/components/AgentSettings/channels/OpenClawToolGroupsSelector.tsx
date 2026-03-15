import React, { useCallback, useMemo } from 'react';

interface ToolGroup {
    id: string;
    name: string;
    description: string;
    toolCount: number;
    defaultEnabled: boolean;
}

const FEISHU_TOOL_GROUPS: ToolGroup[] = [
    { id: 'doc', name: '文档', description: '云文档创建/读取/更新', toolCount: 2, defaultEnabled: true },
    { id: 'chat', name: '消息', description: '群聊信息/成员查询', toolCount: 1, defaultEnabled: true },
    { id: 'wiki_drive', name: '知识库 & 云盘', description: '知识库/云盘文件管理', toolCount: 3, defaultEnabled: true },
    { id: 'bitable', name: '多维表格', description: '表格/记录/字段 CRUD', toolCount: 8, defaultEnabled: true },
    { id: 'perm', name: '权限管理', description: '文档权限设置（敏感操作）', toolCount: 1, defaultEnabled: false },
];

const TOOL_GROUPS_BY_PLUGIN: Record<string, ToolGroup[]> = {
    'openclaw-lark': FEISHU_TOOL_GROUPS,
};

interface OpenClawToolGroupsSelectorProps {
    enabledGroups: string[] | undefined;
    onChange: (groups: string[]) => void;
    pluginId: string;
}

export default function OpenClawToolGroupsSelector({
    enabledGroups,
    onChange,
    pluginId,
}: OpenClawToolGroupsSelectorProps) {
    const toolGroups = TOOL_GROUPS_BY_PLUGIN[pluginId];

    // Resolve effective enabled groups: if undefined, use defaults
    const effectiveGroups = useMemo(() => {
        if (!toolGroups) return [];
        if (enabledGroups !== undefined) return enabledGroups;
        return toolGroups.filter(g => g.defaultEnabled).map(g => g.id);
    }, [enabledGroups, toolGroups]);

    const handleToggle = useCallback((groupId: string) => {
        const isEnabled = effectiveGroups.includes(groupId);
        const newGroups = isEnabled
            ? effectiveGroups.filter(id => id !== groupId)
            : [...effectiveGroups, groupId];
        onChange(newGroups);
    }, [effectiveGroups, onChange]);

    // If no tool groups defined for this plugin, don't render
    if (!toolGroups) return null;

    return (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
            <h3 className="mb-4 text-sm font-semibold text-[var(--ink)]">工具组</h3>
            <p className="mb-3 text-xs text-[var(--ink-muted)]">
                选择插件可使用的工具组，关闭不需要的工具组可减少 Token 消耗
            </p>
            <div className="space-y-2">
                {toolGroups.map((group) => {
                    const checked = effectiveGroups.includes(group.id);
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
