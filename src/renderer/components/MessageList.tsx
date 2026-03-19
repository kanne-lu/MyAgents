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

/**
 * Format elapsed seconds to human-readable string
 */
function formatElapsedTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}小时${minutes}分钟${seconds}秒`;
  } else if (minutes > 0) {
    return `${minutes}分钟${seconds}秒`;
  } else {
    return `${seconds}秒`;
  }
}

interface MessageListProps {
  historyMessages: MessageType[];
  streamingMessage: MessageType | null;
  isLoading: boolean;
  isSessionLoading?: boolean;
  /** Session ID — used as Virtuoso key to force remount on session switch (clean height cache) */
  sessionId?: string | null;
  /** VirtuosoHandle ref — scroll API for session switch / send message */
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  /** Callback to capture virtuoso's internal scroll element (for QueryNavigator) */
  onScrollerRef?: (el: HTMLElement | Window | null) => void;
  /** Read by followOutput — false=disabled, true=follow at bottom, 'force'=always follow */
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

// Fun streaming status messages
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

/** StatusTimer — isolated component so 1s ticks don't trigger parent re-renders */
const StatusTimer = memo(function StatusTimer({ message }: { message: string }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef(0);

  useEffect(() => {
    startTimeRef.current = Date.now();
    const intervalId = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--ink-muted)]">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>
        {message}
        {elapsedSeconds > 0 && ` (${formatElapsedTime(elapsedSeconds)})`}
      </span>
    </div>
  );
});

/** Check if a message contains an ExitPlanMode tool call */
function hasExitPlanModeTool(message: MessageType): boolean {
  if (message.role !== 'assistant' || typeof message.content === 'string') return false;
  return message.content.some(
    block => (block.type === 'tool_use' || block.type === 'server_tool_use')
      && block.tool?.name === 'ExitPlanMode'
  );
}

// ── Stable custom Virtuoso sub-components (defined outside to prevent re-creation) ──

/** Scroller: the actual overflow:auto element */
const VirtuosoScroller = React.forwardRef<HTMLDivElement, React.ComponentPropsWithRef<'div'>>(
  function VirtuosoScroller(props, ref) {
    const { style, ...rest } = props;
    return (
      <div
        ref={ref}
        {...rest}
        style={{ ...style, overscrollBehavior: 'none' }}
        className={`${rest.className || ''} px-3 py-3`}
      />
    );
  }
);

/** List wrapper: centers content with max-width */
const VirtuosoList = React.forwardRef<HTMLDivElement, React.ComponentPropsWithRef<'div'>>(
  function VirtuosoList(props, ref) {
    return <div ref={ref} {...props} className={`${props.className || ''} mx-auto max-w-3xl`} />;
  }
);

/** Footer: prompts + status + bottom clearance — extracted as stable memo component */
const VirtuosoFooter = memo(function VirtuosoFooter({
  pendingPermission, onPermissionDecision,
  pendingAskUserQuestion, onAskUserQuestionSubmit, onAskUserQuestionCancel,
  showStatus, statusMessage, bottomPadding,
}: {
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (decision: 'deny' | 'allow_once' | 'always_allow') => void;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
  onAskUserQuestionCancel?: (requestId: string) => void;
  showStatus: boolean;
  statusMessage: string;
  bottomPadding?: number;
}) {
  return (
    <>
      {pendingPermission && onPermissionDecision && (
        <div className="mx-auto max-w-3xl py-2 px-1">
          <PermissionPrompt
            request={pendingPermission}
            onDecision={(_requestId, decision) => onPermissionDecision(decision)}
          />
        </div>
      )}
      {pendingAskUserQuestion && onAskUserQuestionSubmit && onAskUserQuestionCancel && (
        <div className="mx-auto max-w-3xl py-2 px-1">
          <AskUserQuestionPrompt
            request={pendingAskUserQuestion}
            onSubmit={onAskUserQuestionSubmit}
            onCancel={onAskUserQuestionCancel}
          />
        </div>
      )}
      {showStatus && (
        <div className="mx-auto max-w-3xl">
          <StatusTimer message={statusMessage} />
        </div>
      )}
      {bottomPadding ? <div style={{ height: bottomPadding }} aria-hidden="true" /> : null}
    </>
  );
});

const MessageList = memo(function MessageList({
  historyMessages,
  streamingMessage,
  isLoading,
  isSessionLoading,
  sessionId,
  virtuosoRef,
  onScrollerRef,
  followEnabledRef,
  bottomPadding,
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
  // ── Merged message array for Virtuoso ──
  const allMessages = useMemo(() =>
    streamingMessage
      ? [...historyMessages, streamingMessage]
      : historyMessages,
    [historyMessages, streamingMessage]
  );

  // ── Scroll to bottom after session load ──
  // initialTopMostItemIndex is unreliable with variable-height items (Virtuoso can't calculate
  // the exact scroll position without measuring). Instead, we scroll to LAST after Virtuoso has
  // mounted and rendered. The fadeIn animation (600ms opacity:0) hides this correction.
  const lastScrolledSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (allMessages.length > 0 && sessionId && sessionId !== lastScrolledSessionRef.current) {
      lastScrolledSessionRef.current = sessionId;
      // 200ms delay: gives Virtuoso time to render and measure items from the top.
      // The fadeIn animation (600ms opacity:0→1) hides this initial positioning.
      const timer = setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST' });
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [allMessages.length, sessionId, virtuosoRef]);

  // ── Streaming status ──
  const streamingStatusMessage = useMemo(
    () => getRandomStreamingMessage(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only change when message count changes
    [historyMessages.length]
  );

  // ── ExitPlanMode slot injection ──
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
        <ExitPlanModePrompt
          request={pendingExitPlanMode}
          onApprove={onExitPlanModeApprove}
          onReject={onExitPlanModeReject}
        />
      </div>
    );
  }, [pendingExitPlanMode, onExitPlanModeApprove, onExitPlanModeReject]);

  // ── Status display ──
  const showStatus = isLoading || !!systemStatus;
  const statusMessage = systemStatus
    ? (SYSTEM_STATUS_MESSAGES[systemStatus] || systemStatus)
    : streamingStatusMessage;

  // ── Fade-in animation on session load ──
  const wasSessionLoadingRef = useRef(false);
  const [fadeIn, setFadeIn] = useState(false);

  useEffect(() => {
    if (isSessionLoading) {
      wasSessionLoadingRef.current = true;
      setFadeIn(false);
    } else if (wasSessionLoadingRef.current) {
      wasSessionLoadingRef.current = false;
      setFadeIn(true);
    }
  }, [isSessionLoading]);

  const hasMessages = allMessages.length > 0;

  // ── Refs for stable renderItem — avoid re-creating itemContent on every streaming token ──
  // Critical: if renderItem depends on `streamingMessage` directly, it invalidates on every
  // token chunk, causing Virtuoso to re-render ALL visible items. Using refs lets the callback
  // read the latest value at call-time without changing its reference identity.
  const streamingMessageRef = useRef(streamingMessage);
  streamingMessageRef.current = streamingMessage;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const exitPlanModeAnchorIdRef = useRef(exitPlanModeAnchorId);
  exitPlanModeAnchorIdRef.current = exitPlanModeAnchorId;
  const exitPlanModeSlotRef = useRef(exitPlanModeSlot);
  exitPlanModeSlotRef.current = exitPlanModeSlot;

  // ── Virtuoso followOutput callback (reads ref at call-time) ──
  // Three modes: false=disabled, true=follow when at bottom, 'force'=always follow
  const handleFollowOutput = useMemo(
    () => (isAtBottom: boolean) => {
      const mode = followEnabledRef.current;
      if (!mode) return false;
      // 'force' mode: always follow (used after scrollToBottom to track async appends)
      if (mode === 'force') return 'smooth' as const;
      return isAtBottom ? 'smooth' as const : false;
    },
    [followEnabledRef]
  );

  // ── Stable itemContent — reads streaming state from refs, never invalidates during streaming ──
  // Not a React component — it's Virtuoso's itemContent render function (returns JSX but is not a component).
  // Refs intentionally used to keep the callback stable during streaming (no dep on streamingMessage).
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  const renderItem = useMemo(
    // eslint-disable-next-line react/display-name
    () => (index: number, message: MessageType) => {
      // ── Diagnostic: verify Virtuoso passes the correct message for this index ──
      const expected = allMessagesRef.current[index];
      if (expected && message !== expected) {
        console.error(
          `[Virtuoso] DATA MISMATCH at index ${index}: ` +
          `received id=${message.id} but data[${index}].id=${expected.id}`
        );
      }

      const sm = streamingMessageRef.current;
      const isStreamingMsg = !!sm && message === sm;
      return (
        <div className="py-1">
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
    },
    [onRewind, onRetry, onFork]  // Only truly stable deps — refs handle the rest
  );

  // ── Stable computeItemKey — use message ID instead of index ──
  const computeItemKey = useMemo(
    () => (_index: number, message: MessageType) => message.id,
    []
  );

  // ── Stable Footer component (wrapped in useMemo to prevent Virtuoso re-mount) ──
  const FooterComponent = useMemo(() => {
    return function Footer() {
      return (
        <VirtuosoFooter
          pendingPermission={pendingPermission}
          onPermissionDecision={onPermissionDecision}
          pendingAskUserQuestion={pendingAskUserQuestion}
          onAskUserQuestionSubmit={onAskUserQuestionSubmit}
          onAskUserQuestionCancel={onAskUserQuestionCancel}
          showStatus={showStatus}
          statusMessage={statusMessage}
          bottomPadding={bottomPadding}
        />
      );
    };
  }, [pendingPermission, onPermissionDecision, pendingAskUserQuestion, onAskUserQuestionSubmit, onAskUserQuestionCancel, showStatus, statusMessage, bottomPadding]);

  // ── Stable components object ──
  const components = useMemo(() => ({
    Scroller: VirtuosoScroller,
    List: VirtuosoList,
    Footer: FooterComponent,
  }), [FooterComponent]);

  return (
    <div
      className="relative flex-1"
      data-streaming={isStreaming || undefined}
      style={fadeIn ? { animation: 'message-list-fade-in 600ms ease-out both' } : undefined}
      onAnimationEnd={() => setFadeIn(false)}
    >
      {/* Loading spinner overlay */}
      {isSessionLoading && !hasMessages && (
        <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ paddingBottom: 140 }}>
          <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>加载对话记录…</span>
          </div>
        </div>
      )}

      <Virtuoso
        key={sessionId || 'pending'}
        ref={virtuosoRef}
        scrollerRef={onScrollerRef}
        data={allMessages}
        computeItemKey={computeItemKey}
        followOutput={handleFollowOutput}
        atBottomThreshold={50}
        defaultItemHeight={300}
        increaseViewportBy={{ top: 20000, bottom: 2000 }}
        className="h-full"
        components={components}
        itemContent={renderItem}
      />
    </div>
  );
});

export default MessageList;
