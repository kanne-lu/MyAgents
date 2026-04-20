/**
 * Hook for handling file drag-and-drop in Tauri v2
 *
 * In Tauri, standard HTML5 drag-drop events from external files don't work.
 * Tauri intercepts OS drag events and emits its own:
 * - tauri://drag-enter
 * - tauri://drag-over
 * - tauri://drag-drop
 * - tauri://drag-leave
 *
 * This hook listens to those events and tracks which registered drop zone
 * the mouse is over by using element position and Tauri's drop position.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isDebugMode } from '@/utils/debug';

interface DragDropPayload {
  type: 'enter' | 'over' | 'drop' | 'leave' | 'cancelled';
  position?: { x: number; y: number };
  paths?: string[];
}

interface DropZone {
  id: string;
  element: HTMLElement | null;
  onDrop: (paths: string[]) => void;
}

interface UseTauriFileDropOptions {
  /** Called when drag enters any zone */
  onDragEnter?: () => void;
  /** Called when drag leaves all zones */
  onDragLeave?: () => void;
  /** Called when files are dropped */
  onDrop?: (paths: string[], zoneId: string | null) => void;
  /**
   * Whether this hook instance should respond to Tauri drag events. Default `true`.
   *
   * Tauri emits each drag event exactly once, but every mounted consumer's listener
   * receives it. In the multi-tab Chat app, inactive tabs are kept mounted with
   * `visibility:hidden` / `pointer-events-none` / `absolute inset-0` — their
   * `chatContentRef.current` element still reports the same bounding rect as the
   * active tab, so `findZoneAtPosition` matches for ALL tabs and each tab's
   * `onDrop` fires, causing a single file drop to land in every tab simultaneously.
   *
   * Pass `isActive` from the parent tab context so only the visible tab reacts.
   */
  enabled?: boolean;
}

interface UseTauriFileDropResult {
  /** Whether files are being dragged over the window */
  isDragging: boolean;
  /** The active drop zone ID based on last known position */
  activeZoneId: string | null;
  /** Register a drop zone element */
  registerZone: (id: string, element: HTMLElement | null, onDrop: (paths: string[]) => void) => void;
  /** Unregister a drop zone */
  unregisterZone: (id: string) => void;
}

/**
 * Check if a point is inside an element's bounding rect
 */
function isPointInElement(x: number, y: number, element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function useTauriFileDrop(options: UseTauriFileDropOptions = {}): UseTauriFileDropResult {
  const { onDragEnter, onDragLeave, onDrop, enabled = true } = options;
  const [isDragging, setIsDragging] = useState(false);
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);

  // Store registered drop zones
  const zonesRef = useRef<Map<string, DropZone>>(new Map());

  // Store stable refs for callbacks
  const onDragEnterRef = useRef(onDragEnter);
  const onDragLeaveRef = useRef(onDragLeave);
  const onDropRef = useRef(onDrop);
  // Track `enabled` via ref so the single listener setup (effect with [findZoneAtPosition]
  // deps, not [enabled]) always reads the current value without re-subscribing on every
  // tab switch — we want listeners stable, just gated per-fire.
  const enabledRef = useRef(enabled);

  useEffect(() => {
    onDragEnterRef.current = onDragEnter;
    onDragLeaveRef.current = onDragLeave;
    onDropRef.current = onDrop;
    enabledRef.current = enabled;
  }, [onDragEnter, onDragLeave, onDrop, enabled]);

  /**
   * Find which drop zone contains the given position
   */
  const findZoneAtPosition = useCallback((x: number, y: number): string | null => {
    for (const [id, zone] of zonesRef.current) {
      if (zone.element && isPointInElement(x, y, zone.element)) {
        return id;
      }
    }
    return null;
  }, []);

  const registerZone = useCallback((id: string, element: HTMLElement | null, onDrop: (paths: string[]) => void) => {
    zonesRef.current.set(id, { id, element, onDrop });
  }, []);

  const unregisterZone = useCallback((id: string) => {
    zonesRef.current.delete(id);
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) {
      return;
    }

    const unlisteners: UnlistenFn[] = [];

    const setupListeners = async () => {
      // Listen to Tauri drag events
      // The event names in Tauri v2 are tauri://drag-enter, tauri://drag-over, etc.

      // ── Critical gate ──
      // Tauri broadcasts each drag event to ALL mounted listeners. In a multi-tab
      // app, every tab's hook instance would otherwise fire handlers + update its
      // own state (isDragging / activeZoneId / onDrop → attachment state), so a
      // single file drop leaks into every tab. Gate at the earliest point in each
      // handler using the enabledRef the caller wires to their tab's `isActive`.
      const enabledGate = () => enabledRef.current;

      const enterUnlisten = await listen<DragDropPayload>('tauri://drag-enter', (event) => {
        if (!enabledGate()) return;
        if (isDebugMode()) {
          console.log('[useTauriFileDrop] drag-enter', event.payload);
        }
        setIsDragging(true);
        onDragEnterRef.current?.();

        // Update active zone based on position
        if (event.payload.position) {
          const zoneId = findZoneAtPosition(event.payload.position.x, event.payload.position.y);
          setActiveZoneId(zoneId);
        }
      });
      unlisteners.push(enterUnlisten);

      const overUnlisten = await listen<DragDropPayload>('tauri://drag-over', (event) => {
        if (!enabledGate()) return;
        // Update active zone based on position
        if (event.payload.position) {
          const zoneId = findZoneAtPosition(event.payload.position.x, event.payload.position.y);
          setActiveZoneId(zoneId);
        }
      });
      unlisteners.push(overUnlisten);

      const dropUnlisten = await listen<DragDropPayload>('tauri://drag-drop', (event) => {
        if (!enabledGate()) return;
        if (isDebugMode()) {
          console.log('[useTauriFileDrop] drag-drop', event.payload);
        }
        setIsDragging(false);

        const paths = event.payload.paths || [];
        if (paths.length === 0) {
          setActiveZoneId(null);
          return;
        }

        // Find which zone was dropped on
        let zoneId: string | null = null;
        if (event.payload.position) {
          zoneId = findZoneAtPosition(event.payload.position.x, event.payload.position.y);
        }

        if (isDebugMode()) {
          console.log('[useTauriFileDrop] Drop on zone:', zoneId, 'paths:', paths);
        }

        // Track file_drop event
        track('file_drop', { file_count: paths.length });

        // Call zone-specific handler
        if (zoneId) {
          const zone = zonesRef.current.get(zoneId);
          zone?.onDrop(paths);
        }

        // Call global handler
        onDropRef.current?.(paths, zoneId);

        setActiveZoneId(null);
      });
      unlisteners.push(dropUnlisten);

      const leaveUnlisten = await listen<DragDropPayload>('tauri://drag-leave', () => {
        if (!enabledGate()) return;
        setIsDragging(false);
        setActiveZoneId(null);
        onDragLeaveRef.current?.();
      });
      unlisteners.push(leaveUnlisten);

      // Also listen to cancelled event (renamed in Tauri v2)
      const cancelUnlisten = await listen<DragDropPayload>('tauri://drag-cancelled', () => {
        if (!enabledGate()) return;
        setIsDragging(false);
        setActiveZoneId(null);
        onDragLeaveRef.current?.();
      });
      unlisteners.push(cancelUnlisten);
    };

    setupListeners().catch(console.error);

    return () => {
      unlisteners.forEach(unlisten => unlisten());
    };
  }, [findZoneAtPosition]);

  return {
    isDragging,
    activeZoneId,
    registerZone,
    unregisterZone,
  };
}
