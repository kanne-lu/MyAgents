import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ExternalLink, FolderOpen, FolderPlus, Loader2, Plus, Puzzle, Trash2 } from 'lucide-react';
import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import CustomSelect from '@/components/CustomSelect';
import type { ImBotConfig, ImBotStatus, ImPlatform, InstalledPlugin } from '../../../shared/types/im';
import { findPromotedPlugin } from './promotedPlugins';

// ===== Config Field Editor =====

interface ConfigField {
    key: string;
    value: string;
}

function ConfigFieldEditor({
    fields,
    onChange,
}: {
    fields: ConfigField[];
    onChange: (fields: ConfigField[]) => void;
}) {
    const updateField = (index: number, part: 'key' | 'value', val: string) => {
        const next = [...fields];
        next[index] = { ...next[index], [part]: val };
        onChange(next);
    };

    const removeField = (index: number) => {
        onChange(fields.filter((_, i) => i !== index));
    };

    const addField = () => {
        onChange([...fields, { key: '', value: '' }]);
    };

    return (
        <div className="space-y-2">
            {fields.map((field, i) => (
                <div key={i} className="flex items-center gap-2">
                    <input
                        type="text"
                        value={field.key}
                        onChange={(e) => updateField(i, 'key', e.target.value)}
                        placeholder="配置名"
                        className="w-[140px] shrink-0 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors"
                    />
                    <input
                        type="text"
                        value={field.value}
                        onChange={(e) => updateField(i, 'value', e.target.value)}
                        placeholder="值"
                        className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors"
                    />
                    <button
                        onClick={() => removeField(i)}
                        className="shrink-0 rounded-lg p-1.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--error)]"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </button>
                </div>
            ))}
            <button
                onClick={addField}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
                <Plus className="h-3.5 w-3.5" />
                添加配置项
            </button>
        </div>
    );
}

// ===== Schema-driven Config Inputs =====

function SchemaConfigInputs({
    schema,
    requiredKeys,
    values,
    onChange,
}: {
    schema: Record<string, { type?: string; description?: string }>;
    requiredKeys: Set<string>;
    values: Record<string, string>;
    onChange: (values: Record<string, string>) => void;
}) {
    const keys = Object.keys(schema);
    return (
        <div className="space-y-3">
            {keys.map((key) => {
                const field = schema[key];
                const isRequired = requiredKeys.has(key);
                return (
                    <div key={key}>
                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                            {key}
                            {isRequired && <span className="ml-1 text-[var(--error)]">*</span>}
                        </label>
                        {field.description && (
                            <p className="mb-1 text-xs text-[var(--ink-muted)]">{field.description}</p>
                        )}
                        <input
                            type={/secret|token|password|key/i.test(key) ? 'password' : 'text'}
                            value={values[key] || ''}
                            onChange={(e) => onChange({ ...values, [key]: e.target.value })}
                            placeholder={`输入 ${key}`}
                            className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors"
                        />
                    </div>
                );
            })}
        </div>
    );
}

// ===== Main Wizard =====

export default function OpenClawWizard({
    plugin,
    onComplete,
    onCancel,
}: {
    plugin: InstalledPlugin;
    onComplete: (botId: string) => void;
    onCancel: () => void;
}) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const { projects, addProject, refreshConfig } = useConfig();
    const isMountedRef = useRef(true);

    // Step 1: Configure plugin
    // Step 2: Select workspace
    // Step 3: Start bot
    const [step, setStep] = useState(1);

    // Derive config approach from manifest
    const schemaProperties = plugin.manifest?.configSchema?.properties;
    const hasSchema = schemaProperties && Object.keys(schemaProperties).length > 0;
    const schemaRequiredKeys = useMemo(
        () => new Set(plugin.manifest?.configSchema?.required ?? []),
        [plugin.manifest?.configSchema?.required],
    );

    // Config state — pre-populate from requiredFields extracted from plugin source.
    // If schema is available, requiredFields are already covered by SchemaConfigInputs,
    // so don't duplicate them in customFields.
    const [schemaValues, setSchemaValues] = useState<Record<string, string>>({});
    const [customFields, setCustomFields] = useState<ConfigField[]>(() => {
        if (hasSchema) return [{ key: '', value: '' }]; // Schema handles known fields
        const required = plugin.requiredFields;
        if (required && required.length > 0) {
            return required.map((key) => ({ key, value: '' }));
        }
        return [{ key: '', value: '' }];
    });

    // Workspace state — default to 'new' like Feishu wizard
    const [workspaceChoice, setWorkspaceChoice] = useState<'new' | 'existing'>('new');
    const [selectedExistingPath, setSelectedExistingPath] = useState('');
    const [creatingWorkspace, setCreatingWorkspace] = useState(false);
    const createdWorkspacePathRef = useRef<string | undefined>(undefined);

    // Start state
    const [starting, setStarting] = useState(false);

    const botId = useRef(crypto.randomUUID()).current;

    useEffect(() => {
        return () => { isMountedRef.current = false; };
    }, []);

    // Initialize workspace selection
    useEffect(() => {
        if (projects.length > 0 && !selectedExistingPath) {
            const mino = projects.find(p => p.path.replace(/\\/g, '/').endsWith('/mino'));
            setSelectedExistingPath(mino?.path || projects[0]?.path || '');
        }
    }, [projects, selectedExistingPath]);

    // Build merged config from schema values + custom fields
    const buildConfig = useCallback((): Record<string, string> => {
        const cfg: Record<string, string> = { ...schemaValues };
        for (const f of customFields) {
            if (f.key.trim()) {
                cfg[f.key.trim()] = f.value.trim();
            }
        }
        return cfg;
    }, [schemaValues, customFields]);

    const workspaceName = plugin.manifest?.name || plugin.pluginId;

    const handleWorkspaceNext = useCallback(async () => {
        setCreatingWorkspace(true);
        try {
            if (workspaceChoice === 'new') {
                if (createdWorkspacePathRef.current) {
                    // Reuse previously created workspace if user navigated back
                    setSelectedExistingPath(createdWorkspacePathRef.current);
                } else if (isTauriEnvironment()) {
                    const { invoke } = await import('@tauri-apps/api/core');
                    const result = await invoke<{ path: string; is_new: boolean }>('cmd_create_bot_workspace', {
                        workspaceName,
                    });
                    createdWorkspacePathRef.current = result.path;
                    setSelectedExistingPath(result.path);
                    await addProject(result.path);
                    await refreshConfig();
                }
            } else {
                if (!selectedExistingPath) {
                    toastRef.current.error('请选择一个工作区');
                    setCreatingWorkspace(false);
                    return;
                }
            }
            if (isMountedRef.current) setStep(3);
        } catch (err) {
            if (isMountedRef.current) toastRef.current.error(`创建工作区失败: ${err}`);
        } finally {
            if (isMountedRef.current) setCreatingWorkspace(false);
        }
    }, [workspaceChoice, workspaceName, selectedExistingPath, addProject, refreshConfig]);

    const handleStart = useCallback(async () => {
        if (!isTauriEnvironment()) return;

        setStarting(true);
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const pluginId = plugin.pluginId;
            const platform: ImPlatform = `openclaw:${pluginId}`;
            const pluginConfig = buildConfig();

            const newConfig: ImBotConfig = {
                id: botId,
                name: plugin.manifest?.name || pluginId,
                platform,
                botToken: '',
                allowedUsers: [],
                permissionMode: 'fullAgency',
                enabled: true,
                setupCompleted: true,
                defaultWorkspacePath: selectedExistingPath,
                openclawPluginId: pluginId,
                openclawNpmSpec: plugin.npmSpec,
                openclawPluginConfig: Object.keys(pluginConfig).length > 0 ? pluginConfig : undefined,
            };

            await invoke('cmd_add_im_bot_config', { botConfig: newConfig });
            await refreshConfig();

            const params = {
                botId,
                botToken: '',
                allowedUsers: [] as string[],
                permissionMode: 'fullAgency',
                workspacePath: selectedExistingPath,
                model: null,
                providerEnvJson: null,
                mcpServersJson: null,
                platform,
                feishuAppId: null,
                feishuAppSecret: null,
                dingtalkClientId: null,
                dingtalkClientSecret: null,
                dingtalkUseAiCard: false,
                dingtalkCardTemplateId: null,
                telegramUseDraft: false,
                heartbeatConfigJson: null,
                botName: newConfig.name,
                openclawPluginId: pluginId,
                openclawNpmSpec: plugin.npmSpec,
                openclawPluginConfig: Object.keys(pluginConfig).length > 0 ? pluginConfig : null,
            };

            await invoke<ImBotStatus>('cmd_start_im_bot', params);

            if (isMountedRef.current) {
                track('openclaw_bot_started', { pluginId });
                toastRef.current.success('Bot 启动成功！');
                onComplete(botId);
            }
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`启动失败: ${err}`);
                setStarting(false);
            }
        }
    }, [plugin, botId, buildConfig, selectedExistingPath, refreshConfig, onComplete]);

    const existingOptions = projects.map(p => ({
        value: p.path,
        label: shortenPathForDisplay(p.path),
        icon: <FolderOpen className="h-3.5 w-3.5" />,
    }));

    const promoted = findPromotedPlugin(plugin.pluginId);
    const pluginName = promoted?.name || plugin.manifest?.name || plugin.pluginId;
    const pluginDesc = promoted?.description || plugin.manifest?.description || '';
    const pluginConfig = buildConfig();
    const configCount = Object.keys(pluginConfig).length;

    // Step 1 validation: custom fields with a key must have a value;
    // schema fields only block if they are in the JSON Schema `required` array.
    const hasIncompleteFields = customFields.some(f => f.key.trim() && !f.value.trim());
    const hasIncompleteSchema = hasSchema
        && Array.from(schemaRequiredKeys).some(k => !schemaValues[k]?.trim());

    const totalSteps = 3;
    const stepLabel = step === 1 ? '配置插件' : step === 2 ? '设置工作区' : '启动 Bot';
    const platformColor = promoted?.platformColor || '#8B5CF6';

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
                <button
                    onClick={step === 1 ? onCancel : () => setStep(step - 1)}
                    className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                    <ArrowLeft className="h-4 w-4" />
                </button>
                <div>
                    <div className="flex items-center gap-2">
                        <h2 className="text-lg font-semibold text-[var(--ink)]">
                            添加 {pluginName}
                        </h2>
                        <span
                            className="rounded-full px-2 py-0.5 text-xs font-medium"
                            style={{ backgroundColor: `${platformColor}15`, color: platformColor }}
                        >
                            {pluginName}
                        </span>
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                        步骤 {step}/{totalSteps}: {stepLabel}
                    </p>
                    <div className="mt-1.5 flex gap-1">
                        {Array.from({ length: totalSteps }, (_, i) => (
                            <div
                                key={i}
                                className={`h-1 w-16 rounded-full ${step >= i + 1 ? 'bg-[var(--button-primary-bg)]' : 'bg-[var(--line)]'}`}
                            />
                        ))}
                    </div>
                </div>
            </div>

            {/* Step 1: Plugin Info + Config */}
            {step === 1 && (
                <div className="space-y-6">
                    {/* Plugin info card */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <div className="flex items-start gap-4">
                            {promoted ? (
                                <img src={promoted.icon} alt={pluginName} className="h-10 w-10 shrink-0 rounded-[var(--radius-md)]" />
                            ) : (
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--accent-warm-subtle)]">
                                    <Puzzle className="h-5 w-5 text-[var(--accent-warm)]" />
                                </div>
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-semibold text-[var(--ink)]">{pluginName}</p>
                                    {plugin.packageVersion && (
                                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink-muted)]">
                                            v{plugin.packageVersion}
                                        </span>
                                    )}
                                </div>
                                {pluginDesc && (
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">{pluginDesc}</p>
                                )}
                                {plugin.homepage && (
                                    <button
                                        className="mt-1.5 inline-flex items-center gap-1 text-xs text-[var(--accent-warm)] hover:underline"
                                        onClick={() => {
                                            if (isTauriEnvironment()) {
                                                import('@tauri-apps/plugin-shell').then(({ open }) => open(plugin.homepage!));
                                            }
                                        }}
                                    >
                                        <ExternalLink className="h-3 w-3" />
                                        项目主页
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Config section */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">
                            {promoted?.setupGuide?.credentialTitle || '插件配置'}
                        </h3>
                        <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                            {promoted?.setupGuide?.credentialHintLink ? (
                                <>
                                    前往{' '}
                                    <a
                                        href={promoted.setupGuide.credentialHintLink}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                        onClick={(e) => {
                                            if (isTauriEnvironment()) {
                                                e.preventDefault();
                                                import('@tauri-apps/plugin-shell').then(({ open }) => open(promoted!.setupGuide!.credentialHintLink!));
                                            }
                                        }}
                                    >
                                        QQ 开放平台
                                        <ExternalLink className="inline h-3 w-3" />
                                    </a>
                                    {' '}创建应用，获取 AppID 和 AppSecret
                                </>
                            ) : (
                                promoted?.setupGuide?.credentialHint || '输入插件需要的配置参数（如 appId、clientSecret 等）'
                            )}
                        </p>

                        <div className="mt-4">
                            {hasSchema ? (
                                /* Schema-driven inputs */
                                <div className="space-y-4">
                                    <SchemaConfigInputs
                                        schema={schemaProperties!}
                                        requiredKeys={schemaRequiredKeys}
                                        values={schemaValues}
                                        onChange={setSchemaValues}
                                    />
                                    {/* Extra custom fields */}
                                    <div className="border-t border-[var(--line-subtle)] pt-3">
                                        <p className="mb-2 text-xs text-[var(--ink-muted)]">自定义配置</p>
                                        <ConfigFieldEditor
                                            fields={customFields}
                                            onChange={setCustomFields}
                                        />
                                    </div>
                                </div>
                            ) : (
                                /* Key-value pair editor */
                                <ConfigFieldEditor
                                    fields={customFields}
                                    onChange={setCustomFields}
                                />
                            )}
                        </div>
                    </div>

                    {/* Step-by-step image guide (promoted plugins only) */}
                    {promoted?.setupGuide?.steps && promoted.setupGuide.steps.length > 0 && (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <p className="text-sm font-medium text-[var(--ink)]">配置指引</p>
                            {promoted.setupGuide.steps.map((guideStep, i) => {
                                const linkText = guideStep.captionLinkText;
                                const linkUrl = guideStep.captionLinkUrl;
                                const splitIdx = linkText ? guideStep.caption.indexOf(linkText) : -1;
                                return (
                                <div key={i} className={i > 0 ? 'mt-5' : 'mt-3'}>
                                    <p className="text-xs text-[var(--ink-muted)]">
                                        {splitIdx >= 0 && linkUrl ? (
                                            <>
                                                {guideStep.caption.slice(0, splitIdx)}
                                                <a
                                                    href={linkUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                                    onClick={(e) => {
                                                        if (isTauriEnvironment()) {
                                                            e.preventDefault();
                                                            import('@tauri-apps/plugin-shell').then(({ open }) => open(linkUrl));
                                                        }
                                                    }}
                                                >
                                                    {linkText}
                                                    <ExternalLink className="inline h-3 w-3" />
                                                </a>
                                                {guideStep.caption.slice(splitIdx + linkText!.length)}
                                            </>
                                        ) : guideStep.caption}
                                    </p>
                                    <img
                                        src={guideStep.image}
                                        alt={guideStep.alt}
                                        className="mt-2 w-full rounded-lg border border-[var(--line)]"
                                    />
                                </div>
                                );
                            })}
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex justify-between">
                        <button
                            onClick={onCancel}
                            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                        >
                            取消
                        </button>
                        <button
                            onClick={() => setStep(2)}
                            disabled={hasIncompleteFields || hasIncompleteSchema}
                            className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                        >
                            下一步
                            <ArrowRight className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            )}

            {/* Step 2: Workspace */}
            {step === 2 && (
                <div className="space-y-6">
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">选择 Bot 工作区</h3>
                        <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                            工作区是 Bot 的独立运行环境，包含记忆、配置和巡检清单等文件。建议每个 Bot 使用独立工作区。
                        </p>

                        <div className="mt-5 space-y-3">
                            {/* Option 1: Create new workspace */}
                            <label
                                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${
                                    workspaceChoice === 'new'
                                        ? 'border-[var(--button-primary-bg)] bg-[var(--button-primary-bg)]/5'
                                        : 'border-[var(--line)] hover:border-[var(--ink-muted)]'
                                }`}
                            >
                                <input
                                    type="radio"
                                    name="workspace-choice"
                                    checked={workspaceChoice === 'new'}
                                    onChange={() => setWorkspaceChoice('new')}
                                    className="mt-0.5 accent-[var(--button-primary-bg)]"
                                />
                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        <FolderPlus className="h-4 w-4 text-[var(--button-primary-bg)]" />
                                        <span className="text-sm font-medium text-[var(--ink)]">
                                            新建工作区 — {workspaceName}
                                        </span>
                                        <span className="rounded-full bg-[var(--button-primary-bg)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--button-primary-bg)]">
                                            推荐
                                        </span>
                                    </div>
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                        为此 Bot 创建专属工作区，拥有独立的记忆和配置
                                    </p>
                                    <p className="mt-1 font-mono text-[10px] text-[var(--ink-muted)]">
                                        ~/.myagents/projects/{workspaceName}/
                                    </p>
                                </div>
                            </label>

                            {/* Option 2: Select existing workspace */}
                            <label
                                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${
                                    workspaceChoice === 'existing'
                                        ? 'border-[var(--button-primary-bg)] bg-[var(--button-primary-bg)]/5'
                                        : 'border-[var(--line)] hover:border-[var(--ink-muted)]'
                                }`}
                            >
                                <input
                                    type="radio"
                                    name="workspace-choice"
                                    checked={workspaceChoice === 'existing'}
                                    onChange={() => setWorkspaceChoice('existing')}
                                    className="mt-0.5 accent-[var(--button-primary-bg)]"
                                />
                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        <FolderOpen className="h-4 w-4 text-[var(--ink-muted)]" />
                                        <span className="text-sm font-medium text-[var(--ink)]">
                                            选择已有工作区
                                        </span>
                                    </div>
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                        与其他 Bot 或客户端共享现有工作区
                                    </p>

                                    {workspaceChoice === 'existing' && (
                                        <div className="mt-3">
                                            <CustomSelect
                                                value={selectedExistingPath}
                                                options={existingOptions}
                                                onChange={setSelectedExistingPath}
                                                placeholder="选择工作区"
                                                triggerIcon={<FolderOpen className="h-3.5 w-3.5" />}
                                                className="w-full"
                                                footerAction={{
                                                    label: '选择文件夹...',
                                                    icon: <Plus className="h-3.5 w-3.5" />,
                                                    onClick: async () => {
                                                        if (!isTauriEnvironment()) return;
                                                        const { open } = await import('@tauri-apps/plugin-dialog');
                                                        const selected = await open({ directory: true, multiple: false, title: '选择 Bot 工作区' });
                                                        if (selected && typeof selected === 'string') {
                                                            if (!projects.find(p => p.path === selected)) {
                                                                await addProject(selected);
                                                                await refreshConfig();
                                                            }
                                                            setSelectedExistingPath(selected);
                                                        }
                                                    },
                                                }}
                                            />
                                        </div>
                                    )}
                                </div>
                            </label>
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex justify-between">
                        <button
                            onClick={() => setStep(1)}
                            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                        >
                            上一步
                        </button>
                        <button
                            onClick={handleWorkspaceNext}
                            disabled={creatingWorkspace || (workspaceChoice === 'existing' && !selectedExistingPath)}
                            className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                        >
                            {creatingWorkspace ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    创建中…
                                </>
                            ) : (
                                <>
                                    下一步
                                    <ArrowRight className="h-4 w-4" />
                                </>
                            )}
                        </button>
                    </div>
                </div>
            )}

            {/* Step 3: Summary + Start */}
            {step === 3 && (
                <div className="space-y-6">
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">确认配置</h3>
                        <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                            确认以下信息无误后启动 Bot
                        </p>

                        <div className="mt-4 space-y-3">
                            <div className="flex items-center gap-3 rounded-lg border border-[var(--line)] p-3">
                                {promoted ? (
                                    <img src={promoted.icon} alt={pluginName} className="h-8 w-8 shrink-0 rounded-[var(--radius-sm)]" />
                                ) : (
                                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent-warm-subtle)]">
                                        <Puzzle className="h-4 w-4 text-[var(--accent-warm)]" />
                                    </div>
                                )}
                                <div>
                                    <p className="text-sm font-medium text-[var(--ink)]">{pluginName}</p>
                                    {plugin.packageVersion && (
                                        <p className="text-xs text-[var(--ink-muted)]">v{plugin.packageVersion}</p>
                                    )}
                                </div>
                            </div>

                            <div className="space-y-2 rounded-lg border border-[var(--line)] p-3">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-[var(--ink-muted)]">工作区</span>
                                    <span className="text-sm text-[var(--ink)]">
                                        {shortenPathForDisplay(selectedExistingPath)}
                                    </span>
                                </div>
                                {configCount > 0 && (
                                    <div className="flex items-center justify-between border-t border-[var(--line-subtle)] pt-2">
                                        <span className="text-xs text-[var(--ink-muted)]">配置项</span>
                                        <span className="text-sm text-[var(--ink)]">{configCount} 个</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex justify-between">
                        <button
                            onClick={() => setStep(2)}
                            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                        >
                            上一步
                        </button>
                        <button
                            onClick={handleStart}
                            disabled={starting}
                            className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                        >
                            {starting ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    启动中…
                                </>
                            ) : (
                                <>
                                    启动 Bot
                                    <Check className="h-4 w-4" />
                                </>
                            )}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
