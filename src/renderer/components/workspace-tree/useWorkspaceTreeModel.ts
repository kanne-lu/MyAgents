import { useCallback, useMemo, useState } from "react";

import type { DirectoryTreeNode } from "../../../shared/dir-types";

import {
  buildStickyAncestors,
  buildVisibleRangeSelection,
  buildVisibleTreeRows,
  buildWorkspaceNodeMetaByPath,
} from "./treeFlatten";
import type { StickyAncestor, WorkspaceTreeNodeMeta } from "./treeTypes";

interface UseWorkspaceTreeModelOptions {
  rootChildren: DirectoryTreeNode[];
  loadingPaths: ReadonlySet<string>;
  selectedPaths: readonly string[];
  maxStickyDepth?: number;
}

export interface WorkspaceTreeModel {
  nodeMetaByPath: Map<string, WorkspaceTreeNodeMeta>;
  visibleRows: ReturnType<typeof buildVisibleTreeRows>;
  openPath: (path: string) => void;
  closePath: (path: string) => void;
  togglePath: (path: string) => void;
  isOpen: (path: string) => boolean;
  getRangeSelection: (anchorPath: string, targetPath: string) => string[];
  getStickyAncestors: (
    firstVisibleIndex: number,
    scrollTop: number,
  ) => StickyAncestor[];
}

export function useWorkspaceTreeModel({
  rootChildren,
  loadingPaths,
  selectedPaths,
  maxStickyDepth = 3,
}: UseWorkspaceTreeModelOptions): WorkspaceTreeModel {
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => new Set());

  const nodeMetaByPath = useMemo(
    () => buildWorkspaceNodeMetaByPath(rootChildren),
    [rootChildren],
  );
  const selectedPathSet = useMemo(
    () => new Set(selectedPaths),
    [selectedPaths],
  );
  const visibleOpenPaths = useMemo(() => {
    const next = new Set<string>();
    for (const path of openPaths) {
      if (nodeMetaByPath.has(path)) {
        next.add(path);
      }
    }
    return next;
  }, [nodeMetaByPath, openPaths]);

  const visibleRows = useMemo(
    () =>
      buildVisibleTreeRows(
        rootChildren,
        visibleOpenPaths,
        loadingPaths,
        selectedPathSet,
      ),
    [rootChildren, visibleOpenPaths, loadingPaths, selectedPathSet],
  );

  const openPath = useCallback((path: string) => {
    setOpenPaths((prev) => {
      if (prev.has(path)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  const closePath = useCallback((path: string) => {
    setOpenPaths((prev) => {
      if (!prev.has(path)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const togglePath = useCallback((path: string) => {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const isOpen = useCallback(
    (path: string) => visibleOpenPaths.has(path),
    [visibleOpenPaths],
  );

  const getRangeSelection = useCallback(
    (anchorPath: string, targetPath: string) =>
      buildVisibleRangeSelection(visibleRows, anchorPath, targetPath),
    [visibleRows],
  );

  const getStickyAncestors = useCallback(
    (firstVisibleIndex: number, scrollTop: number) =>
      buildStickyAncestors(
        visibleRows,
        nodeMetaByPath,
        firstVisibleIndex,
        scrollTop,
        maxStickyDepth,
      ),
    [visibleRows, nodeMetaByPath, maxStickyDepth],
  );

  return {
    closePath,
    getRangeSelection,
    getStickyAncestors,
    isOpen,
    nodeMetaByPath,
    openPath,
    togglePath,
    visibleRows,
  };
}
