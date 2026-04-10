import type { EditInput, ToolUseSimple } from '@/types/chat';

import { CollapsibleTool } from './CollapsibleTool';
import { ExpandableResult, FilePath, ToolHeader } from './utils';

interface EditToolProps {
  tool: ToolUseSimple;
}

export default function EditTool({ tool }: EditToolProps) {
  const input = tool.parsedInput as (EditInput & {
    cwd?: string;
    changes?: Array<{ path: string; kind?: string }>;
  }) | undefined;

  let fallbackInput: { file_path?: string; changes?: Array<{ path: string; kind?: string }> } | null = null;
  if (!input && tool.inputJson) {
    try {
      const parsed = JSON.parse(tool.inputJson) as { file_path?: string; changes?: Array<{ path: string; kind?: string }> };
      fallbackInput = parsed;
    } catch {
      fallbackInput = null;
    }
  }
  const filePath = input?.file_path || fallbackInput?.file_path;
  const changePaths = input?.changes || fallbackInput?.changes || [];

  if (!input && !fallbackInput) {
    return (
      <div className="my-0.5">
        <ToolHeader tool={tool} toolName={tool.name} />
      </div>
    );
  }

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader tool={tool} toolName={tool.name} />
      {filePath && <FilePath path={filePath} />}
      {!filePath && changePaths.map(change => (
        <FilePath key={`${change.kind ?? 'change'}:${change.path}`} path={change.path} />
      ))}
      {input?.replace_all && (
        <span className="rounded border border-[var(--warning)]/30 bg-[var(--warning-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--warning)]">
          replace all
        </span>
      )}
    </div>
  );

  const expandedContent = input?.old_string !== undefined || input?.new_string !== undefined ? (
    <div className="space-y-1.5">
      <pre className="overflow-x-auto rounded bg-[var(--error-bg)] px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--error)]">
        {input?.old_string || ''}
      </pre>

      <pre className="overflow-x-auto rounded bg-[var(--success-bg)] px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--success)]">
        {input?.new_string || ''}
      </pre>
    </div>
  ) : tool.result ? (
    <ExpandableResult
      content={tool.result}
      className="rounded bg-[var(--paper-inset)]/50 px-2 py-1 break-words text-[var(--ink-secondary)]"
    />
  ) : null;

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
