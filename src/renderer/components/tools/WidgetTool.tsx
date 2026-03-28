/**
 * WidgetTool — Entry component for Generative UI show_widget tool calls.
 *
 * Renders as an inline widget card in the message flow:
 * - Header with icon + title
 * - WidgetRenderer iframe (streaming preview → finalized interactive content)
 * - Shimmer overlay during streaming
 */

import { useMemo } from 'react';
import { Sparkles, BarChart3, GitFork, Calculator, Loader2 } from 'lucide-react';
import type { ToolUseSimple } from '@/types/chat';
import { unwrapMcpResult } from './utils';
import WidgetRenderer from './WidgetRenderer';

interface WidgetToolProps {
  tool: ToolUseSimple;
}

/** Convert snake_case title to human-readable Title Case */
function formatTitle(title: string): string {
  return title
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Pick icon based on title keywords */
function pickIcon(title: string) {
  const t = title.toLowerCase();
  if (t.includes('chart') || t.includes('graph') || t.includes('trend') || t.includes('plot')) {
    return <BarChart3 className="h-3.5 w-3.5" />;
  }
  if (t.includes('flow') || t.includes('arch') || t.includes('diagram') || t.includes('tree')) {
    return <GitFork className="h-3.5 w-3.5" />;
  }
  if (t.includes('calc') || t.includes('convert') || t.includes('tool')) {
    return <Calculator className="h-3.5 w-3.5" />;
  }
  return <Sparkles className="h-3.5 w-3.5" />;
}

export default function WidgetTool({ tool }: WidgetToolProps) {
  const parsedInput = tool.parsedInput as { title?: string; widget_code?: string } | undefined;
  const title = parsedInput?.title ?? 'widget';
  const widgetCode = parsedInput?.widget_code ?? '';
  const isStreaming = !!(tool.isLoading && !tool.result);
  const isError = tool.result?.startsWith('Error') || false;

  // Check error from result
  const errorMessage = useMemo(() => {
    if (!tool.result) return null;
    const unwrapped = unwrapMcpResult(tool.result);
    if (unwrapped.startsWith('Error')) return unwrapped;
    return null;
  }, [tool.result]);

  const displayTitle = formatTitle(title);
  const icon = pickIcon(title);

  // DEBUG: trace streaming data flow
  if (tool.name === 'mcp__generative-ui__show_widget') {
    const inputJsonLen = tool.inputJson?.length ?? 0;
    const parsedKeys = tool.parsedInput ? Object.keys(tool.parsedInput as unknown as Record<string, unknown>) : [];
    console.log(`[WidgetTool] render: isLoading=${tool.isLoading}, hasResult=${!!tool.result}, inputJsonLen=${inputJsonLen}, parsedKeys=[${parsedKeys}], widgetCodeLen=${widgetCode.length}, isStreaming=${isStreaming}`);
  }

  // No widget_code yet — show skeleton
  if (!widgetCode && isStreaming) {
    return (
      <div className="my-1.5 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)]">
        <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-3 py-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--ink-muted)]" />
          <span className="text-[13px] font-medium text-[var(--ink-muted)]">
            {displayTitle}
          </span>
          <span className="text-[11px] text-[var(--ink-subtle)]">生成中...</span>
        </div>
        <div className="flex h-[120px] items-center justify-center">
          <div className="h-2 w-32 animate-pulse rounded-full bg-[var(--paper-inset)]" />
        </div>
      </div>
    );
  }

  // Error state
  if (isError || errorMessage) {
    return (
      <div className="my-1.5 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--error)]/20 bg-[var(--error-bg)]">
        <div className="flex items-center gap-2 px-3 py-2">
          <Sparkles className="h-3.5 w-3.5 text-[var(--error)]" />
          <span className="text-[13px] font-medium text-[var(--error)]">
            Widget 渲染失败
          </span>
        </div>
        {errorMessage && (
          <p className="px-3 pb-2 text-[12px] text-[var(--ink-muted)]">{errorMessage}</p>
        )}
      </div>
    );
  }

  // Normal render — has widget_code
  return (
    <div className="my-1.5">
      {/* Header */}
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[var(--accent)]">{icon}</span>
        <span className="text-[13px] font-medium text-[var(--ink-muted)]">
          {displayTitle}
        </span>
        {isStreaming && (
          <Loader2 className="h-3 w-3 animate-spin text-[var(--ink-subtle)]" />
        )}
      </div>
      {/* Widget iframe */}
      <WidgetRenderer
        widgetCode={widgetCode}
        isStreaming={isStreaming}
        title={displayTitle}
      />
    </div>
  );
}
