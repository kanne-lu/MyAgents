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
}

export function TerminalPanel({
  workspacePath,
  terminalId,
  onTerminalCreated,
  onTerminalExited,
  isVisible = true,
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

  // 2. Create PTY when terminal is needed but not yet created
  useEffect(() => {
    if (terminalId !== null) return; // Already created
    if (!fitAddonRef.current) return; // xterm not ready yet

    const dims = fitAddonRef.current.proposeDimensions();
    const rows = dims?.rows ?? 24;
    const cols = dims?.cols ?? 80;

    invoke<string>('cmd_terminal_create', { workspacePath, rows, cols })
      .then((id) => {
        if (!isMountedRef.current) {
          // Component unmounted during creation — clean up the orphaned PTY
          invoke('cmd_terminal_close', { terminalId: id }).catch(() => {});
          return;
        }
        onTerminalCreatedRef.current(id);
      })
      .catch((err) => {
        console.error('[TerminalPanel] Failed to create terminal:', err);
        xtermRef.current?.write(`\r\nFailed to create terminal: ${err}\r\n`);
      });
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

  // 4. PTY output → xterm render
  useEffect(() => {
    if (!terminalId) return;

    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    const setup = async () => {
      unlistenData = await listen<number[]>(`terminal:data:${terminalId}`, (event) => {
        if (xtermRef.current && event.payload) {
          xtermRef.current.write(new Uint8Array(event.payload));
        }
      });
      if (cancelled) { unlistenData(); return; }

      unlistenExit = await listen(`terminal:exit:${terminalId}`, () => {
        xtermRef.current?.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
        onTerminalExitedRef.current();
      });
      if (cancelled) { unlistenExit(); }
    };

    setup();

    return () => {
      cancelled = true;
      unlistenData?.();
      unlistenExit?.();
    };
  }, [terminalId]);

  // 5. Resize sync (container size changes → PTY resize)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleResize = useCallback(() => {
    // Debounce resize to avoid excessive IPC calls during drag
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      if (!fitAddonRef.current) return;
      fitAddonRef.current.fit();
      const dims = fitAddonRef.current.proposeDimensions();
      if (dims && terminalIdRef.current) {
        invoke('cmd_terminal_resize', {
          terminalId: terminalIdRef.current,
          rows: dims.rows,
          cols: dims.cols,
        }).catch(() => {
          // Resize failure is non-critical
        });
      }
    }, 100);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver(handleResize);
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [handleResize]);

  // 6. Re-fit when panel becomes visible (switching from file view back to terminal)
  useEffect(() => {
    if (isVisible) {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
      });
    }
  }, [isVisible]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ background: TERMINAL_THEME.background }}
    />
  );
}
