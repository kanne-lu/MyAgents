// Query Navigator — floating right-side panel for quick session query navigation
// Unified row design: dashes are always visible in the same position.
// On hover, text labels slide in from the right — dashes stay anchored.

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Message } from '../../types/chat';

/** Minimum user queries to show the navigator */
const MIN_QUERIES = 3;

interface QueryNavigatorProps {
  historyMessages: Message[];
  streamingMessage: Message | null;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  pauseAutoScroll: (duration?: number) => void;
}

/** Extract plain text preview from message content */
function getQueryText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    const textBlock = msg.content.find(
      (b): b is { type: 'text'; text: string } => b.type === 'text',
    );
    return textBlock?.text ?? '';
  }
  return '';
}

/** Check if a user message is a system injection (not real user query) */
function isSystemInjection(text: string): boolean {
  return (
    text.includes('<HEARTBEAT>') ||
    text.includes('<MEMORY_UPDATE>') ||
    text.startsWith('<system-reminder>')
  );
}

export default function QueryNavigator({
  historyMessages,
  streamingMessage,
  scrollContainerRef,
  pauseAutoScroll,
}: QueryNavigatorProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeIndexRaw, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  // Extract real user queries (filter out system injections)
  const queries = useMemo(() => {
    const allMessages = streamingMessage
      ? [...historyMessages, streamingMessage]
      : historyMessages;

    return allMessages
      .filter((msg) => {
        if (msg.role !== 'user') return false;
        const text = getQueryText(msg);
        return text.trim() !== '' && !isSystemInjection(text);
      })
      .map((msg) => ({
        id: msg.id,
        text: getQueryText(msg),
      }));
  }, [historyMessages, streamingMessage]);

  // Clamp activeIndex to valid range (handles session switch, query list shrink)
  const activeIndex = activeIndexRaw >= 0 && activeIndexRaw < queries.length ? activeIndexRaw : -1;

  // Track active query via IntersectionObserver
  const visibleIndicesRef = useRef(new Set<number>());

  useEffect(() => {
    visibleIndicesRef.current.clear();

    if (queries.length < MIN_QUERIES) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const userElements = container.querySelectorAll<HTMLElement>('[data-role="user"]');
    if (userElements.length === 0) return;

    const idToQueryIndex = new Map<string, number>();
    queries.forEach((q, i) => idToQueryIndex.set(q.id, i));

    const visibleSet = visibleIndicesRef.current;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const messageId = el.getAttribute('data-message-id');
          if (!messageId) continue;
          const qIndex = idToQueryIndex.get(messageId);
          if (qIndex === undefined) continue;

          if (entry.isIntersecting) {
            visibleSet.add(qIndex);
          } else {
            visibleSet.delete(qIndex);
          }
        }

        if (visibleSet.size > 0) {
          setActiveIndex(Math.min(...visibleSet));
        }
      },
      {
        root: container,
        rootMargin: '0px 0px -60% 0px',
        threshold: 0,
      },
    );

    userElements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [queries, scrollContainerRef]);

  // Auto-scroll the panel to keep active item visible
  useEffect(() => {
    if (isExpanded && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [isExpanded, activeIndex]);

  // Navigate to a query
  const handleQueryClick = useCallback(
    (queryId: string) => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const target = container.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(queryId)}"]`,
      );
      if (!target) return;

      pauseAutoScroll(2000);
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [scrollContainerRef, pauseAutoScroll],
  );

  if (queries.length < MIN_QUERIES) return null;

  return (
    <div
      className="absolute right-0 top-0 bottom-0 z-20 hidden md:flex items-center"
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
    >
      {/* Single unified container — dashes always anchored right, text slides in */}
      <div
        aria-hidden={!isExpanded}
        className={`relative max-h-[60vh] overflow-hidden transition-[width,background-color,border-color,box-shadow] duration-200 ${
          isExpanded
            ? 'w-56 rounded-xl border border-[var(--line)] shadow-lg'
            : 'w-5 border border-transparent'
        }`}
        style={isExpanded ? {
          background: 'var(--paper-elevated)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        } : undefined}
      >
        {/* Top fade mask */}
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-5 transition-opacity duration-200 ${
            isExpanded ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ background: 'linear-gradient(to bottom, var(--paper-elevated), transparent)' }}
        />

        {/* Scrollable list — each row: [text (conditional)] + [dash (always)] */}
        <div
          ref={listRef}
          className="overflow-y-auto max-h-[60vh] py-3"
        >
          {queries.map((q, i) => {
            const isActive = i === activeIndex;
            return (
              <button
                key={q.id}
                ref={isActive ? activeItemRef : undefined}
                type="button"
                tabIndex={isExpanded ? 0 : -1}
                onClick={() => isExpanded && handleQueryClick(q.id)}
                className={`flex w-full items-center gap-1.5 py-[3px] text-left transition-colors ${
                  isExpanded
                    ? `px-2 cursor-pointer rounded-lg ${isActive ? 'bg-[var(--hover-bg)]' : 'hover:bg-[var(--hover-bg)]'}`
                    : 'px-0 cursor-default justify-end'
                }`}
              >
                {/* Query text — only visible when expanded */}
                <span
                  className={`flex-1 truncate text-xs leading-5 transition-opacity duration-200 ${
                    isExpanded ? 'opacity-100' : 'opacity-0 w-0 overflow-hidden'
                  } ${isActive ? 'text-[var(--accent)] font-medium' : 'text-[var(--ink-muted)]'}`}
                >
                  {q.text}
                </span>

                {/* Dash — always visible, same position */}
                <span
                  className={`flex-shrink-0 rounded-full transition-all duration-150 ${
                    isActive
                      ? 'w-[10px] h-[3px] bg-[var(--accent)]'
                      : 'w-[8px] h-[2px] bg-[var(--ink-faint)]'
                  } ${isExpanded ? 'mr-1' : 'mr-1.5'}`}
                />
              </button>
            );
          })}
        </div>

        {/* Bottom fade mask */}
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-5 transition-opacity duration-200 ${
            isExpanded ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ background: 'linear-gradient(to top, var(--paper-elevated), transparent)' }}
        />
      </div>
    </div>
  );
}
