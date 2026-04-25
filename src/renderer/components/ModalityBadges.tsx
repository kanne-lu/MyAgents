import { Image as ImageIcon, Video, AudioLines } from 'lucide-react';
import Tip from '@/components/Tip';

/**
 * Small inline icon row that shows which non-text modalities a model accepts.
 *
 * Renders nothing for text-only models — the **absence** of a badge is the
 * "this is a text-only model" signal. Keeping the model picker lean for the
 * common case (most models) and only flagging the special-capability ones
 * was an explicit product call (see PRD note: "只展示图片吧，就是图片音频
 * 这种有这种额外模态的时候，你给他就打上标签").
 *
 * Mirrors OpenRouter / OpenAI modality naming so the same `inputModalities`
 * array drives both client + Sidecar filters and these badges. Extra
 * modality strings (e.g. OpenRouter's `file`) are intentionally ignored —
 * not a real input modality, just an upload affordance.
 */
export function ModalityBadges({
  modalities,
  className = '',
  iconSize = 'h-3 w-3',
}: {
  modalities?: string[];
  /** Extra classes for the wrapper. Defaults to muted ink color + small gap. */
  className?: string;
  /** Icon size class (default `h-3 w-3` for the picker; pass larger for status bars). */
  iconSize?: string;
}) {
  if (!modalities || modalities.length === 0) return null;
  const items: Array<{ key: string; label: string; Icon: typeof ImageIcon }> = [];
  if (modalities.includes('image')) items.push({ key: 'image', label: '图片', Icon: ImageIcon });
  if (modalities.includes('video')) items.push({ key: 'video', label: '视频', Icon: Video });
  if (modalities.includes('audio')) items.push({ key: 'audio', label: '音频', Icon: AudioLines });
  if (items.length === 0) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-[var(--ink-muted)]/70 ${className}`}>
      {items.map(({ key, label, Icon }) => (
        <Tip key={key} label={`支持${label}输入`} position="top">
          <Icon className={iconSize} aria-label={`支持${label}输入`} />
        </Tip>
      ))}
    </span>
  );
}
