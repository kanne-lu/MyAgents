import { Loader2 } from 'lucide-react';
import React, { memo, useMemo, useState, useEffect, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';

import Message from '@/components/Message';
import { PermissionPrompt, type PermissionRequest } from '@/components/PermissionPrompt';
import { AskUserQuestionPrompt, type AskUserQuestionRequest } from '@/components/AskUserQuestionPrompt';
import { ExitPlanModePrompt } from '@/components/ExitPlanModePrompt';
import type { ExitPlanModeRequest } from '../../shared/types/planMode';
import type { Message as MessageType } from '@/types/chat';

function formatElapsedTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分钟${seconds}秒`;
  if (minutes > 0) return `${minutes}分钟${seconds}秒`;
  return `${seconds}秒`;
}

interface MessageListProps {
  historyMessages: MessageType[];
  streamingMessage: MessageType | null;
  isLoading: boolean;
  isSessionLoading?: boolean;
  sessionId?: string | null;
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  onScrollerRef?: (el: HTMLElement | Window | null) => void;
  followEnabledRef: React.MutableRefObject<boolean | 'force'>;
  bottomPadding?: number;
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (decision: 'deny' | 'allow_once' | 'always_allow') => void;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
  onAskUserQuestionCancel?: (requestId: string) => void;
  pendingExitPlanMode?: ExitPlanModeRequest | null;
  onExitPlanModeApprove?: () => void;
  onExitPlanModeReject?: () => void;
  systemStatus?: string | null;
  isStreaming?: boolean;
  onRewind?: (messageId: string) => void;
  onRetry?: (assistantMessageId: string) => void;
  onFork?: (assistantMessageId: string) => void;
}

const STREAMING_MESSAGES = [
  '苦思冥想中…', '深思熟虑中…', '灵光一闪中…', '绞尽脑汁中…', '思绪飞速运转中…',
  '小脑袋瓜转啊转…', '神经元疯狂放电中…', '灵感小火花碰撞中…', '正在努力组织语言…',
  '在知识海洋里捞答案…', '正在翻阅宇宙图书馆…', '答案正在酝酿中…', '灵感咖啡冲泡中…',
  '递归思考中，请勿打扰…', '正在遍历可能性…', '加载智慧模块中…',
  '容我想想…', '稍等，马上就好…', '别急，好饭不怕晚…', '正在认真对待你的问题…',
];
const SYSTEM_STATUS_MESSAGES: Record<string, string> = {
  compacting: '会话内容过长，智能总结中…',
  rewinding: '正在时间回溯中，请稍等…',
};
function getRandomStreamingMessage(): string {
  return STREAMING_MESSAGES[Math.floor(Math.random() * STREAMING_MESSAGES.length)];
}

const StatusTimer = memo(function StatusTimer({ message }: { message: string }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef(0);
  useEffect(() => {
    startTimeRef.current = Date.now();
    const id = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--ink-muted)]">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>{message}{elapsedSeconds > 0 && ` (${formatElapsedTime(elapsedSeconds)})`}</span>
    </div>
  );
});

function hasExitPlanModeTool(message: MessageType): boolean {
  if (message.role !== 'assistant' || typeof message.content === 'string') return false;
  return message.content.some(
    block => (block.type === 'tool_use' || block.type === 'server_tool_use') && block.tool?.name === 'ExitPlanMode'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MINIMAL Virtuoso test — stripped all custom Scroller/List/Footer.
// Goal: isolate whether the phantom-content bug is caused by our
// customizations or by Virtuoso itself with our data/content.
// ═══════════════════════════════════════════════════════════════════════

const MessageList = memo(function MessageList({
  historyMessages,
  streamingMessage,
  isLoading,
  isSessionLoading,
  sessionId,
  virtuosoRef,
  onScrollerRef,
  followEnabledRef,
  bottomPadding: _bottomPadding,
  pendingPermission,
  onPermissionDecision,
  pendingAskUserQuestion,
  onAskUserQuestionSubmit,
  onAskUserQuestionCancel,
  pendingExitPlanMode,
  onExitPlanModeApprove,
  onExitPlanModeReject,
  systemStatus,
  isStreaming,
  onRewind,
  onRetry,
  onFork,
}: MessageListProps) {
  const allMessages = useMemo(() =>
    streamingMessage ? [...historyMessages, streamingMessage] : historyMessages,
    [historyMessages, streamingMessage]
  );

  // Streaming status
  const streamingStatusMessage = useMemo(
    () => getRandomStreamingMessage(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyMessages.length]
  );

  // ExitPlanMode
  const exitPlanModeAnchorId = useMemo(() => {
    if (!pendingExitPlanMode) return null;
    if (streamingMessage && hasExitPlanModeTool(streamingMessage)) return streamingMessage.id;
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      if (hasExitPlanModeTool(historyMessages[i])) return historyMessages[i].id;
    }
    return null;
  }, [pendingExitPlanMode, streamingMessage, historyMessages]);
  const exitPlanModeSlot = useMemo(() => {
    if (!pendingExitPlanMode || !onExitPlanModeApprove || !onExitPlanModeReject) return undefined;
    return (
      <div className="py-2">
        <ExitPlanModePrompt request={pendingExitPlanMode} onApprove={onExitPlanModeApprove} onReject={onExitPlanModeReject} />
      </div>
    );
  }, [pendingExitPlanMode, onExitPlanModeApprove, onExitPlanModeReject]);

  const showStatus = isLoading || !!systemStatus;
  const statusMessage = systemStatus ? (SYSTEM_STATUS_MESSAGES[systemStatus] || systemStatus) : streamingStatusMessage;

  // Fade-in
  const wasSessionLoadingRef = useRef(false);
  const [fadeIn, setFadeIn] = useState(false);
  useEffect(() => {
    if (isSessionLoading) { wasSessionLoadingRef.current = true; setFadeIn(false); }
    else if (wasSessionLoadingRef.current) { wasSessionLoadingRef.current = false; setFadeIn(true); }
  }, [isSessionLoading]);

  // Scroll to bottom after load
  const lastScrolledSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (allMessages.length > 0 && sessionId && sessionId !== lastScrolledSessionRef.current) {
      lastScrolledSessionRef.current = sessionId;
      followEnabledRef.current = 'force';
      const timer = setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [allMessages.length, sessionId, virtuosoRef, followEnabledRef]);

  // Refs for stable renderItem
  const streamingMessageRef = useRef(streamingMessage);
  streamingMessageRef.current = streamingMessage;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const exitPlanModeAnchorIdRef = useRef(exitPlanModeAnchorId);
  exitPlanModeAnchorIdRef.current = exitPlanModeAnchorId;
  const exitPlanModeSlotRef = useRef(exitPlanModeSlot);
  exitPlanModeSlotRef.current = exitPlanModeSlot;

  const handleFollowOutput = useMemo(
    () => (isAtBottom: boolean) => {
      const mode = followEnabledRef.current;
      if (!mode) return false;
      if (mode === 'force') return 'smooth' as const;
      return isAtBottom ? 'smooth' as const : false;
    },
    [followEnabledRef]
  );

  return (
    <div
      className="relative flex-1"
      data-streaming={isStreaming || undefined}
      style={fadeIn ? { animation: 'message-list-fade-in 600ms ease-out both' } : undefined}
      onAnimationEnd={() => setFadeIn(false)}
    >
      {isSessionLoading && allMessages.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ paddingBottom: 140 }}>
          <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>加载对话记录…</span>
          </div>
        </div>
      )}

      {/* ═══ MINIMAL Virtuoso — NO custom Scroller/List/Footer ═══ */}
      <Virtuoso
        key={sessionId || 'pending'}
        ref={virtuosoRef}
        scrollerRef={onScrollerRef}
        data={allMessages}
        computeItemKey={(_i, m) => m.id}
        followOutput={handleFollowOutput}
        skipAnimationFrameInResizeObserver
        increaseViewportBy={{ top: 1200, bottom: 800 }}
        atBottomThreshold={50}
        defaultItemHeight={200}
        className="h-full"
        style={{ overscrollBehavior: 'none' }}
        itemContent={(index, message) => {
          const sm = streamingMessageRef.current;
          const isStreamingMsg = !!sm && message === sm;
          return (
            <div className="mx-auto max-w-3xl px-3 py-1 overflow-hidden">
              <Message
                message={message}
                isLoading={isStreamingMsg && isLoadingRef.current}
                onRewind={onRewind}
                onRetry={onRetry}
                onFork={onFork}
                exitPlanModeSlot={message.id === exitPlanModeAnchorIdRef.current ? exitPlanModeSlotRef.current : undefined}
              />
            </div>
          );
        }}
      />

      {/* Footer OUTSIDE Virtuoso — avoids polluting its height calculation */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0">
        <div className="pointer-events-auto mx-auto max-w-3xl px-3">
          {pendingPermission && onPermissionDecision && (
            <div className="py-2">
              <PermissionPrompt request={pendingPermission} onDecision={(_id, d) => onPermissionDecision(d)} />
            </div>
          )}
          {pendingAskUserQuestion && onAskUserQuestionSubmit && onAskUserQuestionCancel && (
            <div className="py-2">
              <AskUserQuestionPrompt request={pendingAskUserQuestion} onSubmit={onAskUserQuestionSubmit} onCancel={onAskUserQuestionCancel} />
            </div>
          )}
          {showStatus && <StatusTimer message={statusMessage} />}
        </div>
      </div>
    </div>
  );
});

export default MessageList;
