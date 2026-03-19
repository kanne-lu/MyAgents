
import { useEffect, useRef, useState } from 'react';

import type { BashInput, ToolUseSimple } from '@/types/chat';

import { AlertCircle, Loader2 } from 'lucide-react';

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

/** Replace escaped newlines with real newlines */
function unescapeNewlines(s: string): string {
  return s.replace(/\\n/g, '\n');
}

/** Expandable output block with max-h-96 + gradient fade + "展开全部" */
function ExpandableOutput({
  content,
  className,
  gradientFrom,
}: {
  content: string;
  className: string;
  gradientFrom: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    if (ref.current) {
      setIsOverflowing(ref.current.scrollHeight > ref.current.clientHeight);
    }
  }, [content]);

  return (
    <div className="relative">
      <pre
        ref={ref}
        className={`${className} ${isExpanded ? '' : 'max-h-96'} overflow-hidden`}
      >
        {content}
      </pre>
      {isOverflowing && !isExpanded && (
        <div className={`absolute bottom-0 left-0 right-0 flex justify-center ${gradientFrom} pb-2 pt-8`}>
          <button
            type="button"
            onClick={() => setIsExpanded(true)}
            className="rounded-full border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1 text-xs text-[var(--ink-muted)] shadow-sm hover:text-[var(--ink-secondary)] transition-colors"
          >
            展开全部
          </button>
        </div>
      )}
    </div>
  );
}

interface BashToolProps {
  tool: ToolUseSimple;
}

export default function BashTool({ tool }: BashToolProps) {
  const input = tool.parsedInput as BashInput;

  if (!input) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
        <Loader2 className="size-3 animate-spin" />
        <span>Initializing terminal...</span>
      </div>
    );
  }

  // Try to parse structured bash result
  const parsed = tool.result ? parseBashResult(tool.result) : null;

  return (
    <div className="flex flex-col gap-3 font-sans select-none">
      {/* Command Display (Dark terminal style) */}
      <div className="group relative overflow-hidden rounded-lg bg-[var(--code-bg)] p-3 text-sm text-[var(--code-text)] shadow-sm border border-[var(--line)] select-text">
        <div className="flex items-start gap-3 font-mono leading-relaxed">
          <span className="select-none text-[var(--success)] font-bold mt-0.5">$</span>
          <span className="break-all whitespace-pre-wrap">{input.command}</span>
        </div>
        {input.run_in_background && (
          <div className="absolute right-2 top-2 rounded border border-[var(--line)] bg-[var(--code-header-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--code-line-number)] uppercase tracking-wider">
            Background
          </div>
        )}
      </div>

      {/* Parsed structured output (stdout + stderr) */}
      {parsed && (parsed.stdout || parsed.stderr) && (
        <div className="flex flex-col gap-2">
          {parsed.stdout && (
            <ExpandableOutput
              content={unescapeNewlines(parsed.stdout)}
              className="overflow-x-auto rounded-lg border border-[var(--line)] bg-[var(--code-bg)] p-3 font-mono text-xs text-[var(--code-text)] whitespace-pre-wrap select-text"
              gradientFrom="bg-gradient-to-t from-[var(--code-bg)] to-transparent"
            />
          )}
          {parsed.stderr && (
            <ExpandableOutput
              content={unescapeNewlines(parsed.stderr)}
              className="overflow-x-auto rounded-lg border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 font-mono text-xs text-[var(--error)] whitespace-pre-wrap select-text"
              gradientFrom="bg-gradient-to-t from-[var(--error-bg)] to-transparent"
            />
          )}
        </div>
      )}

      {/* Fallback: raw result when JSON parse fails */}
      {!parsed && tool.result && (
        <div className="space-y-1.5">
          <div className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">Output</div>
          <ExpandableOutput
            content={tool.result}
            className={`overflow-x-auto rounded-lg border p-3 font-mono text-xs shadow-sm transition-colors whitespace-pre-wrap select-text ${tool.isError
              ? 'border-[var(--error)]/30 bg-[var(--error-bg)] text-[var(--error)]'
              : 'border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 text-[var(--ink-secondary)]'
            }`}
            gradientFrom={tool.isError
              ? 'bg-gradient-to-t from-[var(--error-bg)] to-transparent'
              : 'bg-gradient-to-t from-[var(--paper-inset)] to-transparent'
            }
          />
        </div>
      )}

      {/* Error without result (?) */}
      {tool.isError && !tool.result && (
        <div className="flex items-center gap-2 rounded-md bg-[var(--error-bg)] p-2 text-xs text-[var(--error)]">
          <AlertCircle className="size-4" />
          <span>Command execution failed</span>
        </div>
      )}
    </div>
  );
}
