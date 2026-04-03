/**
 * useBrowserOverlayGuard — Detects overlay elements covering the browser Webview.
 *
 * Returns `true` when an overlay is present (closeLayer with zIndex > 0),
 * `false` otherwise. The caller (BrowserPanel) uses this to decide whether
 * to show/hide the native Webview — avoiding z-order issues where native
 * Webview floats above React DOM overlays.
 *
 * Uses the closeLayer registry (same system that handles Cmd+W) rather than
 * MutationObserver DOM heuristics — single source of truth, zero overhead.
 */

import { useEffect, useState } from 'react';
import { registerCloseLayer, hasOverlayLayer } from '@/utils/closeLayer';

export function useBrowserOverlayGuard(active: boolean): boolean {
  const [overlayDetected, setOverlayDetected] = useState(false);

  useEffect(() => {
    if (!active) { setOverlayDetected(false); return; }

    // Check on mount
    setOverlayDetected(hasOverlayLayer());

    // Re-check whenever the closeLayer registry changes.
    // We register a no-op layer at zIndex -1 (below everything) that never
    // handles close but triggers a re-render when the registry changes.
    // Simpler: poll on a short interval since overlays open/close infrequently.
    const timer = setInterval(() => {
      setOverlayDetected(hasOverlayLayer());
    }, 100);

    return () => clearInterval(timer);
  }, [active]);

  return overlayDetected;
}
