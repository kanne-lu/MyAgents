import { useRef, useCallback } from 'react';
import { Play, Square } from 'lucide-react';
import { track } from '@/analytics';
import type { ToolUseSimple } from '@/types/chat';
import { CollapsibleTool } from './CollapsibleTool';
import { ToolHeader } from './utils';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';

interface EdgeTtsToolProps {
  tool: ToolUseSimple;
}

/** Parse structured fields from the tool result text */
function parseToolResult(result: string | undefined): {
  filePath?: string;
  voice?: string;
  duration?: string;
  format?: string;
  size?: string;
  rate?: string;
  volume?: string;
  pitch?: string;
  textPreview?: string;
  error?: string;
  isVoiceList: boolean;
} {
  if (!result) return { isVoiceList: false };

  // Check if it's a voice list result
  if (result.includes('Found ') && result.includes('voice(s)')) {
    return { isVoiceList: true };
  }

  // Check for errors
  if (result.startsWith('Error')) {
    return { error: result, isVoiceList: false };
  }

  const lines = result.split('\n');
  const fields: Record<string, string> = {};

  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      fields[match[1]] = match[2].trim();
    }
  }

  return {
    filePath: fields['filePath'],
    voice: fields['voice'],
    duration: fields['duration'],
    format: fields['format'],
    size: fields['size'],
    rate: fields['rate'],
    volume: fields['volume'],
    pitch: fields['pitch'],
    textPreview: fields['textPreview'],
    error: undefined,
    isVoiceList: false,
  };
}

/** Compact audio player bar with progress */
function AudioPlayerBar({ filePath }: { filePath: string }) {
  const { isActive, toggle, progress, duration } = useAudioPlayer(filePath);
  const trackedRef = useRef(false);

  // Track first play
  const handleToggle = useCallback(() => {
    if (!isActive && !trackedRef.current) {
      track('tts_play', {});
      trackedRef.current = true;
    }
    toggle();
  }, [isActive, toggle]);

  const displayProgress = isActive && duration > 0 ? progress / duration : 0;
  const formatTime = (sec: number) => {
    if (!sec || !isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-[var(--paper-inset)] px-3 py-2 max-w-[400px]">
      {/* Play/Stop button */}
      <button
        type="button"
        onClick={handleToggle}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-colors hover:bg-[var(--accent-hover)]"
      >
        {isActive
          ? <Square className="size-2.5 fill-current" />
          : <Play className="size-3 fill-current ml-0.5" />
        }
      </button>

      {/* Progress bar */}
      <div className="flex flex-1 items-center gap-2">
        <div className="relative h-1 flex-1 rounded-full bg-[var(--line)]">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)] transition-[width] duration-200"
            style={{ width: `${displayProgress * 100}%` }}
          />
        </div>
        <span className="text-[10px] tabular-nums text-[var(--ink-muted)] shrink-0">
          {isActive ? formatTime(progress) : '0:00'} / {isActive && duration > 0 ? formatTime(duration) : '--:--'}
        </span>
      </div>
    </div>
  );
}

export default function EdgeTtsTool({ tool }: EdgeTtsToolProps) {
  const parsed = parseToolResult(tool.result);

  const isListVoices = tool.name.includes('list_voices');
  const toolLabel = isListVoices ? '查询语音' : '语音合成';
  const isGenerating = !tool.result;

  const collapsedContent = (
    <div className="flex items-center gap-1.5">
      <ToolHeader tool={tool} toolName={tool.name} label={toolLabel} />
      {isGenerating && (
        <span className="text-[10px] text-[var(--ink-muted)] animate-pulse">
          {isListVoices ? '查询中...' : '生成中...'}
        </span>
      )}
      {parsed.voice && (
        <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)] font-mono">
          {parsed.voice}
        </span>
      )}
      {parsed.duration && (
        <span className="text-[10px] text-[var(--ink-muted)]">{parsed.duration}</span>
      )}
      {parsed.textPreview && (
        <span className="truncate text-[10px] text-[var(--ink-muted)] max-w-[300px]">
          {parsed.textPreview}
        </span>
      )}
    </div>
  );

  const expandedContent = (
    <div className="space-y-2 mt-1">
      {/* Parameters */}
      {tool.inputJson && (
        <div className="text-[10px] text-[var(--ink-muted)] font-mono">
          {(() => {
            try {
              const input = JSON.parse(tool.inputJson);
              return (
                <div className="space-y-0.5">
                  {input.text && (
                    <div>
                      <span className="opacity-60">text:</span>{' '}
                      {input.text.length > 100 ? input.text.substring(0, 100) + '...' : input.text}
                    </div>
                  )}
                  {input.voice && <div><span className="opacity-60">voice:</span> {input.voice}</div>}
                  {input.rate && <div><span className="opacity-60">rate:</span> {input.rate}</div>}
                  {input.volume && <div><span className="opacity-60">volume:</span> {input.volume}</div>}
                  {input.pitch && <div><span className="opacity-60">pitch:</span> {input.pitch}</div>}
                  {input.language && <div><span className="opacity-60">language:</span> {input.language}</div>}
                  {input.gender && <div><span className="opacity-60">gender:</span> {input.gender}</div>}
                </div>
              );
            } catch {
              return <pre className="break-words whitespace-pre-wrap">{tool.inputJson}</pre>;
            }
          })()}
        </div>
      )}

      {/* Audio player */}
      {parsed.filePath && !parsed.error && (
        <div className="mt-2">
          <AudioPlayerBar filePath={parsed.filePath} />
        </div>
      )}

      {/* Metadata */}
      {parsed.filePath && !parsed.error && (
        <div className="text-[10px] text-[var(--ink-muted)] space-y-0.5 mt-1">
          {parsed.voice && <div>语音: {parsed.voice}</div>}
          {parsed.duration && <div>时长: {parsed.duration}</div>}
          {parsed.format && parsed.size && <div>格式: {parsed.format} | 大小: {parsed.size}</div>}
          {parsed.rate && parsed.rate !== '0%' && <div>语速: {parsed.rate}</div>}
          {parsed.volume && parsed.volume !== '0%' && <div>音量: {parsed.volume}</div>}
          {parsed.pitch && parsed.pitch !== '+0Hz' && <div>音调: {parsed.pitch}</div>}
        </div>
      )}

      {/* Voice list result */}
      {parsed.isVoiceList && tool.result && (
        <pre className="overflow-x-auto overflow-y-auto max-h-[300px] rounded bg-[var(--paper-inset)]/50 px-2 py-1.5 font-mono text-[10px] whitespace-pre-wrap text-[var(--ink-secondary)]">
          {tool.result}
        </pre>
      )}

      {/* Error display */}
      {parsed.error && (
        <pre className="overflow-x-auto rounded bg-[var(--error-bg)] px-2 py-1 font-mono text-xs break-words whitespace-pre-wrap text-[var(--error)]">
          {parsed.error}
        </pre>
      )}
    </div>
  );

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
