/**
 * ModelManagementPanel - Unified overlay for managing provider models
 *
 * Upper section: Active models with primary model selection, delete, add custom ID
 * Lower section: Discover more models from provider API
 */
import { X, Search, Loader2, RefreshCw, Image, Video, Brain, AlertCircle, Check, Plus, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import { PRESET_PROVIDERS, type Provider, type ModelEntity, type AppConfig } from '@/config/types';
import {
  fetchProviderModels,
  toModelEntity,
  formatTokenCount,
  supportsModelDiscovery,
  type DiscoveredModel,
} from '@/config/services/modelDiscoveryService';

interface ModelManagementPanelProps {
  provider: Provider;
  apiKey: string | undefined;
  config: AppConfig;
  onClose: () => void;
  onSaveCustomModels: (providerId: string, models: ModelEntity[]) => Promise<void>;
  onUpdateCustomProvider?: (provider: Provider) => Promise<void>;
  onSetPrimaryModel: (providerId: string, modelId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export default function ModelManagementPanel({
  provider,
  apiKey,
  config,
  onClose,
  onSaveCustomModels,
  onUpdateCustomProvider,
  onSetPrimaryModel,
  onRefresh,
}: ModelManagementPanelProps) {
  // ===== Discovery state =====
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [selectedToAdd, setSelectedToAdd] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [customInput, setCustomInput] = useState('');
  const isMountedRef = useRef(true);
  const fetchIdRef = useRef(0);

  // provider.primaryModel is already resolved by ConfigProvider (user override applied)
  const primaryModel = provider.primaryModel;

  // Preset model IDs (cannot be deleted)
  const presetModelIds = useMemo(() => {
    if (!provider.isBuiltin) return new Set<string>();
    const preset = PRESET_PROVIDERS.find(p => p.id === provider.id);
    return new Set(preset?.models.map(m => m.model) ?? []);
  }, [provider.id, provider.isBuiltin]);

  // Active model IDs set (for discovery section "already added" check)
  const activeModelIds = useMemo(
    () => new Set(provider.models.map(m => m.model)),
    [provider.models],
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Prevent background scroll
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useCloseLayer(() => { onClose(); return true; }, 200);

  // ===== Discovery fetch =====
  const canDiscover = !!apiKey && supportsModelDiscovery(provider);

  const doFetch = useCallback(async () => {
    if (!apiKey || !supportsModelDiscovery(provider)) return;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    const thisId = ++fetchIdRef.current;
    try {
      const result = await fetchProviderModels(provider, apiKey);
      if (!isMountedRef.current || thisId !== fetchIdRef.current) return;
      setDiscoveredModels(result);
    } catch (e) {
      if (!isMountedRef.current || thisId !== fetchIdRef.current) return;
      setDiscoveryError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isMountedRef.current && thisId === fetchIdRef.current) {
        setDiscoveryLoading(false);
      }
    }
  }, [provider, apiKey]);

  useEffect(() => { doFetch(); }, [doFetch]);

  // ===== Actions =====
  const handleSetPrimary = useCallback(async (modelId: string) => {
    await onSetPrimaryModel(provider.id, modelId);
    await onRefresh();
  }, [provider.id, onSetPrimaryModel, onRefresh]);

  const handleDeleteModel = useCallback(async (modelId: string) => {
    if (provider.isBuiltin) {
      // Remove from presetCustomModels
      const existing = config.presetCustomModels?.[provider.id] ?? [];
      const updated = existing.filter(m => m.model !== modelId);
      await onSaveCustomModels(provider.id, updated);
    } else if (onUpdateCustomProvider) {
      // Remove from custom provider models
      const updatedModels = provider.models.filter(m => m.model !== modelId);
      await onUpdateCustomProvider({ ...provider, models: updatedModels });
    }
    // If deleted model was primary, auto-switch
    if (modelId === primaryModel) {
      const remaining = provider.models.filter(m => m.model !== modelId);
      if (remaining.length > 0) {
        await onSetPrimaryModel(provider.id, remaining[0].model);
      }
    }
    await onRefresh();
  }, [provider, config.presetCustomModels, primaryModel, onSaveCustomModels, onUpdateCustomProvider, onSetPrimaryModel, onRefresh]);

  const handleAddCustomModel = useCallback(async () => {
    const id = customInput.trim();
    if (!id) return;
    if (activeModelIds.has(id)) return;

    const entity: ModelEntity = {
      model: id,
      modelName: id,
      modelSeries: provider.vendor.toLowerCase(),
      source: 'manual',
    };

    if (provider.isBuiltin) {
      const existing = config.presetCustomModels?.[provider.id] ?? [];
      await onSaveCustomModels(provider.id, [...existing, entity]);
    } else if (onUpdateCustomProvider) {
      await onUpdateCustomProvider({ ...provider, models: [...provider.models, entity] });
    }
    setCustomInput('');
    await onRefresh();
  }, [customInput, activeModelIds, provider, config.presetCustomModels, onSaveCustomModels, onUpdateCustomProvider, onRefresh]);

  const handleAddDiscovered = useCallback(async () => {
    const toAdd = discoveredModels
      .filter(m => selectedToAdd.has(m.id) && !activeModelIds.has(m.id))
      .map(m => toModelEntity(m, provider));
    if (toAdd.length === 0) return;

    if (provider.isBuiltin) {
      const existing = config.presetCustomModels?.[provider.id] ?? [];
      await onSaveCustomModels(provider.id, [...existing, ...toAdd]);
    } else if (onUpdateCustomProvider) {
      await onUpdateCustomProvider({ ...provider, models: [...provider.models, ...toAdd] });
    }
    setSelectedToAdd(new Set());
    await onRefresh();
  }, [discoveredModels, selectedToAdd, activeModelIds, provider, config.presetCustomModels, onSaveCustomModels, onUpdateCustomProvider, onRefresh]);

  const toggleSelectDiscovered = useCallback((id: string) => {
    setSelectedToAdd(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ===== Filtered discovery models =====
  const filteredDiscovered = useMemo(() => {
    if (!search.trim()) return discoveredModels;
    const q = search.toLowerCase();
    return discoveredModels.filter(m =>
      m.id.toLowerCase().includes(q) ||
      m.displayName?.toLowerCase().includes(q) ||
      m.ownedBy?.toLowerCase().includes(q)
    );
  }, [discoveredModels, search]);

  const addableCount = [...selectedToAdd].filter(id => !activeModelIds.has(id)).length;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative flex h-[85vh] w-[620px] max-w-[90vw] flex-col overflow-hidden rounded-2xl bg-[var(--paper-elevated)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--ink)]">
              管理可用模型
              <span className="ml-2 text-sm font-normal text-[var(--ink-muted)]">{provider.name}</span>
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* ===== Upper: Active Models ===== */}
          <div className="border-b border-[var(--line-subtle)] px-5 py-4">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              可用模型
            </h3>

            {provider.models.length === 0 ? (
              <p className="py-4 text-center text-sm text-[var(--ink-muted)]">暂无模型，请在下方发现或手动添加</p>
            ) : (
              <div className="space-y-1">
                {provider.models.map(model => (
                  <ActiveModelRow
                    key={model.model}
                    model={model}
                    isPrimary={model.model === primaryModel}
                    isPreset={presetModelIds.has(model.model)}
                    onSetPrimary={handleSetPrimary}
                    onDelete={handleDeleteModel}
                  />
                ))}
              </div>
            )}

            {/* Add custom model input */}
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCustomModel(); } }}
                placeholder="输入模型 ID，按 Enter 添加"
                className="flex-1 rounded-lg border border-[var(--line)] bg-transparent px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--ink-muted)] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddCustomModel}
                disabled={!customInput.trim() || activeModelIds.has(customInput.trim())}
                className="rounded-lg bg-[var(--paper-inset)] px-2.5 py-1.5 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)] disabled:opacity-40"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* ===== Lower: Discover Models ===== */}
          <div className="px-5 py-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                发现更多模型
              </h3>
              {canDiscover && !discoveryLoading && discoveredModels.length > 0 && (
                <button
                  type="button"
                  onClick={doFetch}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                  <RefreshCw className="h-3 w-3" />
                  刷新
                </button>
              )}
            </div>

            {/* Search (only when models loaded) */}
            {canDiscover && !discoveryLoading && !discoveryError && discoveredModels.length > 0 && (
              <div className="relative mb-3">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-subtle)]" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索模型..."
                  className="w-full rounded-lg border border-[var(--line)] bg-transparent py-1.5 pl-8 pr-3 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--ink-muted)] focus:outline-none"
                />
              </div>
            )}

            {/* Discovery content */}
            {!canDiscover && !apiKey && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">请先配置 API Key</p>
            )}
            {!canDiscover && apiKey && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">当前供应商不支持发现模型</p>
            )}

            {canDiscover && discoveryLoading && (
              <div className="flex flex-col items-center justify-center py-8 text-[var(--ink-muted)]">
                <Loader2 className="h-5 w-5 animate-spin" />
                <p className="mt-2 text-sm">正在拉取模型列表...</p>
              </div>
            )}

            {canDiscover && discoveryError && (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <AlertCircle className="h-5 w-5 text-[var(--error)]" />
                <p className="mt-2 text-sm text-[var(--ink)]">无法拉取模型列表</p>
                <p className="mt-1 max-w-md text-xs text-[var(--ink-muted)]">{discoveryError}</p>
                <button
                  type="button"
                  onClick={doFetch}
                  className="mt-3 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  重试
                </button>
              </div>
            )}

            {canDiscover && !discoveryLoading && !discoveryError && discoveredModels.length === 0 && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">该供应商未返回可用模型</p>
            )}

            {canDiscover && !discoveryLoading && !discoveryError && filteredDiscovered.length > 0 && (
              <div className="space-y-1.5">
                {filteredDiscovered.map(m => (
                  <DiscoveredModelCard
                    key={m.id}
                    model={m}
                    isAdded={activeModelIds.has(m.id)}
                    isSelected={selectedToAdd.has(m.id)}
                    onToggle={toggleSelectDiscovered}
                  />
                ))}
              </div>
            )}

            {canDiscover && !discoveryLoading && !discoveryError && filteredDiscovered.length === 0 && discoveredModels.length > 0 && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">
                {search ? '没有匹配的模型' : '所有可用模型已在上方列表中'}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-shrink-0 items-center justify-end gap-3 border-t border-[var(--line)] px-5 py-3">
          {addableCount > 0 && (
            <button
              type="button"
              onClick={handleAddDiscovered}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--accent-warm-hover)]"
            >
              添加 {addableCount} 个模型
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ===== ActiveModelRow (upper section) =====

const ActiveModelRow = React.memo(function ActiveModelRow({
  model,
  isPrimary,
  isPreset,
  onSetPrimary,
  onDelete,
}: {
  model: ModelEntity;
  isPrimary: boolean;
  isPreset: boolean;
  onSetPrimary: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const handleRadio = useCallback(() => { if (!isPrimary) onSetPrimary(model.model); }, [isPrimary, onSetPrimary, model.model]);
  const handleDelete = useCallback(() => onDelete(model.model), [onDelete, model.model]);

  return (
    <div className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--hover-bg)] ${isPrimary ? 'bg-[var(--accent-warm-subtle)]' : ''}`}>
      {/* Radio */}
      <button type="button" onClick={handleRadio} className="flex-shrink-0">
        <div className={`flex h-4 w-4 items-center justify-center rounded-full border-2 transition-colors ${
          isPrimary ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--line-strong)]'
        }`}>
          {isPrimary && <div className="h-1.5 w-1.5 rounded-full bg-[var(--button-primary-text)]" />}
        </div>
      </button>

      {/* Model info */}
      <div className="min-w-0 flex-1">
        <span className="truncate font-mono text-[13px] text-[var(--ink)]">{model.model}</span>
        {model.modelName && model.modelName !== model.model && (
          <span className="ml-2 text-xs text-[var(--ink-muted)]">{model.modelName}</span>
        )}
      </div>

      {/* Metadata tags */}
      {model.contextLength && (
        <span className="flex-shrink-0 text-[10px] text-[var(--ink-subtle)]">
          {formatTokenCount(model.contextLength)}
        </span>
      )}

      {/* Badges */}
      {isPrimary && (
        <span className="flex-shrink-0 rounded bg-[var(--accent-warm-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
          首选
        </span>
      )}
      {isPreset && (
        <span className="flex-shrink-0 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] text-[var(--ink-subtle)]">
          预设
        </span>
      )}

      {/* Delete button (only for non-preset) */}
      {!isPreset ? (
        <button
          type="button"
          onClick={handleDelete}
          className="flex-shrink-0 rounded p-1 text-[var(--ink-subtle)] opacity-0 transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--error)] group-hover:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      ) : (
        // Spacer to keep alignment when no delete button
        <div className="w-5 flex-shrink-0" />
      )}
    </div>
  );
});

// ===== DiscoveredModelCard (lower section) =====

const DiscoveredModelCard = React.memo(function DiscoveredModelCard({
  model,
  isAdded,
  isSelected,
  onToggle,
}: {
  model: DiscoveredModel;
  isAdded: boolean;
  isSelected: boolean;
  onToggle: (id: string) => void;
}) {
  const handleClick = useCallback(() => { if (!isAdded) onToggle(model.id); }, [isAdded, onToggle, model.id]);

  const tags: { label: string; icon?: React.ReactNode }[] = [];
  if (model.contextLength) tags.push({ label: `${formatTokenCount(model.contextLength)}` });
  if (model.maxOutputTokens) tags.push({ label: `输出 ${formatTokenCount(model.maxOutputTokens)}` });
  if (model.supportsImage) tags.push({ label: '图片', icon: <Image className="h-3 w-3" /> });
  if (model.supportsVideo) tags.push({ label: '视频', icon: <Video className="h-3 w-3" /> });
  if (model.supportsReasoning) tags.push({ label: '推理', icon: <Brain className="h-3 w-3" /> });

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isAdded}
      className={`group w-full rounded-lg border p-3 text-left transition-all ${
        isAdded
          ? 'cursor-default border-[var(--line-subtle)] opacity-50'
          : isSelected
            ? 'border-[var(--accent)] bg-[var(--accent-warm-subtle)]'
            : 'border-[var(--line)] hover:border-[var(--line-strong)]'
      }`}
    >
      <div className="flex items-start gap-2.5">
        {/* Checkbox */}
        <div className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors ${
          isAdded
            ? 'border-[var(--success)] bg-[var(--success-bg)]'
            : isSelected
              ? 'border-[var(--accent)] bg-[var(--accent)]'
              : 'border-[var(--line-strong)]'
        }`}>
          {(isAdded || isSelected) && (
            <Check className={`h-3 w-3 ${isAdded ? 'text-[var(--success)]' : 'text-[var(--button-primary-text)]'}`} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-mono text-[13px] font-medium text-[var(--ink)]">{model.id}</span>
            {model.ownedBy && <span className="flex-shrink-0 text-[11px] text-[var(--ink-subtle)]">{model.ownedBy}</span>}
          </div>
          {model.displayName && model.displayName !== model.id && (
            <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">{model.displayName}</p>
          )}
          {tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {tags.map((tag, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md bg-[var(--paper-inset)] px-1.5 py-0.5 text-[11px] text-[var(--ink-muted)]">
                  {tag.icon}{tag.label}
                </span>
              ))}
            </div>
          )}
          {isAdded && <p className="mt-1 text-[11px] text-[var(--success)]">已添加</p>}
        </div>
      </div>
    </button>
  );
});
