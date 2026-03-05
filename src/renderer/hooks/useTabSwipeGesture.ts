import { useEffect, useRef, type RefObject } from 'react';
import type { Tab } from '@/types/tab';

interface UseTabSwipeGestureOptions {
  contentRef: RefObject<HTMLDivElement | null>;
  tabsRef: RefObject<Tab[]>;
  activeTabIdRef: RefObject<string | null>;
  onSwitchTab: (tabId: string) => void;
}

interface SwipeState {
  phase: 'idle' | 'tracking' | 'animating';
  direction: 'horizontal' | 'vertical' | null;
  offsetX: number;
  velocity: number;
  lastDeltaX: number;
  lastTimestamp: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  directionResetTimer: ReturnType<typeof setTimeout> | null; // reset vertical direction lock
  snapTimer: ReturnType<typeof setTimeout> | null;           // safety timeout for snap animation
  // DOM elements being manipulated during gesture
  currentEl: HTMLElement | null;
  adjacentEl: HTMLElement | null;
  adjacentIndex: number;
}

const IDLE_TIMEOUT = 150;          // ms — detect finger lift
const SWITCH_THRESHOLD_RATIO = 0.2; // 20% of container width
const VELOCITY_THRESHOLD = 500;     // px/s — fast swipe triggers switch
const RUBBER_BAND_MAX = 80;         // px — max rubber band stretch
const SNAP_DURATION = 300;          // ms
const SNAP_EASING = 'cubic-bezier(0.25, 1, 0.5, 1)';

export function useTabSwipeGesture({
  contentRef,
  tabsRef,
  activeTabIdRef,
  onSwitchTab,
}: UseTabSwipeGestureOptions) {
  const stateRef = useRef<SwipeState>({
    phase: 'idle',
    direction: null,
    offsetX: 0,
    velocity: 0,
    lastDeltaX: 0,
    lastTimestamp: 0,
    idleTimer: null,
    directionResetTimer: null,
    snapTimer: null,
    currentEl: null,
    adjacentEl: null,
    adjacentIndex: -1,
  });

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const state = stateRef.current;

    function getActiveIndex(): number {
      const tabs = tabsRef.current;
      const activeId = activeTabIdRef.current;
      return tabs.findIndex((t) => t.id === activeId);
    }

    function getTabEl(index: number): HTMLElement | null {
      const el = contentRef.current?.children[index] as HTMLElement | undefined;
      return el ?? null;
    }

    function resetState() {
      if (state.idleTimer !== null) {
        clearTimeout(state.idleTimer);
        state.idleTimer = null;
      }
      if (state.directionResetTimer !== null) {
        clearTimeout(state.directionResetTimer);
        state.directionResetTimer = null;
      }
      if (state.snapTimer !== null) {
        clearTimeout(state.snapTimer);
        state.snapTimer = null;
      }
      state.phase = 'idle';
      state.direction = null;
      state.offsetX = 0;
      state.velocity = 0;
      state.lastDeltaX = 0;
      state.lastTimestamp = 0;
      state.currentEl = null;
      state.adjacentEl = null;
      state.adjacentIndex = -1;
    }

    function cleanupDOM() {
      // Restore all children to their original state
      const cont = contentRef.current;
      if (!cont) return;
      for (let i = 0; i < cont.children.length; i++) {
        const el = cont.children[i] as HTMLElement;
        el.style.transform = '';
        el.style.transition = '';
      }
      // Restore adjacent tab visibility if it wasn't switched to
      if (state.adjacentEl) {
        const activeIdx = getActiveIndex();
        if (state.adjacentIndex !== activeIdx) {
          state.adjacentEl.classList.add('invisible');
          state.adjacentEl.classList.add('pointer-events-none');
          state.adjacentEl.style.contentVisibility = 'hidden';
        }
      }
    }

    function showAdjacentTab(el: HTMLElement) {
      el.classList.remove('invisible');
      el.classList.remove('pointer-events-none');
      el.style.contentVisibility = '';
    }

    function rubberBand(offset: number): number {
      // Diminishing return as offset grows
      const sign = Math.sign(offset);
      const abs = Math.abs(offset);
      const dampened = RUBBER_BAND_MAX * (1 - Math.exp(-abs / (RUBBER_BAND_MAX * 2)));
      return sign * dampened;
    }

    function animateSnap(commit: boolean, swipeDirection: -1 | 1) {
      state.phase = 'animating';
      const cont = contentRef.current;
      if (!cont) { resetState(); return; }

      const containerWidth = cont.clientWidth;
      const currentEl = state.currentEl;
      const adjacentEl = state.adjacentEl;

      if (!currentEl) { cleanupDOM(); resetState(); return; }

      if (commit && adjacentEl) {
        // Animate current tab off-screen, adjacent tab into view
        const currentTarget = -swipeDirection * containerWidth;
        const adjacentTarget = 0;

        currentEl.style.transition = `transform ${SNAP_DURATION}ms ${SNAP_EASING}`;
        adjacentEl.style.transition = `transform ${SNAP_DURATION}ms ${SNAP_EASING}`;
        currentEl.style.transform = `translateX(${currentTarget}px)`;
        adjacentEl.style.transform = `translateX(${adjacentTarget}px)`;

        const newTabId = tabsRef.current[state.adjacentIndex]?.id;

        let handled = false;
        const onEnd = () => {
          if (handled) return;
          handled = true;
          if (state.snapTimer !== null) {
            clearTimeout(state.snapTimer);
            state.snapTimer = null;
          }
          adjacentEl.removeEventListener('transitionend', onEnd);
          // Clean up all DOM modifications
          cleanupDOM();
          // Reset transforms — the new active tab will be shown by React state
          for (let i = 0; i < cont.children.length; i++) {
            const el = cont.children[i] as HTMLElement;
            el.style.transform = '';
            el.style.transition = '';
          }
          resetState();
          // Commit the switch via React state
          if (newTabId) {
            onSwitchTab(newTabId);
          }
        };
        adjacentEl.addEventListener('transitionend', onEnd, { once: true });
        state.snapTimer = setTimeout(onEnd, SNAP_DURATION + 50);
      } else {
        // Bounce back to original position
        currentEl.style.transition = `transform ${SNAP_DURATION}ms ${SNAP_EASING}`;
        currentEl.style.transform = 'translateX(0)';

        if (adjacentEl) {
          adjacentEl.style.transition = `transform ${SNAP_DURATION}ms ${SNAP_EASING}`;
          const adjacentBasePos = swipeDirection > 0 ? -containerWidth : containerWidth;
          adjacentEl.style.transform = `translateX(${adjacentBasePos}px)`;
        }

        const targetEl = adjacentEl ?? currentEl;
        let handled = false;
        const onEnd = () => {
          if (handled) return;
          handled = true;
          if (state.snapTimer !== null) {
            clearTimeout(state.snapTimer);
            state.snapTimer = null;
          }
          targetEl.removeEventListener('transitionend', onEnd);
          cleanupDOM();
          resetState();
        };
        targetEl.addEventListener('transitionend', onEnd, { once: true });
        state.snapTimer = setTimeout(onEnd, SNAP_DURATION + 50);
      }
    }

    function onIdle() {
      if (state.phase !== 'tracking') return;

      const cont = contentRef.current;
      if (!cont) { resetState(); return; }

      const containerWidth = cont.clientWidth;
      const threshold = containerWidth * SWITCH_THRESHOLD_RATIO;
      const shouldSwitch =
        (Math.abs(state.offsetX) > threshold || Math.abs(state.velocity) > VELOCITY_THRESHOLD) &&
        state.adjacentEl !== null;

      // Determine swipe direction: positive offsetX = swiping right = go to previous tab
      const swipeDir: -1 | 1 = state.offsetX > 0 ? 1 : -1;

      animateSnap(shouldSwitch, swipeDir);
    }

    function cancelOngoingAnimation() {
      // If animating, read current computed transform and continue from there
      if (state.currentEl) {
        const computedTransform = getComputedStyle(state.currentEl).transform;
        state.currentEl.style.transition = '';
        state.currentEl.style.transform = computedTransform === 'none' ? '' : computedTransform;
        // Parse translateX from matrix
        if (computedTransform && computedTransform !== 'none') {
          const match = computedTransform.match(/matrix.*\((.+)\)/);
          if (match) {
            const values = match[1].split(',').map(Number);
            state.offsetX = values[4] ?? 0; // translateX is the 5th value
          }
        }
      }
      if (state.adjacentEl) {
        const computedTransform = getComputedStyle(state.adjacentEl).transform;
        state.adjacentEl.style.transition = '';
        state.adjacentEl.style.transform = computedTransform === 'none' ? '' : computedTransform;
      }
      state.phase = 'tracking';
    }

    function handleWheel(e: WheelEvent) {
      const tabs = tabsRef.current;
      if (tabs.length <= 1) return;

      const cont = contentRef.current;
      if (!cont) return;

      const { deltaX, deltaY } = e;

      // Skip zero-motion events
      if (deltaX === 0 && deltaY === 0) return;

      // === Direction lock ===
      if (state.direction === null && state.phase !== 'animating') {
        // Determine direction from first meaningful wheel event
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);
        if (absX < 2 && absY < 2) return; // too small to determine

        if (absX > absY * 1.2) {
          state.direction = 'horizontal';
        } else {
          state.direction = 'vertical';
          return; // let vertical scroll happen normally
        }
      }

      if (state.direction === 'vertical') {
        // Reset direction lock after idle so future horizontal swipes work
        if (state.directionResetTimer !== null) {
          clearTimeout(state.directionResetTimer);
        }
        state.directionResetTimer = setTimeout(() => {
          state.direction = null;
          state.directionResetTimer = null;
        }, IDLE_TIMEOUT);
        return;
      }

      // Horizontal swipe detected — prevent default scroll behavior
      e.preventDefault();

      // === Handle interrupting an ongoing animation ===
      if (state.phase === 'animating') {
        cancelOngoingAnimation();
      }

      // === Initialize tracking ===
      const now = performance.now();
      const activeIndex = getActiveIndex();
      if (activeIndex === -1) return;

      if (state.phase === 'idle') {
        state.phase = 'tracking';
        state.offsetX = 0;
        state.velocity = 0;
        state.currentEl = getTabEl(activeIndex);
        state.adjacentEl = null;
        state.adjacentIndex = -1;
        state.lastTimestamp = now;
      }

      // === Accumulate offset ===
      // macOS wheel deltaX: positive = scroll right (content moves left) = swipe left
      // We want: swipe left = go to next tab, so offsetX negative = next tab
      state.offsetX -= deltaX;

      // === Calculate velocity ===
      const dt = now - state.lastTimestamp;
      if (dt > 0) {
        state.velocity = -deltaX / (dt / 1000);
      }
      state.lastDeltaX = deltaX;
      state.lastTimestamp = now;

      // === Determine adjacent tab ===
      const containerWidth = cont.clientWidth;
      const desiredAdjacentIndex = state.offsetX > 0
        ? activeIndex - 1  // swiping right → previous tab
        : activeIndex + 1; // swiping left → next tab

      const isAtBoundary = desiredAdjacentIndex < 0 || desiredAdjacentIndex >= tabs.length;

      // Update adjacent tab element if direction changed
      if (!isAtBoundary && state.adjacentIndex !== desiredAdjacentIndex) {
        // Hide previous adjacent if any
        if (state.adjacentEl && state.adjacentIndex !== activeIndex) {
          state.adjacentEl.style.transform = '';
          state.adjacentEl.classList.add('invisible');
          state.adjacentEl.classList.add('pointer-events-none');
          state.adjacentEl.style.contentVisibility = 'hidden';
        }
        state.adjacentIndex = desiredAdjacentIndex;
        state.adjacentEl = getTabEl(desiredAdjacentIndex);
        if (state.adjacentEl) {
          showAdjacentTab(state.adjacentEl);
        }
      }

      // === Apply transforms ===
      let effectiveOffset = state.offsetX;
      if (isAtBoundary) {
        effectiveOffset = rubberBand(state.offsetX);
        // Hide adjacent if we're at boundary (no adjacent to show)
        if (state.adjacentEl && state.adjacentIndex !== activeIndex) {
          state.adjacentEl.style.transform = '';
          state.adjacentEl.classList.add('invisible');
          state.adjacentEl.classList.add('pointer-events-none');
          state.adjacentEl.style.contentVisibility = 'hidden';
          state.adjacentEl = null;
          state.adjacentIndex = -1;
        }
      }

      if (state.currentEl) {
        state.currentEl.style.transform = `translateX(${effectiveOffset}px)`;
      }
      if (state.adjacentEl && !isAtBoundary) {
        // Position adjacent tab off-screen in the correct direction
        const adjacentOffset = state.offsetX > 0
          ? -containerWidth + effectiveOffset  // coming from the left
          : containerWidth + effectiveOffset;   // coming from the right
        state.adjacentEl.style.transform = `translateX(${adjacentOffset}px)`;
      }

      // === Reset idle timer ===
      if (state.idleTimer !== null) {
        clearTimeout(state.idleTimer);
      }
      state.idleTimer = setTimeout(onIdle, IDLE_TIMEOUT);
    }

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheel);
      cleanupDOM();
      resetState(); // clears all timers (idleTimer, directionResetTimer, snapTimer)
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable
  }, []);
}
