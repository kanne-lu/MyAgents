/**
 * ModelDiscoveryPanel - Overlay panel for discovering and selecting models from provider APIs
 */
import { X, Search, Loader2, RefreshCw, Image, Video, Brain, AlertCircle, Check } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import type { Provider, ModelEntity } from '@/config/types';
import {
  fetchProviderModels,
  toModelEntity,
  formatTokenCount,
  type DiscoveredModel,
} from '@/config/services/modelDiscoveryService';

interface ModelDiscoveryPanelProps {
  provider: Provider;
  apiKey: string;
  existingModelIds: Set<string>;
  onConfirm: (models: ModelEntity[]) => void;
  onClose: () => void;
}

export default function ModelDiscoveryPanel({
  provider,
  apiKey,
  existingModelIds,
  onConfirm,
  onClose,
}: ModelDiscoveryPanelProps) {
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const isMountedRef = useRef(true);
  const fetchIdRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const doFetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    const thisId = ++fetchIdRef.current;
    try {
      const result = await fetchProviderModels(provider, apiKey);
      if (!isMountedRef.current || thisId !== fetchIdRef.current) return;
      setModels(result);
    } catch (e) {
      if (!isMountedRef.current || thisId !== fetchIdRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isMountedRef.current && thisId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [provider, apiKey]);

  useEffect(() => { doFetch(); }, [doFetch]);

  // Prevent background scroll (restore previous value)
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Unified close layer (Escape + Cmd+W integration)
  useCloseLayer(() => { onClose(); return true; }, 200);

  const filtered = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    return models.filter(m =>
      m.id.toLowerCase().includes(q) ||
      m.displayName?.toLowerCase().includes(q) ||
      m.ownedBy?.toLowerCase().includes(q)
    );
  }, [models, search]);

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    const selectedModels = models
      .filter(m => selected.has(m.id))
      .map(m => toModelEntity(m, provider));
    onConfirm(selectedModels);
  }, [models, selected, provider, onConfirm]);

  const selectedCount = selected.size;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative flex h-[80vh] w-[600px] max-w-[90vw] flex-col overflow-hidden rounded-2xl bg-[var(--paper-elevated)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--ink)]">
              发现模型
              <span className="ml-2 text-sm font-normal text-[var(--ink-muted)]">
                {provider.name}
              </span>
            </h2>
            {!loading && !error && (
              <p className="mt-0.5 text-xs text-[var(--ink-subtle)]">
                找到 {models.length} 个可用模型
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        {!loading && !error && models.length > 0 && (
          <div className="flex-shrink-0 border-b border-[var(--line-subtle)] px-5 py-2.5">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-subtle)]" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索模型..."
                className="w-full rounded-lg border border-[var(--line)] bg-transparent py-1.5 pl-8 pr-3 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--ink-muted)] focus:outline-none"
              />
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 text-[var(--ink-muted)]">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="mt-3 text-sm">正在拉取模型列表...</p>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <AlertCircle className="h-6 w-6 text-[var(--error)]" />
              <p className="mt-3 text-sm text-[var(--ink)]">无法拉取模型列表</p>
              <p className="mt-1 max-w-md text-xs text-[var(--ink-muted)]">{error}</p>
              <button
                type="button"
                onClick={doFetch}
                className="mt-4 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                重试
              </button>
            </div>
          )}

          {!loading && !error && models.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-[var(--ink-muted)]">
              <p className="text-sm">该供应商未返回任何模型</p>
            </div>
          )}

          {!loading && !error && filtered.length > 0 && (
            <div className="space-y-2">
              {filtered.map(m => {
                const isExisting = existingModelIds.has(m.id);
                const isSelected = selected.has(m.id);
                return (
                  <ModelCard
                    key={m.id}
                    model={m}
                    isExisting={isExisting}
                    isSelected={isSelected}
                    onToggle={toggleSelect}
                  />
                );
              })}
            </div>
          )}

          {!loading && !error && filtered.length === 0 && models.length > 0 && (
            <div className="flex items-center justify-center py-12 text-sm text-[var(--ink-muted)]">
              没有匹配的模型
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-shrink-0 items-center justify-end gap-3 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={selectedCount === 0}
            className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {selectedCount > 0 ? `添加 ${selectedCount} 个模型` : '添加模型'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============= ModelCard (memoized for 350+ model lists) =============

const ModelCard = React.memo(function ModelCard({
  model,
  isExisting,
  isSelected,
  onToggle,
}: {
  model: DiscoveredModel;
  isExisting: boolean;
  isSelected: boolean;
  onToggle: (id: string) => void;
}) {
  const title = model.displayName ?? model.id;
  const showTitle = model.displayName && model.displayName !== model.id;

  const tags: { label: string; icon?: React.ReactNode }[] = [];
  if (model.contextLength) {
    tags.push({ label: `上下文 ${formatTokenCount(model.contextLength)}` });
  }
  if (model.maxOutputTokens) {
    tags.push({ label: `输出 ${formatTokenCount(model.maxOutputTokens)}` });
  }
  if (model.supportsImage) tags.push({ label: '图片', icon: <Image className="h-3 w-3" /> });
  if (model.supportsVideo) tags.push({ label: '视频', icon: <Video className="h-3 w-3" /> });
  if (model.supportsReasoning) tags.push({ label: '推理', icon: <Brain className="h-3 w-3" /> });

  const handleClick = useCallback(() => {
    if (!isExisting) onToggle(model.id);
  }, [isExisting, onToggle, model.id]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isExisting}
      className={`group w-full rounded-xl border p-3.5 text-left transition-all ${
        isExisting
          ? 'cursor-default border-[var(--line-subtle)] opacity-60'
          : isSelected
            ? 'border-[var(--accent)] bg-[var(--accent-warm-subtle)]'
            : 'border-[var(--line)] hover:border-[var(--line-strong)] hover:shadow-sm'
      }`}
    >
      {/* Row 1: checkbox + id + ownedBy */}
      <div className="flex items-start gap-2.5">
        {/* Checkbox */}
        <div className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors ${
          isExisting
            ? 'border-[var(--success)] bg-[var(--success-bg)]'
            : isSelected
              ? 'border-[var(--accent)] bg-[var(--accent)]'
              : 'border-[var(--line-strong)] group-hover:border-[var(--ink-muted)]'
        }`}>
          {(isExisting || isSelected) && (
            <Check className={`h-3 w-3 ${isExisting ? 'text-[var(--success)]' : 'text-[var(--button-primary-text)]'}`} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          {/* Model ID (always shown as monospace) */}
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-mono text-[13px] font-medium text-[var(--ink)]">
              {model.id}
            </span>
            {model.ownedBy && (
              <span className="flex-shrink-0 text-[11px] text-[var(--ink-subtle)]">
                {model.ownedBy}
              </span>
            )}
          </div>

          {/* Display name (if different from ID) */}
          {showTitle && (
            <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">{title}</p>
          )}

          {/* Tags row */}
          {tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {tags.map((tag, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-md bg-[var(--paper-inset)] px-1.5 py-0.5 text-[11px] text-[var(--ink-muted)]"
                >
                  {tag.icon}
                  {tag.label}
                </span>
              ))}
            </div>
          )}

          {/* Existing marker */}
          {isExisting && (
            <p className="mt-1 text-[11px] text-[var(--success)]">已添加</p>
          )}
        </div>
      </div>
    </button>
  );
});
