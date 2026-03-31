import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ── Warm Dark terminal theme ──
// Aligned with Monaco warmDark theme and design_guide.md color system.
// Exported so Chat.tsx can reference colors for terminal chrome (header/fallback).
export const TERMINAL_THEME = {
  background: '#1a1614',
  foreground: '#d4c8bc',
  cursor: '#c26d3a', // --accent-warm
  cursorAccent: '#1a1614',
  selectionBackground: 'rgba(194, 109, 58, 0.25)', // --accent-warm 25%
  selectionForeground: undefined,
  selectionInactiveBackground: 'rgba(194, 109, 58, 0.15)',

  // ANSI 16 colors — reuse design system semantic colors
  black: '#2a2420',
  red: '#c75050', // --heartbeat
  green: '#2d8a5e', // --success
  yellow: '#d97706', // --warning
  blue: '#4a7ab5', // --info
  magenta: '#b07aab',
  cyan: '#3d8a75', // --accent-cool
  white: '#d4c8bc',

  brightBlack: '#6f6156', // --ink-muted
  brightRed: '#e06060',
  brightGreen: '#3da872',
  brightYellow: '#f0a030',
  brightBlue: '#6a9ad0',
  brightMagenta: '#c894c2',
  brightCyan: '#4da88a',
  brightWhite: '#efe8e0',
};

interface TerminalPanelProps {
  workspacePath: string;
  terminalId: string | null;
  onTerminalCreated: (id: string) => void;
  onTerminalExited: () => void;
  /** Whether this panel is currently the visible view (for fit-on-show) */
  isVisible?: boolean;
  /** Session ID for this Tab — used to resolve sidecar port for MYAGENTS_PORT env var */
  sessionId?: string | null;
}

export function TerminalPanel({
  workspacePath,
  terminalId,
  onTerminalCreated,
  onTerminalExited,
  isVisible = true,
  sessionId: sessionIdProp,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(terminalId);
  useEffect(() => { terminalIdRef.current = terminalId; }, [terminalId]);

  // Stable callbacks via refs to avoid effect re-runs
  const onTerminalCreatedRef = useRef(onTerminalCreated);
  const onTerminalExitedRef = useRef(onTerminalExited);
  useEffect(() => { onTerminalCreatedRef.current = onTerminalCreated; }, [onTerminalCreated]);
  useEffect(() => { onTerminalExitedRef.current = onTerminalExited; }, [onTerminalExited]);

  // Mounted guard to prevent stale async callbacks
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // 1. Initialize xterm.js instance (once on mount)
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: "'SF Mono', 'Cascadia Code', 'Consolas', 'Monaco', monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      // macOS key handling
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      // Right-click: select word + show native context menu (Copy/Paste)
      rightClickSelectsWord: true,
      // Visual
      drawBoldTextInBrightColors: true,
      customGlyphs: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef.current);

    // Initial fit (next frame to ensure container has dimensions)
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    return () => {
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // 2. Create PTY — "listeners first" pattern to prevent exit event loss.
  //    Frontend generates the terminal ID, registers listeners, THEN creates the PTY.
  //    This closes the race where a fast-exiting shell beats listener registration.
  const creatingRef = useRef(false); // In-flight guard prevents double creation

  useEffect(() => {
    if (terminalId !== null) return; // Already created
    if (!fitAddonRef.current) return; // xterm not ready yet
    if (creatingRef.current) return; // Creation already in flight
    creatingRef.current = true;

    const dims = fitAddonRef.current.proposeDimensions();
    const rows = dims?.rows ?? 24;
    const cols = dims?.cols ?? 80;

    // Generate ID frontend-side so we can register listeners before PTY creation
    const preId = crypto.randomUUID();
    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    const create = async () => {
      // Step 1: Register listeners FIRST (before PTY exists)
      unlistenData = await listen<number[]>(`terminal:data:${preId}`, (event) => {
        if (xtermRef.current && event.payload) {
          xtermRef.current.write(new Uint8Array(event.payload));
        }
      });
      if (cancelled) { unlistenData(); creatingRef.current = false; return; }

      unlistenExit = await listen(`terminal:exit:${preId}`, () => {
        xtermRef.current?.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
        onTerminalExitedRef.current();
      });
      if (cancelled) { unlistenExit(); unlistenData?.(); creatingRef.current = false; return; }

      // Step 2: Resolve sidecar port
      let port: number | null = null;
      if (sessionIdProp) {
        try {
          const mod = await import('@/api/tauriClient');
          port = await mod.getSessionPort(sessionIdProp);
        } catch { /* port stays null */ }
      }
      if (cancelled) { unlistenData?.(); unlistenExit?.(); creatingRef.current = false; return; }

      // Step 3: Create PTY with pre-generated ID
      const id = await invoke<string>('cmd_terminal_create', {
        workspacePath, rows, cols,
        sidecarPort: port ?? null,
        terminalId: preId,
      });

      creatingRef.current = false;

      if (!isMountedRef.current || cancelled) {
        invoke('cmd_terminal_close', { terminalId: id }).catch(() => {});
        unlistenData?.();
        unlistenExit?.();
        return;
      }
      onTerminalCreatedRef.current(id);
    };

    create().catch((err) => {
      creatingRef.current = false;
      console.error('[TerminalPanel] Failed to create terminal:', err);
      xtermRef.current?.write(`\r\nFailed to create terminal: ${err}\r\n`);
    });

    return () => {
      cancelled = true;
      // Listeners cleaned up inside create() on cancel, or will be cleaned up
      // by the next effect cycle when terminalId becomes non-null
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionIdProp intentionally excluded:
  // port is a one-time env injection at creation; re-creating PTY on session change would kill the shell
  }, [terminalId, workspacePath]);

  // 3. User input → PTY write
  useEffect(() => {
    if (!terminalId || !xtermRef.current) return;

    const disposable = xtermRef.current.onData((data: string) => {
      const encoded = Array.from(new TextEncoder().encode(data));
      invoke('cmd_terminal_write', { terminalId, data: encoded }).catch((err) => {
        console.error('[TerminalPanel] Write error:', err);
      });
    });

    return () => disposable.dispose();
  }, [terminalId]);

  // 5. Unified resize: single code path for both ResizeObserver and visibility changes.
  // Prevents garbled prompt from multiple fit+SIGWINCH cycles racing each other.
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastColsRef = useRef<number>(0);
  const lastRowsRef = useRef<number>(0);

  const doFitAndResize = useCallback(() => {
    if (!fitAddonRef.current) return;
    fitAddonRef.current.fit();
    const dims = fitAddonRef.current.proposeDimensions();
    if (!dims || !terminalIdRef.current) return;
    // Only send resize to PTY if dimensions actually changed — prevents
    // duplicate SIGWINCH that causes shell to redraw prompt multiple times
    if (dims.cols === lastColsRef.current && dims.rows === lastRowsRef.current) return;
    lastColsRef.current = dims.cols;
    lastRowsRef.current = dims.rows;
    invoke('cmd_terminal_resize', {
      terminalId: terminalIdRef.current,
      rows: dims.rows,
      cols: dims.cols,
    }).catch(() => {});
  }, []);

  // ResizeObserver — fires on container size changes (drag resize, window resize)
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(doFitAndResize, 100);
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [doFitAndResize]);

  // Visibility change — fires when switching from file view or hidden back to terminal.
  // Uses 80ms delay (longer than the 0→real size CSS transition) to ensure layout is stable.
  useEffect(() => {
    if (!isVisible) return;
    const timer = setTimeout(doFitAndResize, 80);
    return () => clearTimeout(timer);
  }, [isVisible, doFitAndResize]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full px-2 pb-1"
      style={{ background: TERMINAL_THEME.background }}
    />
  );
}
