import type { DirectoryTreeNode } from "../../../shared/dir-types";

export interface WorkspaceTreeNodeMeta {
  data: DirectoryTreeNode;
  depth: number;
  parentPath: string | null;
}

export interface VisibleTreeRow extends WorkspaceTreeNodeMeta {
  path: string;
  isDir: boolean;
  isLoading: boolean;
  isOpen: boolean;
  isSelected: boolean;
}

export interface StickyAncestor {
  id: string;
  path: string;
  name: string;
  depth: number;
}
