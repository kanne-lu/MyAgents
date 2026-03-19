import type { ReadInput, ToolUseSimple } from '@/types/chat';

import { CollapsibleTool } from './CollapsibleTool';
import { ExpandableResult, FilePath, ToolHeader } from './utils';

/** Try to extract file content from SDK JSON wrapper.
 *  Formats seen:
 *  - {"type":"text","file":{"filePath":"...","content":"..."}}
 *  - Plain text (cat -n output)
 */
function extractFileContent(result: string): string {
  const trimmed = result.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.file?.content && typeof parsed.file.content === 'string') {
        return parsed.file.content;
      }
      // Some variants use top-level content
      if (parsed?.content && typeof parsed.content === 'string') {
        return parsed.content;
      }
    } catch { /* not JSON, fall through */ }
  }
  return result;
}

interface ReadToolProps {
  tool: ToolUseSimple;
}

export default function ReadTool({ tool }: ReadToolProps) {
  const input = tool.parsedInput as ReadInput;

  if (!input) {
    return (
      <div className="my-0.5">
        <ToolHeader tool={tool} toolName={tool.name} />
      </div>
    );
  }

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader tool={tool} toolName={tool.name} />
      <FilePath path={input.file_path} />
      {input.offset !== undefined && (
        <span className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--ink-muted)] uppercase">
          offset {input.offset}
        </span>
      )}
      {input.limit !== undefined && (
        <span className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--ink-muted)] uppercase">
          limit {input.limit}
        </span>
      )}
    </div>
  );

  const content = tool.result ? extractFileContent(tool.result) : null;

  const expandedContent = content ? (
    <ExpandableResult
      content={content}
      className="rounded bg-[var(--paper-inset)]/50 px-2 py-1 wrap-break-word text-[var(--ink-secondary)]"
    />
  ) : null;

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
