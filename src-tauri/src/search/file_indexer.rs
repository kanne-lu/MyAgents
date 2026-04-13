//! Workspace file index — scans workspace directories, builds per-workspace Tantivy indices.
//!
//! # Incremental refresh
//!
//! The naive "invalidate on every search-mode entry" strategy rebuilds the
//! whole index from scratch every time the user opens the search box, which
//! on a 1000+ file workspace takes ~20 seconds and blocks the UI. The user
//! only cares about one thing: "are recent file changes searchable?" — not
//! "reindex everything just in case".
//!
//! The fix is `refresh_or_create`: walk the tree **metadata only** (cheap —
//! hundreds of ms for thousands of files), diff against a stored
//! `(rel_path → (mtime_ms, size))` map, and only `delete_term + add_document`
//! the files that actually changed. Unchanged files are reused in-place.
//!
//! First entry still pays the full build cost; subsequent entries pay only
//! the walk + whatever changed. Files created by the AI between sessions are
//! picked up on the next mode entry automatically.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::ulog_info;

use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::{doc, Index, IndexReader, ReloadPolicy, Term};

use super::schema::{self, FileFields};
use super::searcher::{FileSearchResult, FileSearchHit, FileMatchLine};
use super::tokenizer;
use super::util::{byte_to_utf16, ceil_char_boundary, floor_char_boundary};

/// Directories to skip when scanning workspace files.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "__pycache__", ".next", "dist",
    "build", ".turbo", ".cache", "target", ".venv", "venv",
    ".myagents", ".claude",
];

/// File extensions to skip (binary files).
const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "avif",
    "mp3", "mp4", "avi", "mov", "wav", "ogg", "webm", "flac",
    "zip", "tar", "gz", "rar", "7z", "bz2", "xz", "zst",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "woff", "woff2", "ttf", "eot", "otf",
    "exe", "dll", "so", "dylib", "a", "lib",
    "sqlite", "db", "sqlite3",
    "pyc", "pyo", "class", "o", "obj",
    "DS_Store",
];

/// Maximum file size to index (1 MB).
const MAX_FILE_SIZE: u64 = 1_048_576;

/// Per-file staleness fingerprint. Two files with the same `(mtime_ms, size)`
/// are assumed unchanged — good enough because any content edit changes mtime,
/// and the size check catches the rare case of an editor that restores mtime
/// after a modification.
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileState {
    mtime_ms: u64,
    size: u64,
}

/// Manages per-workspace Tantivy indices.
pub struct FileIndexManager {
    base_dir: PathBuf,
    indices: HashMap<String, WorkspaceFileIndex>,
}

struct WorkspaceFileIndex {
    index: Index,
    reader: IndexReader,
    fields: FileFields,
    /// Snapshot of file state at last index/refresh. Keyed by **relative**
    /// path from workspace root — the same string we store in the doc — so
    /// `delete_term` hits the right entry.
    file_states: HashMap<String, FileState>,
}

impl FileIndexManager {
    pub fn new(base_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&base_dir);
        Self {
            base_dir,
            indices: HashMap::new(),
        }
    }

    /// Invalidate an index so it will be rebuilt next time. Used for hard
    /// resets (schema migration, corruption recovery); the common path is
    /// `refresh_or_create` instead.
    pub fn invalidate_index(&mut self, workspace: &str) {
        self.indices.remove(workspace);
    }

    /// Refresh an existing workspace index incrementally, or build from
    /// scratch on first access. Returns `(total_files, changed_files)`.
    ///
    /// Called when the user enters search mode. Cheap on a warm cache
    /// (hundreds of ms to stat the tree + zero writes if nothing changed).
    pub fn refresh_or_create(&mut self, workspace: &str) -> Result<(usize, usize), String> {
        if !self.indices.contains_key(workspace) {
            let count = self.create_and_populate_index(workspace)?;
            return Ok((count, count));
        }

        let ws_path = Path::new(workspace);
        if !ws_path.is_dir() {
            return Ok((0, 0));
        }

        let start = std::time::Instant::now();
        let discovered = discover_files(ws_path)?;

        // Scope the mutable borrow so we can call ulog_info after.
        let (total, change_count) = {
            let ws_index = self.indices.get_mut(workspace).unwrap();

            let mut to_reindex: Vec<(String, PathBuf)> = Vec::new();
            let mut new_file_states: HashMap<String, FileState> =
                HashMap::with_capacity(discovered.len());

            for (rel_path, (abs_path, state)) in discovered {
                let needs_reindex = match ws_index.file_states.get(&rel_path) {
                    Some(old) => *old != state,
                    None => true,
                };
                if needs_reindex {
                    to_reindex.push((rel_path.clone(), abs_path));
                }
                new_file_states.insert(rel_path, state);
            }

            let deleted: Vec<String> = ws_index
                .file_states
                .keys()
                .filter(|k| !new_file_states.contains_key(*k))
                .cloned()
                .collect();

            let change_count = to_reindex.len() + deleted.len();
            let total = new_file_states.len();

            if change_count == 0 {
                ws_index.file_states = new_file_states;
                return Ok((total, 0));
            }

            let mut writer = ws_index
                .index
                .writer(30_000_000)
                .map_err(|e| format!("Failed to create writer for refresh: {}", e))?;

            let path_field = ws_index.fields.path;
            for (rel, _) in &to_reindex {
                writer.delete_term(Term::from_field_text(path_field, rel));
            }
            for rel in &deleted {
                writer.delete_term(Term::from_field_text(path_field, rel));
            }

            for (rel_path, abs_path) in &to_reindex {
                let content = match fs::read_to_string(abs_path) {
                    Ok(c) => c,
                    Err(_) => {
                        // File vanished or became non-UTF8 between discovery
                        // and read. Drop from the state map so a future
                        // refresh re-adds it if it comes back.
                        new_file_states.remove(rel_path);
                        continue;
                    }
                };
                let name = abs_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let ext = abs_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                let _ = writer.add_document(doc!(
                    ws_index.fields.path => rel_path.as_str(),
                    ws_index.fields.name => name.as_str(),
                    ws_index.fields.content => content.as_str(),
                    ws_index.fields.ext => ext.as_str(),
                ));
            }

            writer
                .commit()
                .map_err(|e| format!("commit failed: {}", e))?;
            drop(writer);

            ws_index
                .reader
                .reload()
                .map_err(|e| format!("reader reload failed: {}", e))?;
            ws_index.file_states = new_file_states;

            (total, change_count)
        };

        ulog_info!(
            "[search] Refreshed workspace index: {} changed, {} total for {} ({:.0}ms)",
            change_count,
            total,
            workspace,
            start.elapsed().as_secs_f64() * 1000.0
        );

        Ok((total, change_count))
    }

    /// Search workspace files. Creates the index on first access.
    pub fn search(
        &mut self,
        query: &str,
        workspace: &str,
        limit: usize,
        max_matches_per_file: usize,
    ) -> Result<FileSearchResult, String> {
        let start = std::time::Instant::now();

        // Ensure index exists (lazy creation on cache miss)
        if !self.indices.contains_key(workspace) {
            self.create_and_populate_index(workspace)?;
        }

        let ws_index = self.indices.get(workspace)
            .ok_or_else(|| format!("Index not found for workspace: {}", workspace))?;

        let f = &ws_index.fields;
        let searcher = ws_index.reader.searcher();

        let mut parser = QueryParser::for_index(&ws_index.index, vec![f.name, f.content]);
        parser.set_field_boost(f.name, 2.0);

        let tantivy_query = parser
            .parse_query(query)
            .map_err(|e| format!("Query parse error: {}", e))?;

        let top_docs = searcher
            .search(&tantivy_query, &TopDocs::with_limit(limit))
            .map_err(|e| format!("Search error: {}", e))?;

        let query_lower = query.to_lowercase();
        let mut hits = Vec::new();
        let mut total_matches = 0;

        for (_score, doc_addr) in top_docs {
            let doc_result = searcher.doc::<tantivy::TantivyDocument>(doc_addr);
            let doc = match doc_result {
                Ok(d) => d,
                Err(_) => continue,
            };

            let path = get_text_field(&doc, f.path);
            let name = get_text_field(&doc, f.name);
            let content = get_text_field(&doc, f.content);

            // Find matching lines from the actual file content
            let matches = find_matching_lines(
                &content,
                &query_lower,
                max_matches_per_file,
            );

            let match_count = matches.len();
            total_matches += match_count;

            // If no line-level matches but the name matches, show it as a filename-only match
            if match_count > 0 || name.to_lowercase().contains(&query_lower) {
                hits.push(FileSearchHit {
                    path,
                    name,
                    match_count: match_count.max(1),
                    matches,
                });
            }
        }

        Ok(FileSearchResult {
            total_files: hits.len(),
            total_matches,
            hits,
            query_time_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// Create and populate a workspace file index from scratch. Returns the
    /// number of files indexed.
    fn create_and_populate_index(&mut self, workspace: &str) -> Result<usize, String> {
        // Use a hash of the workspace path as directory name
        let hash = simple_hash(workspace);
        let index_dir = self.base_dir.join(&hash);
        let _ = fs::create_dir_all(&index_dir);

        let (schema, fields) = schema::file_schema();

        // Always create fresh index for workspace files (they change frequently)
        let index = Index::create_in_dir(&index_dir, schema.clone())
            .or_else(|_| {
                // If directory exists with incompatible index, recreate
                let _ = fs::remove_dir_all(&index_dir);
                let _ = fs::create_dir_all(&index_dir);
                Index::create_in_dir(&index_dir, schema)
            })
            .map_err(|e| format!("Failed to create file index: {}", e))?;

        // MUST register tokenizer before creating the writer — the writer
        // snapshots the tokenizer manager at construction time, so late
        // registration would leave docs tokenized with the default English
        // tokenizer and jieba would never run.
        index
            .tokenizers()
            .register(tokenizer::TOKENIZER_NAME, tokenizer::build_chinese_tokenizer());

        let mut writer = index
            .writer(30_000_000)
            .map_err(|e| format!("Failed to create file index writer: {}", e))?;

        // Walk the tree metadata-first, then read + index each discovered file.
        let ws_path = Path::new(workspace);
        let file_states = if ws_path.is_dir() {
            let discovered = discover_files(ws_path)?;
            let mut states: HashMap<String, FileState> = HashMap::with_capacity(discovered.len());
            for (rel_path, (abs_path, state)) in discovered {
                let content = match fs::read_to_string(&abs_path) {
                    Ok(c) => c,
                    Err(_) => continue, // Skip non-UTF8 / unreadable
                };
                let name = abs_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let ext = abs_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                let _ = writer.add_document(doc!(
                    fields.path => rel_path.as_str(),
                    fields.name => name.as_str(),
                    fields.content => content.as_str(),
                    fields.ext => ext.as_str(),
                ));
                states.insert(rel_path, state);
            }
            ulog_info!(
                "[search] Indexed {} files for workspace: {}",
                states.len(),
                workspace
            );
            states
        } else {
            HashMap::new()
        };

        writer.commit().map_err(|e| format!("commit failed: {}", e))?;
        // Drop the writer after the initial commit — subsequent incremental
        // refreshes open a short-lived writer of their own. Keeping one live
        // would waste ~30 MB of heap per workspace for no benefit.
        drop(writer);

        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|e| format!("Failed to create file index reader: {}", e))?;

        let count = file_states.len();
        self.indices.insert(workspace.to_string(), WorkspaceFileIndex {
            index,
            reader,
            fields,
            file_states,
        });

        Ok(count)
    }
}

/// Walk a workspace tree metadata-only and return `rel_path → (abs_path, FileState)`
/// for every file that passes the index filters (skip dirs, binary ext, hidden,
/// size cap). No file contents are read.
fn discover_files(root: &Path) -> Result<HashMap<String, (PathBuf, FileState)>, String> {
    let mut out = HashMap::new();
    walk_dir(root, root, &mut out);
    Ok(out)
}

fn walk_dir(
    root: &Path,
    dir: &Path,
    out: &mut HashMap<String, (PathBuf, FileState)>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // permission denied / vanished → skip silently
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        if path.is_dir() {
            if SKIP_DIRS.iter().any(|s| name == *s) || name.starts_with('.') {
                continue;
            }
            walk_dir(root, &path, out);
            continue;
        }

        // File filters — keep in sync with the skip rules above.
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if BINARY_EXTENSIONS.iter().any(|b| ext == *b) {
            continue;
        }
        if name.starts_with('.') {
            continue;
        }

        let metadata = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > MAX_FILE_SIZE {
            continue;
        }

        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let state = FileState {
            mtime_ms,
            size: metadata.len(),
        };

        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        out.insert(rel, (path, state));
    }
}

/// Find matching lines in file content.
///
/// Returns `FileMatchLine`s whose `highlights` are **UTF-16 code unit
/// offsets** into `line_content` (the unit JavaScript strings are indexed by).
/// All byte slicing is clamped to UTF-8 char boundaries to avoid panics on
/// Chinese / emoji content.
fn find_matching_lines(
    content: &str,
    query_lower: &str,
    max_matches: usize,
) -> Vec<FileMatchLine> {
    const MAX_LINE_BYTES: usize = 200;

    let mut matches = Vec::new();
    let query_words: Vec<&str> = query_lower.split_whitespace().collect();
    if query_words.is_empty() {
        return matches;
    }

    for (line_idx, line) in content.lines().enumerate() {
        let line_lower = line.to_lowercase();

        // Check if any query word appears in this line
        let has_match = query_words.iter().any(|w| line_lower.contains(w));
        if !has_match {
            continue;
        }

        // Find highlight byte positions (in `line_lower`, which for ASCII/CJK
        // shares byte layout with `line`).
        let mut byte_highlights: Vec<[usize; 2]> = Vec::new();
        for word in &query_words {
            if word.is_empty() {
                continue;
            }
            let mut search_from = 0;
            while let Some(pos) = line_lower[search_from..].find(word) {
                let abs = search_from + pos;
                byte_highlights.push([abs, abs + word.len()]);
                search_from = abs + word.len();
            }
        }
        byte_highlights.sort_by_key(|h| h[0]);

        // Truncate long lines at a UTF-8 char boundary (plain byte slice would
        // panic mid-codepoint on Chinese / emoji content).
        let (line_content, truncated_len) = if line.len() > MAX_LINE_BYTES {
            let boundary = floor_char_boundary(line, MAX_LINE_BYTES);
            (format!("{}...", &line[..boundary]), boundary)
        } else {
            (line.to_string(), line.len())
        };

        // Drop highlights past the truncation point; clamp end to the cut.
        // Then convert remaining byte offsets to UTF-16 code unit offsets so
        // the frontend's `text.slice(...)` lands on the intended glyphs.
        let highlights: Vec<[usize; 2]> = byte_highlights
            .into_iter()
            .filter_map(|[s, e]| {
                if s >= truncated_len {
                    return None;
                }
                let e = e.min(truncated_len);
                let s = floor_char_boundary(&line_content, s);
                let e = ceil_char_boundary(&line_content, e);
                Some([
                    byte_to_utf16(&line_content, s),
                    byte_to_utf16(&line_content, e),
                ])
            })
            .collect();

        matches.push(FileMatchLine {
            line_number: line_idx + 1,
            line_content,
            highlights,
        });

        if matches.len() >= max_matches {
            break;
        }
    }

    matches
}

/// Get text field value from a Tantivy document.
fn get_text_field(doc: &tantivy::TantivyDocument, field: tantivy::schema::Field) -> String {
    doc.get_first(field)
        .and_then(|v| match v {
            tantivy::schema::OwnedValue::Str(s) => Some(s.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

/// Stable 64-bit FNV-1a hash of the workspace path.
///
/// This is used as the on-disk directory name for per-workspace Tantivy
/// indices. It MUST stay deterministic across Rust and std upgrades —
/// `DefaultHasher` is explicitly documented as unstable, so using it here
/// would silently orphan every workspace's index the moment the hasher
/// implementation changes. FNV-1a is a plain spec with no moving parts.
fn simple_hash(s: &str) -> String {
    const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = FNV_OFFSET_BASIS;
    for byte in s.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{:016x}", hash)
}
