import type { DirectoryTreeNode } from "../../../shared/dir-types";

import type {
  StickyAncestor,
  VisibleTreeRow,
  WorkspaceTreeNodeMeta,
} from "./treeTypes";

export function buildWorkspaceNodeMetaByPath(
  nodes: DirectoryTreeNode[],
  depth = 0,
  parentPath: string | null = null,
  map = new Map<string, WorkspaceTreeNodeMeta>(),
): Map<string, WorkspaceTreeNodeMeta> {
  for (const node of nodes) {
    map.set(node.path, { data: node, depth, parentPath });
    if (node.type === "dir" && node.children?.length) {
      buildWorkspaceNodeMetaByPath(node.children, depth + 1, node.path, map);
    }
  }
  return map;
}

export function buildVisibleTreeRows(
  nodes: DirectoryTreeNode[],
  openPaths: ReadonlySet<string>,
  loadingPaths: ReadonlySet<string>,
  selectedPaths: ReadonlySet<string>,
  depth = 0,
  parentPath: string | null = null,
  rows: VisibleTreeRow[] = [],
): VisibleTreeRow[] {
  for (const node of nodes) {
    const isDir = node.type === "dir";
    const isOpen = isDir && openPaths.has(node.path);
    rows.push({
      data: node,
      depth,
      isDir,
      isLoading: loadingPaths.has(node.path),
      isOpen,
      isSelected: selectedPaths.has(node.path),
      parentPath,
      path: node.path,
    });
    if (isDir && isOpen && node.children?.length) {
      buildVisibleTreeRows(
        node.children,
        openPaths,
        loadingPaths,
        selectedPaths,
        depth + 1,
        node.path,
        rows,
      );
    }
  }
  return rows;
}

export function buildVisibleRangeSelection(
  visibleRows: VisibleTreeRow[],
  anchorPath: string,
  targetPath: string,
): string[] {
  const startIdx = visibleRows.findIndex((row) => row.path === anchorPath);
  const endIdx = visibleRows.findIndex((row) => row.path === targetPath);
  if (startIdx === -1 || endIdx === -1) {
    return [targetPath];
  }
  const [from, to] =
    startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
  return visibleRows.slice(from, to + 1).map((row) => row.path);
}

export function buildStickyAncestors(
  visibleRows: VisibleTreeRow[],
  nodeMetaByPath: ReadonlyMap<string, WorkspaceTreeNodeMeta>,
  firstVisibleIndex: number,
  scrollTop: number,
  maxDepth: number,
): StickyAncestor[] {
  if (scrollTop <= 0 || firstVisibleIndex <= 0) {
    return [];
  }

  const row = visibleRows[firstVisibleIndex];
  if (!row) {
    return [];
  }

  const ancestors: StickyAncestor[] = [];
  let parentPath = row.parentPath;
  while (parentPath && ancestors.length < maxDepth) {
    const meta = nodeMetaByPath.get(parentPath);
    if (!meta) {
      break;
    }
    ancestors.unshift({
      depth: meta.depth,
      id: meta.data.id,
      name: meta.data.name,
      path: parentPath,
    });
    parentPath = meta.parentPath;
  }
  return ancestors;
}
