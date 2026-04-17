// Thought types (v0.1.69 Task Center)
// User-level freeform notes that may later be dispatched as tasks.
// Storage: ~/.myagents/thoughts/<YYYY-MM>/<id>.md (frontmatter + body)

/**
 * A Thought — user-level note, not bound to any workspace.
 * See PRD §3.1.
 */
export interface Thought {
  /** UUID v4 */
  id: string;
  /** Markdown-compatible text body (with inline `#tags` and image refs) */
  content: string;
  /** Tags parsed from `#xxx` patterns in content (auto-extracted on save) */
  tags: string[];
  /** Relative paths under the thought's month-dir (e.g. `images/<id>_0.png`) */
  images: string[];
  /** Creation time (ms since epoch) */
  createdAt: number;
  /** Last-edit time (ms since epoch) */
  updatedAt: number;
  /** Task IDs derived from this thought (bidirectional link "outgoing" side) */
  convertedTaskIds: string[];
}

/**
 * Payload accepted by `cmd_thought_create`.
 */
export interface ThoughtCreateInput {
  content: string;
  images?: string[];
}

/**
 * Payload accepted by `cmd_thought_update`. Only the provided fields are changed.
 * `updatedAt` is set server-side.
 */
export interface ThoughtUpdateInput {
  id: string;
  content?: string;
  images?: string[];
  convertedTaskIds?: string[];
}
