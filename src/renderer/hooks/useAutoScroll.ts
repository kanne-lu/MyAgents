import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import { isDebugMode } from '@/utils/debug';

// Smooth scroll configuration
const SCROLL_SPEED_PX_PER_MS = 2.5;      // Base scroll speed (pixels per millisecond)
const MAX_SCROLL_SPEED_PX_PER_MS = 8;    // Maximum scroll speed when far behind
const SPEED_RAMP_DISTANCE = 200;          // Distance at which speed starts ramping up
const SNAP_THRESHOLD_PX = 3;              // Snap to bottom when this close

// Content-aware scroll constants
const MSG_TOP_GAP = 80;          // px between user message top and viewport top
const CONTENT_BOTTOM_GAP = 80;   // px between content end and viewport bottom during follow

// Idle spacer height — MUST match MessageList's idle spacer minHeight
export const IDLE_SPACER_HEIGHT = 80;

// Spacer collapse animation duration (ms)
const COLLAPSE_DURATION_MS = 400;
// Collapse guard duration — MUST be > COLLAPSE_DURATION_MS to prevent animation restart
const COLLAPSE_GUARD_MS = 600;

const LOG = '[autoScroll]';

export interface AutoScrollControls {
  containerRef: RefObject<HTMLDivElement | null>;
  /** Ref for the bottom spacer element — attach to the spacer in MessageList */
  spacerRef: RefObject<HTMLDivElement | null>;
  /**
   * Temporarily pause auto-scroll (e.g., during collapse animations)
   * @param duration Duration in ms to pause (default: 250ms)
   */
  pauseAutoScroll: (duration?: number) => void;
  /**
   * Smooth scroll to position user message near viewport top.
   * Uses content-aware targeting: max(userMsgTop - gap, contentEnd - viewport + gap)
   * which naturally transitions to content-following as AI response grows.
   */
  scrollToBottom: () => void;
  /**
   * Instantly scroll to bottom without animation
   * Use this when switching sessions to avoid slow scroll through all messages
   */
  scrollToBottomInstant: () => void;
}

export function useAutoScroll(
  isLoading: boolean,
  messagesLength: number,
  sessionId?: string | null
): AutoScrollControls {
  const containerRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const isAutoScrollEnabledRef = useRef(true);
  const isPausedRef = useRef(false);
  const pauseTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastScrollHeightRef = useRef<number>(0);

  // Smooth scroll animation state
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const isAnimatingRef = useRef(false);

  // Collapse animation state (separate from content-following animation)
  const collapseAnimFrameRef = useRef<number | null>(null);

  // Keep isLoading in a ref so animation loop can access it
  const isLoadingRef = useRef(isLoading);
  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  // Track scroll position to detect user scroll direction
  const lastScrollTopRef = useRef(0);

  // Track session ID to detect session switch
  // Initialize as undefined so first render triggers isInitialLoad
  const lastSessionIdRef = useRef<string | null | undefined>(undefined);

  // Flag to indicate we need to scroll to bottom after messages load
  const pendingScrollRef = useRef(false);

  // Store animation function in ref for recursive RAF calls (avoids lint warning about self-reference)
  const animateSmoothScrollRef = useRef<(() => void) | null>(null);

  // Content-aware scroll state
  // When true, scroll targets user message position instead of absolute bottom
  const isContentAwareRef = useRef(false);
  // Cached offsetTop of the last user message for animation loop (avoids DOM query per frame)
  const lastUserMsgTopRef = useRef(0);

  // Collapse guard — prevents content-following animation restart during spacer collapse.
  // When loading ends, the spacer collapses from its dynamic height to 80px.
  // Without this guard, ResizeObserver / messagesLength effects would restart
  // the content-following animation, chasing the shrinking spacer.
  const isCollapsingRef = useRef(false);
  const collapseTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Track previous isLoading to only fire collapse guard on true→false transition
  const prevIsLoadingRef = useRef(false);

  const clearCollapseGuard = useCallback(() => {
    isCollapsingRef.current = false;
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  const cancelAnimation = useCallback(() => {
    if (animationFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    isAnimatingRef.current = false;
  }, []);

  const cancelCollapseAnimation = useCallback(() => {
    if (collapseAnimFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(collapseAnimFrameRef.current);
      collapseAnimFrameRef.current = null;
    }
  }, []);

  // When loading finishes (true→false): collapse the spacer back to idle height.
  // Uses a single JS RAF animation that decides per-frame how to handle scroll:
  //   - If user is near bottom → pin scrollTop to maxScrollTop (smooth follow)
  //   - If user is scrolled up → preserve scrollTop (invisible collapse)
  // This per-frame check is more robust than a one-time flag check because:
  //   1. `isAutoScrollEnabledRef` can be false even when the user is at bottom
  //      (they scrolled up then back down manually — auto-scroll stays disabled)
  //   2. The user might scroll during the 400ms animation, changing their position
  // Only fires on true→false transition — not on initial mount when isLoading starts as false.
  useEffect(() => {
    const wasLoading = prevIsLoadingRef.current;
    prevIsLoadingRef.current = isLoading;

    if (!isLoading && wasLoading) {
      isContentAwareRef.current = false;
      cancelAnimation();
      cancelCollapseAnimation();

      const container = containerRef.current;
      const spacer = spacerRef.current;

      if (container && spacer) {
        // Read current JS-set height (React's style prop is always IDLE_SPACER_HEIGHT,
        // but the animation loop overrides it via direct DOM manipulation during loading)
        const currentHeight = parseFloat(spacer.style.minHeight) || IDLE_SPACER_HEIGHT;

        if (currentHeight <= IDLE_SPACER_HEIGHT) {
          // Already at idle height — ensure exact value (no floating-point drift)
          spacer.style.minHeight = `${IDLE_SPACER_HEIGHT}px`;
        } else {
          // Animate collapse.
          // Use auto-scroll enabled state (set by user behavior) as the pin-to-bottom flag.
          // This is robust against DOM changes from React re-renders (AssistantActions appearing,
          // thinking blocks collapsing) which shift scrollHeight and break per-frame maxScrollTop checks.
          const shouldPinToBottom = isAutoScrollEnabledRef.current;
          const fromHeight = currentHeight;
          const startTime = performance.now();

          const tick = () => {
            // Calculate new spacer height
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / COLLAPSE_DURATION_MS, 1);
            // ease-out quadratic: decelerates smoothly
            const eased = 1 - (1 - progress) * (1 - progress);
            // Use exact IDLE_SPACER_HEIGHT on final frame to avoid rounding drift
            const newHeight = progress < 1
              ? Math.round(fromHeight + (IDLE_SPACER_HEIGHT - fromHeight) * eased)
              : IDLE_SPACER_HEIGHT;

            const savedScrollTop = container.scrollTop;
            spacer.style.minHeight = `${newHeight}px`;

            if (shouldPinToBottom) {
              // Auto-scroll was active → pin to new bottom (smooth follow)
              container.scrollTop = container.scrollHeight - container.clientHeight;
            } else {
              // User had scrolled up → preserve viewport position (invisible collapse)
              container.scrollTop = savedScrollTop;
            }

            if (progress < 1) {
              collapseAnimFrameRef.current = requestAnimationFrame(tick);
            } else {
              collapseAnimFrameRef.current = null;
            }
          };

          collapseAnimFrameRef.current = requestAnimationFrame(tick);
        }
      }

      // Enter collapse guard — prevents ResizeObserver from restarting
      // the content-following animation during the spacer collapse.
      isCollapsingRef.current = true;
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = setTimeout(() => {
        isCollapsingRef.current = false;
        collapseTimerRef.current = null;
      }, COLLAPSE_GUARD_MS);
    } else if (isLoading && !wasLoading) {
      // Loading started — clear any leftover collapse guard / animation.
      // Also normalize spacer height in case a previous collapse was interrupted mid-way.
      clearCollapseGuard();
      cancelCollapseAnimation();
      const spacer = spacerRef.current;
      if (spacer) {
        const h = parseFloat(spacer.style.minHeight) || IDLE_SPACER_HEIGHT;
        if (h !== IDLE_SPACER_HEIGHT) spacer.style.minHeight = `${IDLE_SPACER_HEIGHT}px`;
      }
    }
  }, [isLoading, cancelAnimation, cancelCollapseAnimation, clearCollapseGuard]);

  /** Update cached position of the last user message in DOM */
  const updateLastUserMsgTop = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const msgs = el.querySelectorAll('[data-role="user"]');
    const last = msgs[msgs.length - 1] as HTMLElement | null;
    if (last) {
      lastUserMsgTopRef.current = last.offsetTop;
    }
  }, []);

  /**
   * Pause auto-scroll temporarily (useful during collapse animations)
   */
  const pauseAutoScroll = useCallback((duration = 250) => {
    isPausedRef.current = true;
    cancelAnimation();
    if (pauseTimerRef.current) {
      clearTimeout(pauseTimerRef.current);
    }
    pauseTimerRef.current = setTimeout(() => {
      isPausedRef.current = false;
      pauseTimerRef.current = null;
    }, duration);
  }, [cancelAnimation]);

  /**
   * Smooth scroll animation using RAF.
   *
   * In content-aware mode (after user sends a message):
   *   target = max(userMsgTop - MSG_TOP_GAP, contentEnd - viewport + CONTENT_BOTTOM_GAP)
   *   This naturally transitions from "user message at viewport top" to
   *   "follow AI content bottom" as the AI response grows past one viewport.
   *
   * In normal mode: target = absolute bottom (scrollHeight - clientHeight).
   *
   * Keeps running during loading (even when at target) to catch new content.
   */
  const animateSmoothScroll = useCallback(() => {
    if (!isAutoScrollEnabledRef.current || isPausedRef.current) {
      isAnimatingRef.current = false;
      return;
    }

    const element = containerRef.current;
    if (!element) {
      isAnimatingRef.current = false;
      return;
    }

    // Calculate scroll target based on mode
    let targetScrollTop: number;

    if (isContentAwareRef.current) {
      // Content-aware: position user message near top, transition to follow content
      const spacer = spacerRef.current;
      const contentEnd = spacer ? spacer.offsetTop : element.scrollHeight;

      const userMsgTarget = lastUserMsgTopRef.current > 0
        ? lastUserMsgTopRef.current - MSG_TOP_GAP
        : 0;
      const contentFollowTarget = contentEnd - element.clientHeight + CONTENT_BOTTOM_GAP;

      // max() naturally transitions from msg-at-top to content-follow
      const naturalTarget = Math.max(userMsgTarget, contentFollowTarget);

      // Dynamically size spacer to provide JUST ENOUGH scroll room for the target.
      // This avoids the huge empty space below short conversations.
      // Required: maxScrollTop >= naturalTarget
      //   contentEnd + spacerHeight + 1 - clientHeight >= naturalTarget
      //   spacerHeight >= naturalTarget + clientHeight - contentEnd - 1
      if (spacer) {
        const requiredHeight = naturalTarget + element.clientHeight - contentEnd;
        const newHeight = Math.max(IDLE_SPACER_HEIGHT, Math.ceil(requiredHeight));
        spacer.style.minHeight = `${newHeight}px`;
      }

      // Read maxScrollTop AFTER spacer resize (forces one layout reflow per frame — normal for RAF)
      const maxScrollTop = element.scrollHeight - element.clientHeight;
      targetScrollTop = Math.max(0, Math.min(naturalTarget, maxScrollTop));
    } else {
      // Normal mode: absolute bottom
      const maxScrollTop = element.scrollHeight - element.clientHeight;
      targetScrollTop = maxScrollTop;
    }

    const currentScrollTop = element.scrollTop;
    const distance = targetScrollTop - currentScrollTop;

    // Helper: schedule next RAF frame
    const keepAlive = () => {
      if (animateSmoothScrollRef.current) {
        animationFrameRef.current = requestAnimationFrame(animateSmoothScrollRef.current);
      }
    };

    // Should the animation loop stay alive even when at target?
    // Content-aware mode: YES — we're waiting for new content / spacer expansion.
    // Normal mode during loading: YES — new streaming content may arrive.
    // Otherwise: NO — nothing to wait for.
    const shouldKeepAlive = isContentAwareRef.current || isLoadingRef.current;

    // Target is above current position — NEVER scroll up programmatically.
    // Scrolling up triggers the scroll handler's "user scrolled up" detection,
    // which permanently disables auto-scroll. Just wait for target to catch up.
    if (distance < 0) {
      if (shouldKeepAlive) { keepAlive(); return; }
      isAnimatingRef.current = false;
      return;
    }

    // At target (or very close) — snap to exact position
    if (distance <= SNAP_THRESHOLD_PX) {
      element.scrollTop = targetScrollTop;
      if (shouldKeepAlive) { keepAlive(); return; }
      isAnimatingRef.current = false;
      return;
    }

    const now = performance.now();
    const deltaTime = lastFrameTimeRef.current ? now - lastFrameTimeRef.current : 16;
    lastFrameTimeRef.current = now;

    // Calculate adaptive scroll speed - faster when far behind
    let speed = SCROLL_SPEED_PX_PER_MS;
    if (distance > SPEED_RAMP_DISTANCE) {
      const speedMultiplier = Math.min(distance / SPEED_RAMP_DISTANCE, MAX_SCROLL_SPEED_PX_PER_MS / SCROLL_SPEED_PX_PER_MS);
      speed = SCROLL_SPEED_PX_PER_MS * speedMultiplier;
    }

    // Calculate scroll amount for this frame
    const scrollAmount = speed * deltaTime;

    // Don't overshoot
    const newScrollTop = Math.min(currentScrollTop + scrollAmount, targetScrollTop);
    element.scrollTop = newScrollTop;

    // Continue animation via ref (avoids lint warning about self-reference in useCallback)
    if (animateSmoothScrollRef.current) {
      animationFrameRef.current = requestAnimationFrame(animateSmoothScrollRef.current);
    }
  }, []);

  // Keep ref updated with latest function
  useEffect(() => {
    animateSmoothScrollRef.current = animateSmoothScroll;
  }, [animateSmoothScroll]);

  /**
   * Start smooth scroll animation (or continue if already running)
   */
  const startSmoothScroll = useCallback(() => {
    if (!isAutoScrollEnabledRef.current || isPausedRef.current) return;
    // Block during spacer collapse to prevent chasing the shrinking spacer
    if (isCollapsingRef.current) return;
    // If already animating, just let it continue - it will catch up
    if (isAnimatingRef.current) return;

    isAnimatingRef.current = true;
    lastFrameTimeRef.current = performance.now();
    animationFrameRef.current = requestAnimationFrame(animateSmoothScroll);
  }, [animateSmoothScroll]);

  /**
   * Instant scroll to bottom (used for initial load, session switch, or large jumps)
   * Also re-enables auto-scroll and cancels any ongoing animation
   */
  const scrollToBottomInstant = useCallback(() => {
    const element = containerRef.current;
    if (!element) {
      if (isDebugMode()) {
        console.log(LOG, 'scrollToBottomInstant: no container element');
      }
      return;
    }

    // Cancel any ongoing animations (content-following + collapse)
    cancelAnimation();
    cancelCollapseAnimation();
    clearCollapseGuard();

    // Re-enable auto-scroll, use absolute bottom (not content-aware)
    isAutoScrollEnabledRef.current = true;
    isPausedRef.current = false;
    isContentAwareRef.current = false;

    // Reset spacer to idle height (may have been mid-collapse)
    const spacer = spacerRef.current;
    if (spacer) spacer.style.minHeight = `${IDLE_SPACER_HEIGHT}px`;

    // Instant scroll without animation
    element.scrollTop = element.scrollHeight;

    if (isDebugMode()) {
      console.log(LOG, 'scrollToBottomInstant →', element.scrollTop);
    }
  }, [cancelAnimation, cancelCollapseAnimation, clearCollapseGuard]);

  /**
   * Smooth scroll to position user message near viewport top.
   * Enables content-aware mode with dual-target formula:
   *   max(userMsgTop - 80, contentEnd - viewport + 80)
   * No instant jump — the smooth animation handles the transition.
   */
  const scrollToBottom = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;

    // Re-enable auto-scroll regardless of current state
    isAutoScrollEnabledRef.current = true;
    isPausedRef.current = false;

    // Cancel any pending session-init scroll — user sending a message takes priority
    pendingScrollRef.current = false;

    // Clear collapse guard and animations — user action takes priority
    clearCollapseGuard();
    cancelAnimation();
    cancelCollapseAnimation();

    // Enable content-aware targeting.
    // The actual scroll happens in the messagesLength effect when the new user message
    // appears in DOM (via SSE replay). This is intentional — at this point the new message
    // isn't in DOM yet, so there's nothing to scroll to. The messagesLength effect starts
    // the RAF animation which smoothly scrolls the user message toward viewport top.
    isContentAwareRef.current = true;

    if (isDebugMode()) {
      console.log(LOG, 'scrollToBottom: set content-aware, waiting for new msg in DOM');
    }
  }, [cancelAnimation, cancelCollapseAnimation, clearCollapseGuard]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimation();
      cancelCollapseAnimation();
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    };
  }, [cancelAnimation, cancelCollapseAnimation]);

  // Handle session switch - use sessionId for reliable detection
  useEffect(() => {
    const previousSessionId = lastSessionIdRef.current;
    const isSessionSwitch = previousSessionId !== undefined && sessionId !== previousSessionId;
    const isInitialLoad = previousSessionId === undefined && sessionId !== undefined;

    // Update tracked session ID
    lastSessionIdRef.current = sessionId;

    if (isDebugMode()) {
      console.log(LOG, 'sessionId changed:', {
        previousSessionId,
        currentSessionId: sessionId,
        isSessionSwitch,
        isInitialLoad,
        isAutoScrollEnabled: isAutoScrollEnabledRef.current,
      });
    }

    if (isSessionSwitch || isInitialLoad) {
      // Mark that we need to scroll when messages load
      // Don't scroll immediately because messages may not be in DOM yet
      if (isDebugMode()) {
        console.log(LOG, 'Session switch detected, setting pending scroll flag');
      }
      pendingScrollRef.current = true;
    }
  }, [sessionId]);

  // Handle messages change - scroll to bottom if pending, otherwise smooth scroll
  // Uses messagesLength (primitive) instead of messages (object reference) to avoid
  // re-running on every SSE chunk that only mutates the last message's content.
  useEffect(() => {
    if (messagesLength === 0) return;

    // If we have a pending scroll from session switch, do instant scroll.
    // BUT: content-aware mode takes priority — it means the user just sent a message
    // and the sessionId change is just the session being created for that message.
    // Without this guard, the sequence scrollToBottom() → sessionId change → pendingScroll=true
    // would override content-aware mode and instant-scroll to absolute bottom.
    if (pendingScrollRef.current && !isContentAwareRef.current) {
      pendingScrollRef.current = false;
      if (isDebugMode()) {
        console.log(LOG, 'Messages loaded with pending scroll, executing scrollToBottomInstant');
      }
      // Use RAF to ensure DOM has rendered the messages
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToBottomInstant();
        });
      });
      return;
    }
    pendingScrollRef.current = false; // clear stale flag if content-aware took priority

    // Content-aware mode: update cached user message position, size spacer, start animation.
    // The animation loop dynamically sizes the spacer each frame as content grows,
    // but we also set it here for the initial frame (before the first RAF callback).
    if (isContentAwareRef.current && isAutoScrollEnabledRef.current) {
      updateLastUserMsgTop();

      // Set initial spacer height so the first animation frame has correct scrollHeight
      const el = containerRef.current;
      const spacer = spacerRef.current;
      if (el && spacer) {
        const userMsgTarget = lastUserMsgTopRef.current > 0
          ? lastUserMsgTopRef.current - MSG_TOP_GAP : 0;
        const contentEnd = spacer.offsetTop;
        const contentFollowTarget = contentEnd - el.clientHeight + CONTENT_BOTTOM_GAP;
        const naturalTarget = Math.max(userMsgTarget, contentFollowTarget);
        const requiredHeight = naturalTarget + el.clientHeight - contentEnd;
        spacer.style.minHeight = `${Math.max(IDLE_SPACER_HEIGHT, Math.ceil(requiredHeight))}px`;
      }

      if (isDebugMode()) {
        console.log(LOG, 'content-aware: start animation, msgTop=', lastUserMsgTopRef.current);
      }
      cancelAnimation();
      startSmoothScroll();
      return;
    }

    // Normal message change - use smooth scroll if enabled
    if (isAutoScrollEnabledRef.current) {
      startSmoothScroll();
    }
  }, [messagesLength, startSmoothScroll, scrollToBottomInstant, updateLastUserMsgTop, cancelAnimation]);

  // Start smooth scroll when loading starts
  // (Stop is handled by the isContentAwareRef cleanup effect above via cancelAnimation)
  useEffect(() => {
    if (isLoading && isAutoScrollEnabledRef.current) {
      startSmoothScroll();
    }
  }, [isLoading, startSmoothScroll]);

  // Handle user scroll - detect scroll direction to distinguish user vs programmatic scroll
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    // Initialize last scroll position
    lastScrollTopRef.current = element.scrollTop;

    const handleScroll = () => {
      const currentScrollTop = element.scrollTop;
      const scrollDelta = currentScrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = currentScrollTop;

      // User scrolled UP (negative delta) - immediately disable auto-scroll.
      // Threshold of -5px avoids triggering on sub-pixel fluctuations.
      // Once disabled, auto-scroll is ONLY re-enabled by explicit user actions:
      // scrollToBottom() (send message) or scrollToBottomInstant() (session switch).
      // This matches ChatGPT/Claude behavior — scrolling back down does NOT
      // auto-resume streaming follow. Prevents the "scroll fight" where the
      // animation and user input compete for scroll position.
      //
      // IMPORTANT: Distinguish real user scroll-up from browser clamping.
      // When the spacer shrinks (animation dynamic sizing or React re-render),
      // scrollHeight decreases. If scrollTop > new maxScrollTop, the browser
      // clamps scrollTop to maxScrollTop. After clamping, scrollTop === maxScrollTop.
      // We must NOT interpret this as user scroll-up.
      if (scrollDelta < -5) {
        const maxST = element.scrollHeight - element.clientHeight;
        const wasClamped = Math.abs(currentScrollTop - maxST) < 2;
        if (isAutoScrollEnabledRef.current && !wasClamped) {
          isAutoScrollEnabledRef.current = false;
          cancelAnimation();
          if (isDebugMode()) {
            console.log(LOG, 'user scroll up detected, auto-scroll disabled, delta=', scrollDelta);
          }
        }
      }
    };

    element.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      element.removeEventListener('scroll', handleScroll);
    };
  }, [cancelAnimation]);

  // ResizeObserver - trigger smooth scroll when content grows
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const element = containerRef.current;
    if (!element) return;

    // Initialize last height
    lastScrollHeightRef.current = element.scrollHeight;

    const resizeObserver = new ResizeObserver(() => {
      if (!isAutoScrollEnabledRef.current || isPausedRef.current) return;

      const currentHeight = element.scrollHeight;
      const heightDelta = currentHeight - lastScrollHeightRef.current;

      // Only trigger scroll when height increases (new content added)
      // The animation loop will decide whether to actually scroll based on mode
      if (heightDelta > 0) {
        startSmoothScroll();
      }

      lastScrollHeightRef.current = currentHeight;
    });

    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [startSmoothScroll]);

  // Note: Initial scroll is handled by the messages change effect (isInitialLoad case)
  // No separate mount effect needed - it would cause duplicate scroll calls

  return { containerRef, spacerRef, pauseAutoScroll, scrollToBottom, scrollToBottomInstant };
}
