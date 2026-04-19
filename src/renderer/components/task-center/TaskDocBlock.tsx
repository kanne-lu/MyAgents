// TaskDocBlock — read-only preview for one of a task's markdown
// documents (`task.md` / `verify.md` / `progress.md`).
//
// v0.1.69 refactor: the component used to host its own Monaco editor
// for inline edits. That parallel editor diverged visually and
// behaviourally from `TaskEditPanel`'s textarea — same content, two
// UIs, user confusion. Now: the block only previews content; the
// overlay header's single "编辑" button is the canonical edit entry
// (no per-block pencil, no notification pencil — one entry only, per
// the v0.1.69 preview polish).
//
// `progress.md` callers set `hideWhenEmpty` so the block vanishes on
// new tasks that have no execution log yet.

import { useCallback, useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';

import Markdown from '@/components/Markdown';
import { taskOpenDocsDir, taskReadDoc, type TaskDocName } from '@/api/taskCenter';
import type { Task } from '@/../shared/types/task';
import { extractErrorMessage } from './errors';

interface Props {
  task: Task;
  /** Which document — maps 1:1 to the filename stem. */
  doc: TaskDocName;
  title: string;
  /** Surfaced when the file is missing and `hideWhenEmpty` is false. */
  emptyHint: string;
  /** If true, render nothing when the file is empty (progress.md uses this
   *  so new tasks don't show a dashed empty-box). */
  hideWhenEmpty?: boolean;
  /** Signal: task refetched externally → reload content. */
  reloadKey?: unknown;
  onError: (msg: string) => void;
}

export function TaskDocBlock({
  task,
  doc,
  title,
  emptyHint,
  hideWhenEmpty = false,
  reloadKey,
  onError,
}: Props) {
  const [content, setContent] = useState('');
  // "Loaded" is derived from a snapshot of the load keys: when task.id
  // / doc / reloadKey change, `loadedFor` no longer equals the current
  // triple → `loaded` flips to false until the fetch lands and writes
  // the new snapshot. Avoids a `setLoaded(false)` call inside the
  // effect (lint: react-hooks/set-state-in-effect).
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loadKey = `${task.id}|${doc}|${String(reloadKey ?? '')}`;
  const loaded = loadedFor === loadKey;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await taskReadDoc(task.id, doc);
        if (cancelled) return;
        setContent(body);
        setLoadedFor(loadKey);
      } catch (e) {
        if (cancelled) return;
        onError(extractErrorMessage(e));
        setLoadedFor(loadKey);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task.id, doc, reloadKey, loadKey, onError]);

  // The on-disk path is deterministic (`~/.myagents/tasks/<id>/<doc>.md`)
  // so we can surface it + an opener button right below the title —
  // same pattern as the edit panel's DocSectionHeader, so preview and
  // edit modes don't diverge visually. Declared before the
  // hideWhenEmpty short-circuit so the useCallback hook call order
  // stays stable across renders (rules-of-hooks).
  const path = `~/.myagents/tasks/${task.id}/${doc}.md`;
  const handleOpenFolder = useCallback(() => {
    void taskOpenDocsDir(task.id).catch((e) => onError(extractErrorMessage(e)));
  }, [task.id, onError]);

  // hideWhenEmpty short-circuit: a loaded but empty progress.md renders
  // nothing; an unloaded one renders the loading placeholder so users
  // see the block during initial fetch (prevents jumpy layout).
  if (hideWhenEmpty && loaded && !content) return null;

  return (
    <section className="mt-4">
      {/* Title — 14px semibold ink, matches the edit panel's section
          headers so the preview ↔ edit mental model is identical. */}
      <h3 className="text-[14px] font-semibold text-[var(--ink)]">{title}</h3>
      {/* Path + 打开文件夹 on a dedicated row below the title. */}
      <div className="mb-2 mt-1 flex items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--ink-muted)]/70"
          title={path}
        >
          {path}
        </span>
        <button
          type="button"
          onClick={handleOpenFolder}
          title="在文件管理器中打开该任务的文档目录"
          className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-[11px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
        >
          <FolderOpen className="h-3 w-3" />
          打开文件夹
        </button>
      </div>

      {!loaded ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--paper)] p-3 text-[12px] text-[var(--ink-muted)]">
          加载中…
        </div>
      ) : content ? (
        // `compact` drops Markdown's body from text-base (16px) to
        // text-sm (14px), bringing it in line with the edit-mode
        // textareas (13px font-mono). The 1px delta is fine — both are
        // in the "dense content" band, so preview → edit feels
        // continuous rather than a font-size jump.
        <div className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--paper)] p-4">
          <Markdown compact>{content}</Markdown>
        </div>
      ) : (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--line)] bg-[var(--paper)] p-3 text-[12px] text-[var(--ink-muted)]">
          {emptyHint}
        </div>
      )}
    </section>
  );
}

export default TaskDocBlock;
