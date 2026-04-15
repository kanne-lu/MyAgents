/**
 * ContextUsageOverlay — 展示 SDK 0.2.86+ `query.getContextUsage()` 的分类明细。
 *
 * 数据来源：GET /api/session/context-usage（Tab-scoped，打到当前 Sidecar）
 *
 * 适用场景：
 * - 用户点击 Chat 顶栏"上下文"按钮 → 手动查看当前会话的 context 占用明细
 * - 自动刷新：依赖调用方传入的 `refreshKey`（例如挂到 turn-end 事件）
 *
 * 数据模型说明：
 * SDK 返回的 `SDKControlGetContextUsageResponse` 提供 `categories[]`（主展示维度）
 * + 若干辅助分组（messageBreakdown / skills / agents / memoryFiles / mcpTools / ...）。
 * 本组件仅依赖 `categories` + `totalTokens` + `maxTokens`，其他字段按存在性渲染，
 * 避免硬编码具体 category 名称（PRD §7 要求：前端不硬编码分类名）。
 */
import { Loader2, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useTabState } from '@/context/TabContext';
import { formatTokens } from '@/utils/formatTokens';

interface ContextUsageCategory {
  name: string;
  tokens: number;
  color: string;
  isDeferred?: boolean;
}

interface ContextUsageResponse {
  categories: ContextUsageCategory[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens?: number;
  percentage: number;
  model?: string;
  isAutoCompactEnabled?: boolean;
  autoCompactThreshold?: number;
  memoryFiles?: { path: string; type: string; tokens: number }[];
  mcpTools?: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[];
  systemTools?: { name: string; tokens: number }[];
  systemPromptSections?: { name: string; tokens: number }[];
  agents?: { agentType: string; source: string; tokens: number }[];
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: { name: string; source: string; tokens: number }[];
  };
}

interface FetchPayload {
  success: boolean;
  usage?: ContextUsageResponse;
  error?: string;
  reason?: 'external_runtime' | 'no_session';
}

interface ContextUsageOverlayProps {
  onClose: () => void;
}

export default function ContextUsageOverlay({ onClose }: ContextUsageOverlayProps) {
  useCloseLayer(() => { onClose(); return true; }, 200);

  const { apiGet, sessionId } = useTabState();
  const [usage, setUsage] = useState<ContextUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  // Unmount guard — prevent setState on unmounted component when the overlay is
  // closed mid-request (SDK getContextUsage is not instant, especially under
  // prompt_too_long pressure where this overlay is most valuable).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!isMountedRef.current) return;
    setLoading(true);
    setErrorMsg(null);
    setReason(null);
    try {
      const resp = await apiGet<FetchPayload>('/api/session/context-usage');
      if (!isMountedRef.current) return;
      if (resp?.success && resp.usage) {
        setUsage(resp.usage);
      } else {
        setUsage(null);
        setReason(resp?.reason ?? null);
        setErrorMsg(resp?.error ?? '无法获取上下文用量');
      }
    } catch (e) {
      if (!isMountedRef.current) return;
      setUsage(null);
      setErrorMsg(e instanceof Error ? e.message : '网络错误');
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [apiGet]);

  // Reload when session switches (user can fork/load another session while the
  // overlay is open — stale data would otherwise silently belong to the prior
  // session). `sessionId` is the Tab's current session ID from TabContext.
  useEffect(() => {
    load();
  }, [load, sessionId]);

  const categoriesSorted = useMemo(() => {
    if (!usage?.categories) return [];
    return [...usage.categories].sort((a, b) => b.tokens - a.tokens);
  }, [usage]);

  const totalTokens = usage?.totalTokens ?? 0;
  const maxTokens = usage?.maxTokens ?? 0;
  const percentage = usage?.percentage ?? (maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0);
  const percentageLabel = Number.isFinite(percentage) ? percentage.toFixed(1) : '0.0';

  return (
    <OverlayBackdrop onClose={onClose} className="z-[200]" style={{ padding: '4vh 4vw' }}>
      <div className="glass-panel flex max-h-full w-full max-w-xl select-text flex-col overflow-hidden">
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-[var(--ink)]">
              上下文用量（当前会话）
            </div>
            <div className="truncate text-[11px] text-[var(--ink-muted)]">
              {usage?.model ? `模型 ${usage.model}` : 'SDK 实时数据'}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-50"
              title="刷新"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading && !usage ? (
            <div className="flex h-32 items-center justify-center gap-2 text-[var(--ink-muted)]">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">加载中...</span>
            </div>
          ) : !usage ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-center text-sm text-[var(--ink-muted)]">
              <div>{errorMsg ?? '暂无数据'}</div>
              {reason === 'external_runtime' && (
                <div className="text-xs">
                  外部 Runtime（Claude Code CLI / Codex / Gemini）不支持此视图
                </div>
              )}
              {reason === 'no_session' && (
                <div className="text-xs">请先发送一条消息以激活会话</div>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              {/* Total summary */}
              <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-[var(--ink-muted)]">总占用</span>
                  <span className="text-xs text-[var(--ink-muted)]">
                    {formatTokens(totalTokens)} / {formatTokens(maxTokens)} tokens
                  </span>
                </div>
                <div className="mt-2 text-2xl font-semibold text-[var(--ink)]">
                  {percentageLabel}%
                </div>
                {/* Stacked bar */}
                <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-[var(--paper-inset)]">
                  {categoriesSorted.map((cat) => {
                    const widthPct = maxTokens > 0 ? (cat.tokens / maxTokens) * 100 : 0;
                    if (widthPct <= 0) return null;
                    return (
                      <div
                        key={cat.name}
                        style={{
                          width: `${widthPct}%`,
                          backgroundColor: cat.color || 'var(--accent-warm)',
                          opacity: cat.isDeferred ? 0.5 : 1,
                        }}
                        title={`${cat.name}: ${formatTokens(cat.tokens)} (${widthPct.toFixed(1)}%)`}
                      />
                    );
                  })}
                </div>
                {usage.isAutoCompactEnabled && usage.autoCompactThreshold != null && (
                  <div className="mt-2 text-[11px] text-[var(--ink-muted)]">
                    自动压缩阈值：{(usage.autoCompactThreshold * 100).toFixed(0)}%
                  </div>
                )}
              </div>

              {/* Categories list */}
              <div>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                  分类明细
                </h3>
                <div className="space-y-1.5">
                  {categoriesSorted.map((cat) => {
                    const pct = maxTokens > 0 ? (cat.tokens / maxTokens) * 100 : 0;
                    return (
                      <div
                        key={cat.name}
                        className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-[var(--hover-bg)]"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                            style={{
                              backgroundColor: cat.color || 'var(--accent-warm)',
                              opacity: cat.isDeferred ? 0.5 : 1,
                            }}
                          />
                          <span className="truncate text-sm text-[var(--ink)]">
                            {cat.name}
                            {cat.isDeferred && (
                              <span className="ml-1 text-[10px] text-[var(--ink-subtle)]">(deferred)</span>
                            )}
                          </span>
                        </div>
                        <div className="flex-shrink-0 text-right">
                          <div className="text-sm font-medium text-[var(--ink)]">
                            {formatTokens(cat.tokens)}
                          </div>
                          <div className="text-[10px] text-[var(--ink-muted)]">
                            {pct.toFixed(1)}%
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Skills summary (SDK optional) */}
              {usage.skills && usage.skills.totalSkills > 0 && (
                <div>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                    技能（{usage.skills.includedSkills}/{usage.skills.totalSkills}）
                  </h3>
                  <div className="text-xs text-[var(--ink-muted)]">
                    共 {formatTokens(usage.skills.tokens)} tokens
                  </div>
                </div>
              )}

              {/* Agents summary */}
              {usage.agents && usage.agents.length > 0 && (
                <div>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                    子 Agent 定义（{usage.agents.length}）
                  </h3>
                  <div className="space-y-1 text-xs text-[var(--ink-muted)]">
                    {usage.agents.map((a) => (
                      <div key={`${a.agentType}-${a.source}`} className="flex justify-between">
                        <span className="truncate">
                          {a.agentType}
                          <span className="ml-1 text-[var(--ink-subtle)]">({a.source})</span>
                        </span>
                        <span>{formatTokens(a.tokens)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* MCP tools summary */}
              {usage.mcpTools && usage.mcpTools.length > 0 && (
                <div>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                    MCP 工具（{usage.mcpTools.length}）
                  </h3>
                  <div className="max-h-40 space-y-1 overflow-y-auto text-xs text-[var(--ink-muted)]">
                    {usage.mcpTools.map((t) => (
                      <div key={`${t.serverName}.${t.name}`} className="flex justify-between">
                        <span className="truncate">
                          {t.serverName}<span className="text-[var(--ink-subtle)]">.</span>{t.name}
                        </span>
                        <span>{formatTokens(t.tokens)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Memory files */}
              {usage.memoryFiles && usage.memoryFiles.length > 0 && (
                <div>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                    记忆文件（{usage.memoryFiles.length}）
                  </h3>
                  <div className="space-y-1 text-xs text-[var(--ink-muted)]">
                    {usage.memoryFiles.map((f) => (
                      <div key={f.path} className="flex justify-between">
                        <span className="truncate" title={f.path}>{f.path}</span>
                        <span>{formatTokens(f.tokens)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-shrink-0 justify-end border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--line-strong)] bg-[var(--button-secondary-bg)] px-4 py-2 text-sm font-medium text-[var(--ink)] hover:bg-[var(--button-secondary-bg-hover)]"
          >
            关闭
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
