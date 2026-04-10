
import type { BashInput, ToolUseSimple } from '@/types/chat';

import { AlertCircle, Loader2 } from 'lucide-react';
import { ExpandableResult } from './utils';

/** Try to parse SDK bash result JSON: {"stdout":"...","stderr":"...","interrupted":false} */
function parseBashResult(result: string): { stdout: string; stderr: string } | null {
  try {
    const parsed = JSON.parse(result);
    if (typeof parsed === 'object' && parsed !== null && ('stdout' in parsed || 'stderr' in parsed)) {
      return {
        stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
        stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
      };
    }
  } catch { /* not JSON, fall through */ }
  return null;
}

type BashDisplayInput = BashInput & {
  cwd?: string;
  commandActions?: unknown[];
};

function parseBashInput(tool: ToolUseSimple): BashDisplayInput | null {
  if (tool.parsedInput && typeof tool.parsedInput === 'object') {
    return tool.parsedInput as BashDisplayInput;
  }
  if (!tool.inputJson) return null;
  try {
    const parsed = JSON.parse(tool.inputJson);
    if (parsed && typeof parsed === 'object') {
      return parsed as BashDisplayInput;
    }
  } catch {
    // Older Codex mapping stored the raw command string instead of JSON.
    return { command: tool.inputJson } as BashDisplayInput;
  }
  return null;
}

function formatDuration(durationMs?: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null;
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainSeconds}s`;
}

interface BashToolProps {
  tool: ToolUseSimple;
}

export default function BashTool({ tool }: BashToolProps) {
  const input = parseBashInput(tool);
  const durationLabel = formatDuration(tool.resultMeta?.durationMs);
  const hasDisplayableInput = !!input?.command;

  if (!hasDisplayableInput && !tool.result) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
        <Loader2 className="size-3 animate-spin" />
        <span>Initializing terminal...</span>
      </div>
    );
  }

  // Try to parse structured bash result (JSON.parse already unescapes \n in JSON strings)
  const parsed = tool.result ? parseBashResult(tool.result) : null;

  return (
    <div className="flex flex-col gap-3 font-sans select-none">
      {hasDisplayableInput && (
        <>
          <div className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">Input</div>

          <div className="group relative overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--code-bg)] p-3 text-sm text-[var(--code-text)] shadow-sm select-text">
            <div className="flex items-start gap-3 font-mono leading-relaxed">
              <span className="mt-0.5 select-none font-bold text-[var(--success)]">$</span>
              <span className="break-all whitespace-pre-wrap">{input.command}</span>
            </div>
            {input.run_in_background && (
              <div className="absolute right-2 top-2 rounded border border-[var(--line)] bg-[var(--code-header-bg)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--code-line-number)]">
                Background
              </div>
            )}
          </div>

          {(input.cwd || durationLabel || tool.resultMeta?.exitCode != null || tool.resultMeta?.processId) && (
            <div className="flex flex-wrap items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-[var(--ink-muted)]">
              {input.cwd && (
                <span className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/60 px-1.5 py-0.5 normal-case text-[var(--ink-secondary)]">
                  {input.cwd}
                </span>
              )}
              {durationLabel && (
                <span className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/60 px-1.5 py-0.5">
                  {durationLabel}
                </span>
              )}
              {tool.resultMeta?.processId && (
                <span className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/60 px-1.5 py-0.5 normal-case">
                  PID {tool.resultMeta.processId}
                </span>
              )}
              {tool.resultMeta?.exitCode != null && (
                <span className={`rounded border px-1.5 py-0.5 ${
                  tool.resultMeta.exitCode === 0
                    ? 'border-[var(--success)]/30 bg-[var(--success-bg)] text-[var(--success)]'
                    : 'border-[var(--error)]/30 bg-[var(--error-bg)] text-[var(--error)]'
                }`}>
                  Exit {tool.resultMeta.exitCode}
                </span>
              )}
            </div>
          )}
        </>
      )}

      {/* Parsed structured output (stdout + stderr) */}
      {parsed && (parsed.stdout || parsed.stderr) && (
        <div className="flex flex-col gap-2">
          <div className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">Output</div>
          {parsed.stdout && (
            <ExpandableResult
              content={parsed.stdout}
              className="rounded-lg border border-[var(--line)] bg-[var(--code-bg)] p-3 text-sm text-[var(--code-text)]"
              gradientFrom="from-[var(--code-bg)]"
            />
          )}
          {parsed.stderr && (
            <ExpandableResult
              content={parsed.stderr}
              className="rounded-lg border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-sm text-[var(--error)]"
              gradientFrom="from-[var(--error-bg)]"
            />
          )}
        </div>
      )}

      {/* Fallback: raw result when JSON parse fails */}
      {!parsed && tool.result && (
        <div className="flex flex-col gap-1.5">
          <div className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">Output</div>
          <ExpandableResult
            content={tool.result}
            className={`rounded-lg border p-3 text-sm shadow-sm transition-colors ${tool.isError
              ? 'border-[var(--error)]/30 bg-[var(--error-bg)] text-[var(--error)]'
              : 'border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 text-[var(--ink-secondary)]'
            }`}
            gradientFrom={tool.isError
              ? 'from-[var(--error-bg)]'
              : 'from-[var(--paper-inset)]'
            }
          />
        </div>
      )}

      {/* Error without result */}
      {tool.isError && !tool.result && (
        <div className="flex items-center gap-2 rounded-md bg-[var(--error-bg)] p-2 text-xs text-[var(--error)]">
          <AlertCircle className="size-4" />
          <span>Command execution failed</span>
        </div>
      )}
    </div>
  );
}
