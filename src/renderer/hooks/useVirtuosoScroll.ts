/**
 * useVirtuosoScroll — thin wrapper around react-virtuoso's scroll API.
 *
 * Replaces the 490-line useAutoScroll.ts with ~80 lines:
 *  - followOutput:         managed by Virtuoso's built-in followOutput callback
 *  - scrollToBottom:       virtuosoRef.scrollToIndex({ index: 'LAST' }) + force-follow
 *  - pauseAutoScroll:      temporarily disables followOutput via ref
 *  - session switch:       pendingScrollRef → instant scroll on next data change
 *  - user scroll-up:       followOutput returns false when not at bottom (Virtuoso manages)
 */

import { useCallback, useEffect, useRef } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

export interface VirtuosoScrollControls {
    virtuosoRef: React.RefObject<VirtuosoHandle | null>;
    /** Ref capturing virtuoso's internal scroll element — for QueryNavigator IntersectionObserver */
    scrollerRef: React.MutableRefObject<HTMLElement | null>;
    /**
     * Read by Virtuoso's followOutput callback.
     * - `false`: auto-follow disabled (paused or user scrolled up)
     * - `true`: follow only when already at bottom
     * - `'force'`: force-follow even when not at bottom (after scrollToBottom)
     */
    followEnabledRef: React.MutableRefObject<boolean | 'force'>;
    /** Re-enable auto-follow and smooth-scroll to bottom (user sends message) */
    scrollToBottom: () => void;
    /** Temporarily disable auto-follow (rewind/retry DOM changes) */
    pauseAutoScroll: (duration?: number) => void;
}

export function useVirtuosoScroll(
    isLoading: boolean,
    messagesLength: number,
    sessionId?: string | null,
): VirtuosoScrollControls {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const scrollerRef = useRef<HTMLElement | null>(null);
    const followEnabledRef = useRef<boolean | 'force'>(true);
    const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingScrollRef = useRef(false);
    const lastSessionIdRef = useRef<string | null | undefined>(undefined);

    // ── Session switch: mark pending instant-scroll ──
    useEffect(() => {
        const prev = lastSessionIdRef.current;
        lastSessionIdRef.current = sessionId;

        const isSwitch = prev !== undefined && sessionId !== prev;
        const isInitial = prev === undefined && sessionId != null;

        if (isSwitch || isInitial) {
            pendingScrollRef.current = true;
            followEnabledRef.current = true;
        }
    }, [sessionId]);

    // ── Streaming starts: clear pending flag and force-follow, normal follow handles the rest ──
    useEffect(() => {
        if (isLoading) {
            pendingScrollRef.current = false;
            // Downgrade from 'force' to true — streaming is underway, normal follow suffices
            if (followEnabledRef.current === 'force') {
                followEnabledRef.current = true;
            }
        }
    }, [isLoading]);

    // ── Data changed: if pending, snap to bottom ──
    useEffect(() => {
        if (pendingScrollRef.current && messagesLength > 0) {
            pendingScrollRef.current = false;
            // Short timeout ensures Virtuoso has measured and rendered the new data
            // before we scroll. More reliable than double-RAF which is timing-dependent.
            const timer = setTimeout(() => {
                virtuosoRef.current?.scrollToIndex({ index: 'LAST' });
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [messagesLength]);

    // ── Public API ──

    const scrollToBottom = useCallback(() => {
        // 'force' makes followOutput return 'smooth' regardless of isAtBottom.
        // This handles the async gap: user clicks send → scrollToBottom fires →
        // SSE replay appends user message later → followOutput must keep tracking
        // even though Virtuoso doesn't yet consider us "at bottom".
        followEnabledRef.current = 'force';
        pendingScrollRef.current = false;
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
    }, []);

    const pauseAutoScroll = useCallback((duration = 500) => {
        followEnabledRef.current = false;
        if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
        pauseTimerRef.current = setTimeout(() => {
            followEnabledRef.current = true;
            pauseTimerRef.current = null;
        }, duration);
    }, []);

    // Cleanup
    useEffect(() => {
        return () => {
            if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
        };
    }, []);

    return { virtuosoRef, scrollerRef, followEnabledRef, scrollToBottom, pauseAutoScroll };
}
