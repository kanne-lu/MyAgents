/**
 * BrowserPanel — Embedded browser preview panel for the split view.
 *
 * Renders a navigation toolbar + a placeholder container. The actual
 * web content is rendered by a native Tauri child Webview positioned
 * over the placeholder using absolute coordinates (OS-level overlay).
 *
 * Coordinate sync via ResizeObserver ensures the native Webview
 * follows React layout changes (resize, split ratio drag, etc.).
 *
 * All show/hide logic is consolidated in a single effect to avoid
 * dual-actor conflicts (visibility + overlay guard + drag state).
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ChevronLeft, ChevronRight, RotateCw, ExternalLink, Loader2, Globe } from 'lucide-react';
import { openExternal } from '@/utils/openExternal';
import { useBrowserOverlayGuard } from '@/hooks/useBrowserOverlayGuard';
import Tip from '@/components/Tip';

interface BrowserPanelProps {
  tabId: string;
  url: string | null;
  /** Whether this panel should be visible (includes isActive + splitActiveView + splitPanelVisible) */
  isVisible: boolean;
  isDraggingSplit: boolean;
  browserAlive: boolean;
  onBrowserCreated: () => void;
  onCreateFailed: () => void;
}

export default function BrowserPanel({
  tabId,
  url,
  isVisible,
  isDraggingSplit,
  browserAlive,
  onBrowserCreated,
  onCreateFailed,
}: BrowserPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentUrl, setCurrentUrl] = useState(url ?? '');
  const [isLoading, setIsLoading] = useState(false);
  const creatingRef = useRef(false);

  // Overlay detection — returns true when modal/overlay is on screen
  const overlayDetected = useBrowserOverlayGuard(browserAlive);

  // Track the last URL we told the webview to load (avoid duplicate navigations)
  const lastRequestedUrlRef = useRef<string | null>(null);

  // ── Create or navigate webview when url prop changes ──
  // Uses cancelled flag pattern (like TerminalPanel) to prevent leaks
  // if the component unmounts during in-flight creation.
  useEffect(() => {
    if (!url) return;
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;

    if (!browserAlive && !creatingRef.current) {
      // First URL — create webview
      creatingRef.current = true;
      lastRequestedUrlRef.current = url;
      const rect = el.getBoundingClientRect();

      invoke('cmd_browser_create', {
        tabId,
        url,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })
        .then(() => {
          if (cancelled) {
            // Component unmounted during creation — destroy the orphaned webview
            invoke('cmd_browser_close', { tabId }).catch(() => {});
            return;
          }
          onBrowserCreated();
        })
        .catch((err) => {
          console.error('[browser] Create failed:', err);
          if (!cancelled) onCreateFailed();
        })
        .finally(() => {
          creatingRef.current = false;
        });
    } else if (browserAlive && url !== lastRequestedUrlRef.current) {
      // Subsequent URL change — navigate existing webview
      lastRequestedUrlRef.current = url;
      invoke('cmd_browser_navigate', { tabId, url }).catch(() => {});
    }

    return () => { cancelled = true; };
  }, [url, browserAlive, tabId, onBrowserCreated, onCreateFailed]);

  // ── Listen for URL/loading events from Rust ──
  // Uses cancelled flag to prevent listener leaks on fast unmount.
  useEffect(() => {
    if (!browserAlive) return;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    (async () => {
      const u1 = await listen<string>(`browser:url-changed:${tabId}`, (event) => {
        if (!cancelled) setCurrentUrl(event.payload);
      });
      if (cancelled) { u1(); return; }
      unlisteners.push(u1);

      const u2 = await listen<boolean>(`browser:loading:${tabId}`, (event) => {
        if (!cancelled) setIsLoading(event.payload);
      });
      if (cancelled) { u2(); return; }
      unlisteners.push(u2);
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [browserAlive, tabId]);

  // ── ResizeObserver: sync native webview position with React layout ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !browserAlive) return;

    const syncBounds = () => {
      const rect = el.getBoundingClientRect();
      invoke('cmd_browser_resize', {
        tabId,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }).catch(() => {});
    };

    const observer = new ResizeObserver(syncBounds);
    observer.observe(el);
    window.addEventListener('resize', syncBounds);

    // Initial sync
    syncBounds();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
    };
  }, [browserAlive, tabId]);

  // ── Consolidated show/hide — single actor for all visibility factors ──
  useEffect(() => {
    if (!browserAlive) return;

    const shouldShow = isVisible && !isDraggingSplit && !overlayDetected;

    if (shouldShow) {
      invoke('cmd_browser_show', { tabId }).catch(() => {});
      // Re-sync position after becoming visible
      const el = containerRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        invoke('cmd_browser_resize', {
          tabId,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }).catch(() => {});
      }
    } else {
      invoke('cmd_browser_hide', { tabId }).catch(() => {});
    }
  }, [isVisible, isDraggingSplit, overlayDetected, browserAlive, tabId]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    const tid = tabId;
    return () => {
      invoke('cmd_browser_close', { tabId: tid }).catch(() => {});
    };
  }, [tabId]);

  // ── Navigation handlers ──
  const handleGoBack = useCallback(() => {
    invoke('cmd_browser_go_back', { tabId }).catch(() => {});
  }, [tabId]);

  const handleGoForward = useCallback(() => {
    invoke('cmd_browser_go_forward', { tabId }).catch(() => {});
  }, [tabId]);

  const handleReload = useCallback(() => {
    invoke('cmd_browser_reload', { tabId }).catch(() => {});
  }, [tabId]);

  const handleOpenExternal = useCallback(() => {
    if (currentUrl) openExternal(currentUrl);
  }, [currentUrl]);

  // Extract display hostname from URL
  const displayUrl = currentUrl
    ? (() => {
        try {
          return new URL(currentUrl).hostname || currentUrl;
        } catch {
          return currentUrl;
        }
      })()
    : '';

  const navBtnClass =
    'flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]';
  const navBtnDisabled =
    'flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] opacity-30 cursor-not-allowed';

  return (
    <div className="flex h-full flex-col">
      {/* Navigation toolbar */}
      <div className="relative flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-[var(--line)] bg-[var(--paper)] px-2">
        <Tip label="后退" position="bottom">
          <button type="button" className={navBtnClass} onClick={handleGoBack}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </Tip>
        <Tip label="前进" position="bottom">
          <button type="button" className={navBtnClass} onClick={handleGoForward}>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </Tip>
        <Tip label={isLoading ? '停止' : '刷新'} position="bottom">
          <button type="button" className={navBtnClass} onClick={handleReload}>
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
          </button>
        </Tip>

        {/* URL display */}
        <span
          className="ml-2 min-w-0 flex-1 truncate text-[12px] text-[var(--ink-muted)] select-all"
          title={currentUrl}
        >
          {currentUrl}
        </span>

        <Tip label="在浏览器中打开" position="bottom">
          <button
            type="button"
            className={currentUrl ? navBtnClass : navBtnDisabled}
            onClick={handleOpenExternal}
            disabled={!currentUrl}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </Tip>

        {/* Loading progress indicator */}
        {isLoading && (
          <div className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden">
            <div className="animate-indeterminate h-full w-1/3 bg-[var(--accent-warm)]" />
          </div>
        )}
      </div>

      {/* Placeholder container — native Webview overlays this area */}
      <div ref={containerRef} className="relative min-h-0 flex-1 bg-[var(--paper)]">
        {/* Show placeholder when webview is not yet alive */}
        {!browserAlive && (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-[var(--ink-subtle)]">
              <Globe className="h-6 w-6" />
              <span className="text-[12px]">
                {url ? '加载中...' : ''}
              </span>
            </div>
          </div>
        )}

        {/* Frosted placeholder during split drag */}
        {isDraggingSplit && browserAlive && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--paper)]/80 backdrop-blur-md">
            <div className="flex flex-col items-center gap-2 text-[var(--ink-subtle)]">
              <Globe className="h-5 w-5" />
              <span className="text-[12px]">{displayUrl}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
