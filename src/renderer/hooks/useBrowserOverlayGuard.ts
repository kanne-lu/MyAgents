/**
 * useBrowserOverlayGuard — Detects overlay elements covering the browser Webview.
 *
 * Returns `true` when a fixed + backdrop-blur overlay is present, `false` otherwise.
 * The caller (BrowserPanel) uses this in a combined visibility effect to decide
 * whether to show/hide the native Webview — avoiding dual-actor show/hide conflicts.
 *
 * Detection: Elements matching `position: fixed` + `backdrop-filter: blur`
 * OR having `data-suppress-browser` attribute.
 */

import { useEffect, useRef, useState } from 'react';

export function useBrowserOverlayGuard(active: boolean): boolean {
  const [overlayDetected, setOverlayDetected] = useState(false);
  const rafIdRef = useRef(0);

  useEffect(() => {
    if (!active) return;

    const isOverlayBackdrop = (el: Element): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.hasAttribute('data-suppress-browser')) return true;
      const style = getComputedStyle(el);
      return (
        style.position === 'fixed' &&
        style.backdropFilter !== 'none' &&
        style.backdropFilter.includes('blur')
      );
    };

    const sync = () => {
      const candidates = document.querySelectorAll(
        '[class*="backdrop-blur"], [data-suppress-browser]',
      );
      let hasOverlay = false;
      for (const el of candidates) {
        if (isOverlayBackdrop(el)) {
          hasOverlay = true;
          break;
        }
      }
      setOverlayDetected(hasOverlay);
    };

    // Debounce via rAF to avoid layout thrashing during streaming
    const debouncedSync = () => {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(sync);
    };

    const observer = new MutationObserver(debouncedSync);
    observer.observe(document.body, { childList: true, subtree: true });

    // Initial check
    sync();

    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafIdRef.current);
    };
  }, [active]);

  return overlayDetected;
}
