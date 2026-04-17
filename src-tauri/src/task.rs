//! Task store for Task Center (v0.1.69).
//!
//! Tasks are workspace-scoped execution units. The primary index lives in
//! `~/.myagents/tasks.jsonl` (one task per line, atomic full-rewrite on change).
//! Associated markdown documents live under `<workspace>/.task/<taskId>/{task.md,
//! verify.md, progress.md, alignment.md}`; this module manages `task.md` and
//! `progress.md` but treats `verify.md` / `alignment.md` as externally managed
//! (written by `/task-alignment` skill + Agent).
//!
//! See PRD `specs/prd/prd_0.1.69_task_center.md`:
//! - §3.2 — schema
//! - §9.1 — state machine + transitions table
//! - §10.2.1 — `update-status` handler: transition validity, actor/source guard,
//!   atomic history append, side-effect dispatch, progress.md, notification, SSE.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::cron_task::{EndConditions as CronEndConditions, RunMode as CronRunMode};
use crate::{ulog_debug, ulog_info, ulog_warn};

/// Task-layer `RunMode`. Same semantics as `cron_task::RunMode` but emits PRD-
/// specified kebab-case JSON (`"single-session"` / `"new-session"`). We do NOT
/// reuse `cron_task::RunMode` directly because it emits snake_case which would
/// silently diverge from the TS shared type. Convert at the cron-adapter boundary
/// via `From`/`Into`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskRunMode {
    #[serde(rename = "single-session")]
    SingleSession,
    #[serde(rename = "new-session")]
    NewSession,
}

impl From<CronRunMode> for TaskRunMode {
    fn from(m: CronRunMode) -> Self {
        match m {
            CronRunMode::SingleSession => Self::SingleSession,
            CronRunMode::NewSession => Self::NewSession,
        }
    }
}
impl From<TaskRunMode> for CronRunMode {
    fn from(m: TaskRunMode) -> Self {
        match m {
            TaskRunMode::SingleSession => Self::SingleSession,
            TaskRunMode::NewSession => Self::NewSession,
        }
    }
}

/// Task-layer `EndConditions` — PRD-compatible shape.
///
/// `deadline` is a Unix timestamp in milliseconds (JS `Date.now()` compatible),
/// not a `DateTime<Utc>` like `cron_task::EndConditions`. We convert at the
/// cron-adapter boundary.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskEndConditions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_executions: Option<u32>,
    #[serde(default = "default_true")]
    pub ai_can_exit: bool,
}

impl From<CronEndConditions> for TaskEndConditions {
    fn from(c: CronEndConditions) -> Self {
        Self {
            deadline: c.deadline.map(|dt| dt.timestamp_millis()),
            max_executions: c.max_executions,
            ai_can_exit: c.ai_can_exit,
        }
    }
}

impl From<TaskEndConditions> for CronEndConditions {
    fn from(t: TaskEndConditions) -> Self {
        use chrono::TimeZone;
        Self {
            deadline: t
                .deadline
                .and_then(|ms| chrono::Utc.timestamp_millis_opt(ms).single()),
            max_executions: t.max_executions,
            ai_can_exit: t.ai_can_exit,
        }
    }
}

// ================ Enums ================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Todo,
    Running,
    Verifying,
    Done,
    Blocked,
    Stopped,
    Archived,
    /// Pseudo-state used ONLY as the `to` field of a soft-delete audit entry
    /// (PRD §10.2.2). Never a legal transition target via `update_status`;
    /// only `delete()` may write it. A Task whose `status` equals `Deleted`
    /// is equivalent to `deleted=true` and is filtered out of all list
    /// queries by default.
    Deleted,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Running => "running",
            Self::Verifying => "verifying",
            Self::Done => "done",
            Self::Blocked => "blocked",
            Self::Stopped => "stopped",
            Self::Archived => "archived",
            Self::Deleted => "deleted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionActor {
    System,
    User,
    Agent,
}

impl TransitionActor {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Agent => "agent",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionSource {
    Cli,
    Ui,
    Watchdog,
    Crash,
    Scheduler,
    EndCondition,
    Rerun,
}

impl TransitionSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Ui => "ui",
            Self::Watchdog => "watchdog",
            Self::Crash => "crash",
            Self::Scheduler => "scheduler",
            Self::EndCondition => "endCondition",
            Self::Rerun => "rerun",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskExecutionMode {
    Once,
    Scheduled,
    Recurring,
    Loop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskExecutor {
    User,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskDispatchOrigin {
    #[serde(rename = "direct")]
    Direct,
    #[serde(rename = "ai-aligned")]
    AiAligned,
}

// ================ Struct ================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusTransition {
    /// `None` represents the implicit pre-creation state.
    pub from: Option<TaskStatus>,
    pub to: TaskStatus,
    pub at: i64,
    pub actor: TransitionActor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<TransitionSource>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationConfig {
    #[serde(default = "default_true")]
    pub desktop: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_thread: Option<String>,
    /// Defaults to `['done', 'blocked', 'endCondition']` when absent; keep as
    /// `Option<Vec>` so omitted-means-default is distinguishable from explicit empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<String>>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub executor: TaskExecutor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub workspace_id: String,
    /// Absolute path to the workspace — needed to locate `.task/<id>/` docs and for
    /// sidecar ensure. Stored so UI and execution don't have to resolve it separately.
    #[serde(default)]
    pub workspace_path: String,
    pub execution_mode: TaskExecutionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_conditions: Option<TaskEndConditions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_thought_id: Option<String>,
    #[serde(default)]
    pub session_ids: Vec<String>,
    pub status: TaskStatus,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_executed_at: Option<i64>,
    #[serde(default)]
    pub status_history: Vec<StatusTransition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification: Option<NotificationConfig>,
    pub dispatch_origin: TaskDispatchOrigin,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
}

// ================ Input DTOs ================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateDirectInput {
    pub name: String,
    pub executor: TaskExecutor,
    #[serde(default)]
    pub description: Option<String>,
    pub workspace_id: String,
    pub workspace_path: String,
    /// Contents of `task.md` — the "executor" prompt that will be sent on dispatch.
    pub task_md_content: String,
    pub execution_mode: TaskExecutionMode,
    #[serde(default)]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default)]
    pub end_conditions: Option<TaskEndConditions>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    #[serde(default)]
    pub source_thought_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateFromAlignmentInput {
    pub name: String,
    pub executor: TaskExecutor,
    #[serde(default)]
    pub description: Option<String>,
    pub workspace_id: String,
    pub workspace_path: String,
    /// Source directory `<workspace>/.task/<alignmentSessionId>/` — its contents
    /// are moved (renamed) to `<workspace>/.task/<newTaskId>/`.
    pub alignment_session_id: String,
    pub execution_mode: TaskExecutionMode,
    #[serde(default)]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default)]
    pub end_conditions: Option<TaskEndConditions>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    #[serde(default)]
    pub source_thought_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdateInput {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub executor: Option<TaskExecutor>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<TaskExecutionMode>,
    #[serde(default)]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default)]
    pub end_conditions: Option<TaskEndConditions>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
}

/// Internal-only status-transition payload. Accepts explicit `actor`/`source`
/// because crash recovery, scheduler ticks, end-condition firing, watchdog,
/// and CLI adapters all need to assert *their* actor — not the client's.
///
/// The public Tauri command uses `UiTaskUpdateStatusInput` which omits these
/// fields and the Tauri layer stamps `actor=user, source=ui` authoritatively
/// (PRD §10.2.1 caller-inference table row 3: UI button → user/ui). This
/// prevents a malicious/buggy renderer from spoofing `actor=agent` or
/// `source=endCondition`.
#[derive(Debug, Clone)]
pub struct TaskUpdateStatusInput {
    pub id: String,
    pub status: TaskStatus,
    pub message: Option<String>,
    pub actor: TransitionActor,
    pub source: Option<TransitionSource>,
}

/// Public DTO for the Tauri command. NOT serde-tagged with `actor`/`source` — those
/// are stamped by the command handler from its trusted entry context.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTaskUpdateStatusInput {
    pub id: String,
    pub status: TaskStatus,
    #[serde(default)]
    pub message: Option<String>,
}

/// Accepts either a single status (`"running"`) or an array (`["running", "done"]`).
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum StatusFilter {
    One(TaskStatus),
    Many(Vec<TaskStatus>),
}

impl StatusFilter {
    fn matches(&self, s: TaskStatus) -> bool {
        match self {
            Self::One(x) => *x == s,
            Self::Many(xs) => xs.iter().any(|x| *x == s),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListFilter {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub status: Option<StatusFilter>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub include_deleted: Option<bool>,
}

// ================ Errors ================

/// Transition-related rejection returned to the caller. Rendered as `{code, message}`
/// so the UI / CLI can branch on `code` rather than string-match messages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOpError {
    pub code: String,
    pub message: String,
}

impl TaskOpError {
    fn invalid_transition(from: TaskStatus, to: TaskStatus) -> Self {
        Self {
            code: "invalid_transition".to_string(),
            message: format!(
                "invalid transition from {} to {}",
                from.as_str(),
                to.as_str()
            ),
        }
    }
    fn archive_user_only() -> Self {
        Self {
            code: "archive_user_only".to_string(),
            message: "archive is user-only (PRD §9.1)".to_string(),
        }
    }
    fn agent_source_must_be_cli() -> Self {
        Self {
            code: "agent_source_must_be_cli".to_string(),
            message: "agent transitions must come through CLI (source='cli')".to_string(),
        }
    }
    fn not_found(id: &str) -> Self {
        Self {
            code: "not_found".to_string(),
            message: format!("task not found: {}", id),
        }
    }
    fn already_deleted() -> Self {
        Self {
            code: "already_deleted".to_string(),
            message: "task has been deleted".to_string(),
        }
    }
    fn update_rejected_while_running() -> Self {
        Self {
            code: "update_rejected_running".to_string(),
            message: "cannot edit task fields while running/verifying".to_string(),
        }
    }
}

impl From<TaskOpError> for String {
    fn from(e: TaskOpError) -> Self {
        // When serialized to the CLI / invoke() caller, preserve `code` by
        // embedding a JSON-stringified payload. Callers that just want a message
        // can parse it back; ones that don't care just show it.
        serde_json::to_string(&e).unwrap_or_else(|_| e.message.clone())
    }
}

// ================ State machine ================

/// The exhaustive transition table from PRD §9.1 (v1.4, with lenient
/// verifying → running). Returns `true` if the transition is legal at the
/// machine level (actor/source guards are applied separately).
pub fn is_transition_legal(from: TaskStatus, to: TaskStatus) -> bool {
    use TaskStatus::*;
    matches!(
        (from, to),
        // Forward progression
        (Todo, Running)
        | (Running, Verifying)
        | (Running, Done)
        | (Running, Blocked)
        | (Running, Stopped)
        | (Verifying, Running)     // v1.4 lenient mode
        | (Verifying, Done)
        | (Verifying, Blocked)
        | (Verifying, Stopped)
        // Re-run / reset
        | (Blocked, Todo)
        | (Stopped, Todo)
        | (Done, Todo)
        | (Archived, Todo)
        // Archiving
        | (Done, Archived)
    )
}

// ================ Store ================

pub struct TaskStore {
    /// taskId → Task (full row)
    inner: Arc<RwLock<HashMap<String, Task>>>,
    jsonl_path: PathBuf,
}

impl TaskStore {
    /// Create a new store. Scans disk, runs crash-recovery migration on any
    /// running/verifying rows (PRD §9.1.1), and returns a handle with the live
    /// (post-recovery) map.
    pub fn new(data_dir: PathBuf) -> Self {
        let jsonl_path = data_dir.join("tasks.jsonl");
        if let Some(parent) = jsonl_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let (initial, needs_rewrite) = Self::load_and_recover(&jsonl_path);
        // Write back the recovery results synchronously so a second crash doesn't
        // lose the migration. This runs during app `setup()` before any command is
        // dispatchable, so there is no contention.
        if needs_rewrite {
            if let Err(e) = Self::persist_locked(&jsonl_path, &initial) {
                ulog_warn!("[task] crash-recovery persist failed: {}", e);
            } else {
                ulog_info!("[task] crash-recovery applied: leftover running/verifying → blocked");
            }
        }
        Self {
            inner: Arc::new(RwLock::new(initial)),
            jsonl_path,
        }
    }

    fn load_and_recover(path: &Path) -> (HashMap<String, Task>, bool) {
        let mut map = Self::load_jsonl(path);
        let now = now_ms();
        let mut changed = false;
        for task in map.values_mut() {
            if matches!(task.status, TaskStatus::Running | TaskStatus::Verifying) {
                let from = task.status;
                task.status = TaskStatus::Blocked;
                task.updated_at = now;
                task.status_history.push(StatusTransition {
                    from: Some(from),
                    to: TaskStatus::Blocked,
                    at: now,
                    actor: TransitionActor::System,
                    message: Some("crash recovery — app restarted while task was active".to_string()),
                    source: Some(TransitionSource::Crash),
                });
                changed = true;
            }
        }
        (map, changed)
    }

    fn load_jsonl(path: &Path) -> HashMap<String, Task> {
        let mut map: HashMap<String, Task> = HashMap::new();
        let Ok(file) = fs::File::open(path) else {
            return map;
        };
        let reader = BufReader::new(file);
        let mut ok = 0usize;
        let mut bad = 0usize;
        let mut io_err = 0usize;
        for (i, line) in reader.lines().enumerate() {
            let raw = match line {
                Ok(l) => l,
                Err(e) => {
                    io_err += 1;
                    ulog_warn!("[task] line {} I/O error, skipped: {}", i + 1, e);
                    continue;
                }
            };
            if raw.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Task>(&raw) {
                Ok(t) => {
                    map.insert(t.id.clone(), t);
                    ok += 1;
                }
                Err(e) => {
                    bad += 1;
                    ulog_warn!("[task] line {} malformed, skipped: {}", i + 1, e);
                }
            }
        }
        ulog_info!(
            "[task] loaded {} task(s) from disk ({} malformed, {} io-err)",
            ok,
            bad,
            io_err
        );
        map
    }

    /// Atomically rewrite the jsonl file from the provided map.
    ///
    /// Crash-durable atomic-write pattern: write + `sync_all` the tmp file, then
    /// rename, then fsync the containing directory. On any error the tmp file is
    /// best-effort unlinked. Caller MUST hold `inner.write()`; this function does
    /// not take the lock itself.
    fn persist_locked(
        path: &Path,
        map: &HashMap<String, Task>,
    ) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create tasks dir: {}", e))?;
        }
        let tmp = path.with_extension("jsonl.tmp");
        let write_res = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp)
                .map_err(|e| format!("Failed to open tasks tmp: {}", e))?;
            // Deterministic ordering by createdAt for easier diffing.
            let mut rows: Vec<&Task> = map.values().collect();
            rows.sort_by_key(|t| t.created_at);
            for t in rows {
                let line = serde_json::to_string(t)
                    .map_err(|e| format!("serialize task: {}", e))?;
                file.write_all(line.as_bytes())
                    .map_err(|e| format!("write task line: {}", e))?;
                file.write_all(b"\n")
                    .map_err(|e| format!("write newline: {}", e))?;
            }
            file.flush()
                .map_err(|e| format!("flush tasks tmp: {}", e))?;
            // Durability: force the tmp file contents to disk BEFORE rename.
            file.sync_all()
                .map_err(|e| format!("sync tasks tmp: {}", e))?;
            Ok(())
        })();
        if let Err(e) = write_res {
            let _ = fs::remove_file(&tmp); // best-effort cleanup
            return Err(e);
        }
        if let Err(e) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp); // best-effort cleanup
            return Err(format!("rename tasks.jsonl: {}", e));
        }
        // Best-effort: fsync the containing directory so the rename is durable.
        // Failure here is logged but not fatal — the rename is already committed
        // at kernel level; dir-fsync is just power-loss insurance.
        if let Some(parent) = path.parent() {
            if let Ok(dir) = fs::File::open(parent) {
                let _ = dir.sync_all();
            }
        }
        ulog_debug!("[task] atomically persisted {} tasks", map.len());
        Ok(())
    }

    // ---- Create ----

    pub async fn create_direct(&self, input: TaskCreateDirectInput) -> Result<Task, String> {
        // Validate workspace_path + name up front so we don't half-write.
        let workspace_path = canonicalize_workspace_path(&input.workspace_path)?;
        validate_task_name(&input.name)?;
        let now = now_ms();
        let id = Uuid::new_v4().to_string();
        // task_docs_dir() internally validates `id`, but `id` is our freshly-minted
        // UUID so it always passes; the guard is for callers that pass external ids.
        let task_dir = task_docs_dir(&workspace_path, &id)?;

        let t = Task {
            id: id.clone(),
            name: input.name,
            executor: input.executor,
            description: input.description,
            workspace_id: input.workspace_id,
            workspace_path: workspace_path.clone(),
            execution_mode: input.execution_mode,
            cron_task_id: None,
            run_mode: input.run_mode,
            end_conditions: input.end_conditions,
            runtime: input.runtime,
            runtime_config: input.runtime_config,
            source_thought_id: input.source_thought_id,
            session_ids: Vec::new(),
            status: TaskStatus::Todo,
            tags: input.tags,
            created_at: now,
            updated_at: now,
            last_executed_at: None,
            status_history: vec![StatusTransition {
                from: None,
                to: TaskStatus::Todo,
                at: now,
                actor: TransitionActor::User,
                message: Some("created (direct)".to_string()),
                source: Some(TransitionSource::Ui),
            }],
            notification: input.notification,
            dispatch_origin: TaskDispatchOrigin::Direct,
            deleted: false,
            deleted_at: None,
        };

        // Build the proposed next map, persist FIRST, then swap in-memory state.
        // This prevents the "persist failed but we already mutated memory" class
        // of bugs — the store stays consistent with disk.
        let mut inner = self.inner.write().await;
        let mut next = inner.clone();
        next.insert(id.clone(), t.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;

        // JSONL committed — now materialize the task.md payload. Failing at this
        // point leaves an orphan JSONL row, which is recoverable on next boot
        // (the row is visible but `.task/<id>/task.md` is missing; we log loudly).
        fs::create_dir_all(&task_dir)
            .map_err(|e| format!("Failed to create task doc dir: {}", e))?;
        let task_md = task_dir.join("task.md");
        if let Err(e) = write_atomic_text(&task_md, &input.task_md_content) {
            ulog_warn!(
                "[task] jsonl committed but task.md write failed id={} — recoverable on UI reopen: {}",
                id, e
            );
            return Err(format!("Failed to write task.md: {}", e));
        }
        *inner = next;
        ulog_info!("[task] created direct id={} name={}", id, t.name);
        Ok(t)
    }

    pub async fn create_from_alignment(
        &self,
        input: TaskCreateFromAlignmentInput,
    ) -> Result<Task, String> {
        let workspace_path = canonicalize_workspace_path(&input.workspace_path)?;
        validate_task_name(&input.name)?;
        validate_safe_id(&input.alignment_session_id, "alignmentSessionId")?;

        let src = task_docs_dir(&workspace_path, &input.alignment_session_id)?;
        if !src.exists() {
            return Err(format!("alignment dir not found: {}", src.display()));
        }

        let now = now_ms();
        let id = Uuid::new_v4().to_string();
        let dst = task_docs_dir(&workspace_path, &id)?;

        let t = Task {
            id: id.clone(),
            name: input.name,
            executor: input.executor,
            description: input.description,
            workspace_id: input.workspace_id,
            workspace_path: workspace_path.clone(),
            execution_mode: input.execution_mode,
            cron_task_id: None,
            run_mode: input.run_mode,
            end_conditions: input.end_conditions,
            runtime: input.runtime,
            runtime_config: input.runtime_config,
            source_thought_id: input.source_thought_id,
            session_ids: Vec::new(),
            status: TaskStatus::Todo,
            tags: input.tags,
            created_at: now,
            updated_at: now,
            last_executed_at: None,
            status_history: vec![StatusTransition {
                from: None,
                to: TaskStatus::Todo,
                at: now,
                actor: TransitionActor::Agent,
                message: Some("created (ai-aligned)".to_string()),
                source: Some(TransitionSource::Cli),
            }],
            notification: input.notification,
            dispatch_origin: TaskDispatchOrigin::AiAligned,
            deleted: false,
            deleted_at: None,
        };

        // Transactional order (PRD design):
        // 1. Persist the row to jsonl FIRST. If this fails, the alignment dir is
        //    untouched — retry is safe.
        // 2. Move the alignment dir to `.task/<newId>/`. If this fails, we unwind
        //    the row from jsonl so the store stays consistent.
        // 3. Swap in-memory state only after both succeed.
        let mut inner = self.inner.write().await;
        let mut next = inner.clone();
        next.insert(id.clone(), t.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;

        if let Err(e) = move_alignment_dir(&src, &dst) {
            // Roll back jsonl — remove the task row we just persisted.
            next.remove(&id);
            if let Err(persist_err) = Self::persist_locked(&self.jsonl_path, &next) {
                ulog_warn!(
                    "[task] create_from_alignment rollback failed: {} (original error: {})",
                    persist_err,
                    e
                );
            }
            return Err(format!("move alignment dir: {}", e));
        }

        *inner = next;
        ulog_info!("[task] created ai-aligned id={} name={}", id, t.name);
        Ok(t)
    }

    // ---- Read ----

    pub async fn get(&self, id: &str) -> Option<Task> {
        self.inner.read().await.get(id).cloned()
    }

    pub async fn list(&self, filter: TaskListFilter) -> Vec<Task> {
        let inner = self.inner.read().await;
        let mut out: Vec<Task> = inner.values().cloned().collect();

        if !filter.include_deleted.unwrap_or(false) {
            out.retain(|t| !t.deleted);
        }
        if let Some(ws) = filter.workspace_id.as_deref() {
            out.retain(|t| t.workspace_id == ws);
        }
        if let Some(status_filter) = filter.status.as_ref() {
            out.retain(|t| status_filter.matches(t.status));
        }
        if let Some(tag) = filter.tag.as_deref() {
            let needle = tag.to_lowercase();
            out.retain(|t| t.tags.iter().any(|x| x.to_lowercase() == needle));
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
    }

    // ---- Update fields ----

    pub async fn update(&self, input: TaskUpdateInput) -> Result<Task, String> {
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(&input.id)
            .ok_or_else(|| String::from(TaskOpError::not_found(&input.id)))?
            .clone();
        if existing.deleted {
            return Err(String::from(TaskOpError::already_deleted()));
        }
        if matches!(existing.status, TaskStatus::Running | TaskStatus::Verifying) {
            return Err(String::from(
                TaskOpError::update_rejected_while_running(),
            ));
        }
        let mut updated = existing;
        if let Some(v) = input.name {
            validate_task_name(&v)?;
            updated.name = v;
        }
        if let Some(v) = input.executor {
            updated.executor = v;
        }
        if let Some(v) = input.description {
            updated.description = Some(v);
        }
        if let Some(v) = input.execution_mode {
            updated.execution_mode = v;
        }
        if let Some(v) = input.run_mode {
            updated.run_mode = Some(v);
        }
        if let Some(v) = input.end_conditions {
            updated.end_conditions = Some(v);
        }
        if let Some(v) = input.runtime {
            updated.runtime = Some(v);
        }
        if let Some(v) = input.runtime_config {
            updated.runtime_config = Some(v);
        }
        if let Some(v) = input.tags {
            updated.tags = v;
        }
        if let Some(v) = input.notification {
            updated.notification = Some(v);
        }
        updated.updated_at = now_ms();

        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok(updated)
    }

    // ---- Status transition ----

    /// Apply a status transition with PRD §10.2.1 core semantics:
    ///   1. transition-table legality
    ///   2. actor/source guards (archived user-only, agent→cli only,
    ///      `Deleted` never accepted here — only `delete()` may write it)
    ///   3. persist-then-swap atomic history append
    ///
    /// `actor` is explicit (not inferred): callers MUST assert their actor. The
    /// Tauri command layer sets `actor=User, source=Ui` authoritatively so a
    /// malicious renderer cannot spoof `agent` / `system`.
    ///
    /// Returns `(updated_task, transition_written)`. Progress.md / notification /
    /// SSE side-effects are caller responsibility (Phase 4/5 wiring).
    pub async fn update_status(
        &self,
        input: TaskUpdateStatusInput,
    ) -> Result<(Task, StatusTransition), String> {
        // `Deleted` is reserved for `delete()`.
        if input.status == TaskStatus::Deleted {
            return Err(String::from(TaskOpError::invalid_transition(
                TaskStatus::Deleted,
                TaskStatus::Deleted,
            )));
        }

        let mut inner = self.inner.write().await;
        let existing = inner
            .get(&input.id)
            .ok_or_else(|| String::from(TaskOpError::not_found(&input.id)))?
            .clone();
        if existing.deleted {
            return Err(String::from(TaskOpError::already_deleted()));
        }

        let from = existing.status;
        let to = input.status;

        // 1. legality
        if !is_transition_legal(from, to) {
            return Err(String::from(TaskOpError::invalid_transition(from, to)));
        }

        // 2. actor/source guard
        let actor = input.actor;
        let source = input.source;
        if to == TaskStatus::Archived && actor != TransitionActor::User {
            return Err(String::from(TaskOpError::archive_user_only()));
        }
        if actor == TransitionActor::Agent && source != Some(TransitionSource::Cli) {
            return Err(String::from(TaskOpError::agent_source_must_be_cli()));
        }

        let now = now_ms();
        let mut updated = existing;
        updated.status = to;
        updated.updated_at = now;
        if to == TaskStatus::Running {
            updated.last_executed_at = Some(now);
        }

        let transition = StatusTransition {
            from: Some(from),
            to,
            at: now,
            actor,
            message: input.message,
            source,
        };
        updated.status_history.push(transition.clone());

        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        ulog_info!(
            "[task] status {}: {} → {} (actor={}, source={:?})",
            updated.id,
            from.as_str(),
            to.as_str(),
            actor.as_str(),
            source.map(|s| s.as_str())
        );
        Ok((updated, transition))
    }

    // ---- Convenience: append session / update progress / cron link ----

    pub async fn append_session(&self, id: &str, session_id: &str) -> Result<Task, String> {
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        let mut updated = existing;
        if !updated.session_ids.iter().any(|s| s == session_id) {
            updated.session_ids.push(session_id.to_string());
            updated.updated_at = now_ms();
            let mut next = inner.clone();
            next.insert(updated.id.clone(), updated.clone());
            Self::persist_locked(&self.jsonl_path, &next)?;
            *inner = next;
        }
        Ok(updated)
    }

    /// Append a human-readable line to progress.md without writing to `statusHistory`.
    pub async fn update_progress(&self, id: &str, msg: &str) -> Result<(), String> {
        let inner = self.inner.read().await;
        let task = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        drop(inner);
        let path = task_docs_dir(&task.workspace_path, &task.id)?.join("progress.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir progress: {}", e))?;
        }
        let line = format!(
            "- [{}] {}\n",
            chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ"),
            msg
        );
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("open progress.md: {}", e))?;
        file.write_all(line.as_bytes())
            .map_err(|e| format!("write progress.md: {}", e))?;
        Ok(())
    }

    pub async fn set_cron_task_id(
        &self,
        id: &str,
        cron_id: Option<String>,
    ) -> Result<Task, String> {
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        let mut updated = existing;
        updated.cron_task_id = cron_id;
        updated.updated_at = now_ms();
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok(updated)
    }

    // ---- Archive / Delete ----

    /// User-only archive entry. Emits `Done → Archived` with actor=user.
    pub async fn archive(&self, id: &str, message: Option<String>) -> Result<Task, String> {
        let (task, _) = self
            .update_status(TaskUpdateStatusInput {
                id: id.to_string(),
                status: TaskStatus::Archived,
                message,
                actor: TransitionActor::User,
                source: Some(TransitionSource::Ui),
            })
            .await?;
        Ok(task)
    }

    /// Soft-delete. Writes a proper synthetic `→ Deleted` pseudo-transition to
    /// `statusHistory` (PRD §10.2.2), sets `status=Deleted`, and flips the
    /// `deleted` flag. Downstream auditors can filter `statusHistory` on
    /// `to == Deleted` to find all removed tasks. Physical cleanup happens
    /// out-of-band (§9.5, 30-day retention).
    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        if existing.deleted {
            return Ok(());
        }
        let mut updated = existing;
        let now = now_ms();
        let from = updated.status;
        updated.status_history.push(StatusTransition {
            from: Some(from),
            to: TaskStatus::Deleted,
            at: now,
            actor: TransitionActor::User,
            message: Some("deleted".to_string()),
            source: Some(TransitionSource::Ui),
        });
        updated.status = TaskStatus::Deleted;
        updated.deleted = true;
        updated.deleted_at = Some(now);
        updated.updated_at = now;
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated);
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        ulog_info!("[task] soft-deleted id={}", id);
        Ok(())
    }
}

// ================ Helpers ================

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Strict id validator — rejects `..`, path separators, `\0`, leading `.`, and
/// anything not ASCII alphanumeric / `-` / `_`. This is the pit-of-success guard
/// against `taskId="../../etc/passwd"` and similar injections (CC + Codex review).
pub fn validate_safe_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 {
        return Err(format!("{} is empty or too long", label));
    }
    if value.starts_with('.') {
        return Err(format!("{} may not start with '.'", label));
    }
    for ch in value.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_';
        if !ok {
            return Err(format!("{} contains invalid character {:?}", label, ch));
        }
    }
    Ok(())
}

/// Clean + validate a caller-supplied workspace path. Requires non-empty absolute
/// path. Does NOT perform `.canonicalize()` (that would require the path to exist
/// at call time — tasks may reference workspaces that have been moved).
fn canonicalize_workspace_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("workspacePath is empty".to_string());
    }
    let p = Path::new(trimmed);
    if !p.is_absolute() {
        return Err(format!("workspacePath must be absolute: {}", trimmed));
    }
    Ok(trimmed.to_string())
}

fn validate_task_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("task name is empty".to_string());
    }
    // PRD §3.2 says "短，<60 字符" — enforce char count (not bytes).
    if trimmed.chars().count() > 120 {
        return Err("task name exceeds 120 chars".to_string());
    }
    Ok(())
}

/// Resolve `<workspace>/.task/<id>/` and verify the resolved path stays inside
/// `<workspace>/.task/`. This is the pit-of-success guard — centralizing path
/// join + boundary check here means no caller can accidentally escape the
/// sandbox via a bad id.
pub fn task_docs_dir(workspace_path: &str, task_id: &str) -> Result<PathBuf, String> {
    validate_safe_id(task_id, "taskId")?;
    let ws = canonicalize_workspace_path(workspace_path)?;
    let base = PathBuf::from(&ws).join(".task");
    let resolved = base.join(task_id);
    // Defense in depth: after the `validate_safe_id` check above, any resolved
    // path must still lexically start with `<ws>/.task/`. This catches future
    // bypasses if the validator is weakened.
    if !resolved.starts_with(&base) {
        return Err(format!(
            "task_docs_dir escaped base: {} (base={})",
            resolved.display(),
            base.display()
        ));
    }
    Ok(resolved)
}

/// Crash-durable atomic text write: tmp write → sync_all → rename → cleanup
/// on any failure. Mirrors `persist_locked` guarantees for arbitrary files.
fn write_atomic_text(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let tmp = path.with_extension("tmp");
    let write_res = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)
            .map_err(|e| format!("open tmp: {}", e))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("write tmp: {}", e))?;
        file.flush().map_err(|e| format!("flush tmp: {}", e))?;
        file.sync_all().map_err(|e| format!("sync tmp: {}", e))?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename: {}", e));
    }
    Ok(())
}

/// Move `src` directory to `dst`. Tries `fs::rename` first (fast path, atomic on
/// the same filesystem). On cross-filesystem or other error, falls back to
/// `copy_dir_recursive` + `remove_dir_all(src)`. Symlinks and unusual file types
/// return `Err` — task docs must be plain files/dirs only.
fn move_alignment_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| format!("mkdir dst: {}", e))?;
    copy_dir_recursive(src, dst).map_err(|e| format!("copy: {}", e))?;
    fs::remove_dir_all(src).map_err(|e| format!("remove src: {}", e))?;
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            fs::create_dir_all(&target)?;
            copy_dir_recursive(&entry.path(), &target)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), target)?;
        } else {
            // Symlinks / sockets / fifos — refuse loudly rather than silently skip
            // (CC + Codex review: previous `// symlinks skipped` comment led to
            // cross-device semantics divergence when `fs::rename` preserved them
            // but the fallback dropped them).
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "unsupported file type in alignment dir: {}",
                    entry.path().display()
                ),
            ));
        }
    }
    Ok(())
}

// ================ Tauri commands ================
//
// The Tauri layer is the trust boundary for actor/source inference (PRD §10.2.1
// caller-inference table): UI button presses are authoritatively stamped as
// `actor=User, source=Ui`. The command DTOs therefore do NOT expose `actor`/
// `source` fields — a malicious renderer cannot spoof `agent` / `system`.
// Server-side callers (scheduler, CLI → Admin API) use the richer internal
// `TaskStore::update_status` API and supply their own trusted actor/source.
//
// Coordination with `ThoughtStore` (link / unlink `convertedTaskIds`) also lives
// in the command layer: it keeps `TaskStore` single-responsibility and lets us
// add SSE broadcast / notification dispatch here in later phases without
// touching the store.

pub type ManagedTaskStore = Arc<TaskStore>;

#[tauri::command]
pub async fn cmd_task_create_direct(
    task_state: tauri::State<'_, ManagedTaskStore>,
    thought_state: tauri::State<'_, crate::thought::ManagedThoughtStore>,
    input: TaskCreateDirectInput,
) -> Result<Task, String> {
    let source_thought_id = input.source_thought_id.clone();
    let created = task_state.create_direct(input).await?;
    if let Some(thought_id) = source_thought_id {
        if let Err(e) = thought_state.link_task(&thought_id, &created.id).await {
            ulog_warn!(
                "[task] created {} but thought link_task failed: {}",
                created.id,
                e
            );
        }
    }
    Ok(created)
}

#[tauri::command]
pub async fn cmd_task_create_from_alignment(
    task_state: tauri::State<'_, ManagedTaskStore>,
    thought_state: tauri::State<'_, crate::thought::ManagedThoughtStore>,
    input: TaskCreateFromAlignmentInput,
) -> Result<Task, String> {
    let source_thought_id = input.source_thought_id.clone();
    let created = task_state.create_from_alignment(input).await?;
    if let Some(thought_id) = source_thought_id {
        if let Err(e) = thought_state.link_task(&thought_id, &created.id).await {
            ulog_warn!(
                "[task] created {} but thought link_task failed: {}",
                created.id,
                e
            );
        }
    }
    Ok(created)
}

#[tauri::command]
pub async fn cmd_task_list(
    state: tauri::State<'_, ManagedTaskStore>,
    filter: Option<TaskListFilter>,
) -> Result<Vec<Task>, String> {
    Ok(state.list(filter.unwrap_or_default()).await)
}

#[tauri::command]
pub async fn cmd_task_get(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
) -> Result<Option<Task>, String> {
    Ok(state.get(&id).await)
}

#[tauri::command]
pub async fn cmd_task_update(
    state: tauri::State<'_, ManagedTaskStore>,
    input: TaskUpdateInput,
) -> Result<Task, String> {
    state.update(input).await
}

#[tauri::command]
pub async fn cmd_task_update_status(
    state: tauri::State<'_, ManagedTaskStore>,
    input: UiTaskUpdateStatusInput,
) -> Result<Task, String> {
    // Trust boundary: UI callers are stamped as user/ui here. The internal
    // `update_status` API remains available for scheduler / watchdog / crash /
    // endCondition / rerun paths with their own actor/source context.
    state
        .update_status(TaskUpdateStatusInput {
            id: input.id,
            status: input.status,
            message: input.message,
            actor: TransitionActor::User,
            source: Some(TransitionSource::Ui),
        })
        .await
        .map(|(t, _)| t)
}

#[tauri::command]
pub async fn cmd_task_update_progress(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    message: String,
) -> Result<(), String> {
    state.update_progress(&id, &message).await
}

#[tauri::command]
pub async fn cmd_task_append_session(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    session_id: String,
) -> Result<Task, String> {
    state.append_session(&id, &session_id).await
}

#[tauri::command]
pub async fn cmd_task_archive(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    message: Option<String>,
) -> Result<Task, String> {
    state.archive(&id, message).await
}

#[tauri::command]
pub async fn cmd_task_delete(
    task_state: tauri::State<'_, ManagedTaskStore>,
    thought_state: tauri::State<'_, crate::thought::ManagedThoughtStore>,
    id: String,
) -> Result<(), String> {
    // Capture source_thought_id before delete so we can unlink after.
    let source_thought_id = task_state.get(&id).await.and_then(|t| t.source_thought_id);
    task_state.delete(&id).await?;
    if let Some(thought_id) = source_thought_id {
        if let Err(e) = thought_state.unlink_task(&thought_id, &id).await {
            ulog_warn!("[task] deleted {} but thought unlink_task failed: {}", id, e);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_task_set_cron(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    cron_task_id: Option<String>,
) -> Result<Task, String> {
    state.set_cron_task_id(&id, cron_task_id).await
}

// ================ Tests ================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_direct_input(ws: &PathBuf) -> TaskCreateDirectInput {
        TaskCreateDirectInput {
            name: "升级 openclaw lark 适配器".to_string(),
            executor: TaskExecutor::Agent,
            description: None,
            workspace_id: "ws-myagents".to_string(),
            workspace_path: ws.to_string_lossy().into_owned(),
            task_md_content: "跑通 v2.4".to_string(),
            execution_mode: TaskExecutionMode::Once,
            run_mode: None,
            end_conditions: None,
            runtime: None,
            runtime_config: None,
            source_thought_id: Some("thought-1".to_string()),
            tags: vec!["MyAgents".to_string()],
            notification: None,
        }
    }

    fn status_input(
        id: &str,
        to: TaskStatus,
        actor: TransitionActor,
        source: Option<TransitionSource>,
    ) -> TaskUpdateStatusInput {
        TaskUpdateStatusInput {
            id: id.to_string(),
            status: to,
            message: None,
            actor,
            source,
        }
    }

    #[test]
    fn transition_table_allows_lenient_verifying_to_running() {
        use TaskStatus::*;
        assert!(is_transition_legal(Verifying, Running));
        assert!(is_transition_legal(Running, Verifying));
        assert!(is_transition_legal(Verifying, Done));
        assert!(is_transition_legal(Running, Done));
        assert!(is_transition_legal(Done, Archived));
        assert!(is_transition_legal(Archived, Todo));
    }

    #[test]
    fn transition_table_rejects_bad_paths() {
        use TaskStatus::*;
        assert!(!is_transition_legal(Todo, Done));        // no skipping run
        assert!(!is_transition_legal(Todo, Archived));    // archive only from done
        assert!(!is_transition_legal(Blocked, Archived)); // must reset first
        assert!(!is_transition_legal(Stopped, Archived));
        assert!(!is_transition_legal(Running, Archived));
    }

    #[tokio::test]
    async fn create_direct_writes_task_md_and_history() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        std::fs::create_dir_all(&store_dir).unwrap();
        let store = TaskStore::new(store_dir);

        let input = sample_direct_input(&ws);
        let created = store.create_direct(input).await.unwrap();
        assert_eq!(created.status, TaskStatus::Todo);
        assert_eq!(created.status_history.len(), 1);
        assert_eq!(created.status_history[0].to, TaskStatus::Todo);
        assert_eq!(created.status_history[0].actor, TransitionActor::User);
        assert_eq!(created.dispatch_origin, TaskDispatchOrigin::Direct);

        // task.md materialized
        let md = ws.join(".task").join(&created.id).join("task.md");
        assert!(md.exists());
        let body = std::fs::read_to_string(&md).unwrap();
        assert_eq!(body, "跑通 v2.4");
    }

    #[tokio::test]
    async fn update_status_appends_history_and_persists() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());

        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        // todo → running (system)
        let (t, tr) = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        assert_eq!(t.status, TaskStatus::Running);
        assert_eq!(tr.from, Some(TaskStatus::Todo));
        assert_eq!(t.status_history.len(), 2);
        assert!(t.last_executed_at.is_some());

        // running → verifying (agent/cli)
        let (t, _) = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Verifying,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();
        assert_eq!(t.status, TaskStatus::Verifying);

        // lenient: verifying → running (v1.4)
        let (t, _) = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();
        assert_eq!(t.status, TaskStatus::Running);

        // verify persistence across reopen
        drop(store);
        let store2 = TaskStore::new(store_dir);
        let reloaded = store2.get(&created.id).await.unwrap();
        // Crash recovery kicks in — running rows are rewritten to blocked at load.
        assert_eq!(reloaded.status, TaskStatus::Blocked);
        // 4 transitions from the runtime session + 1 crash-recovery transition.
        assert_eq!(reloaded.status_history.len(), 5);
        let last = reloaded.status_history.last().unwrap();
        assert_eq!(last.actor, TransitionActor::System);
        assert_eq!(last.source, Some(TransitionSource::Crash));
    }

    #[tokio::test]
    async fn update_status_rejects_invalid_transition() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .expect_err("illegal transition should fail");
        assert!(err.contains("invalid_transition"));
    }

    #[tokio::test]
    async fn update_status_rejects_deleted_as_target() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Deleted,
                TransitionActor::User,
                Some(TransitionSource::Ui),
            ))
            .await
            .expect_err("Deleted is delete()-only");
        assert!(err.contains("invalid_transition"));
    }

    #[tokio::test]
    async fn update_status_rejects_agent_without_cli_source() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();

        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Ui), // <-- wrong
            ))
            .await
            .expect_err("agent must come from cli");
        assert!(err.contains("agent_source_must_be_cli"));
    }

    #[tokio::test]
    async fn archive_rejects_non_user_actor() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        // todo → running → done
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();

        // agent cannot archive
        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Archived,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .expect_err("agent cannot archive");
        assert!(err.contains("archive_user_only"));

        // user can
        let archived = store.archive(&created.id, None).await.unwrap();
        assert_eq!(archived.status, TaskStatus::Archived);
    }

    #[tokio::test]
    async fn update_rejects_while_running() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();

        let err = store
            .update(TaskUpdateInput {
                id: created.id.clone(),
                name: Some("new".to_string()),
                executor: None,
                description: None,
                execution_mode: None,
                run_mode: None,
                end_conditions: None,
                runtime: None,
                runtime_config: None,
                tags: None,
                notification: None,
            })
            .await
            .expect_err("should reject");
        assert!(err.contains("update_rejected_running"));
    }

    #[tokio::test]
    async fn delete_soft_and_idempotent() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        store.delete(&created.id).await.unwrap();
        // list excludes deleted by default
        assert!(store.list(TaskListFilter::default()).await.is_empty());
        // include_deleted shows it
        let all = store
            .list(TaskListFilter {
                include_deleted: Some(true),
                ..Default::default()
            })
            .await;
        assert_eq!(all.len(), 1);
        assert!(all[0].deleted);
        // Delete writes a proper `→ Deleted` pseudo-transition (not from==to).
        assert_eq!(all[0].status, TaskStatus::Deleted);
        let last = all[0].status_history.last().unwrap();
        assert_eq!(last.to, TaskStatus::Deleted);
        assert_eq!(last.from, Some(TaskStatus::Todo));
        assert_eq!(last.actor, TransitionActor::User);

        // second delete is a no-op
        store.delete(&created.id).await.unwrap();
    }

    #[test]
    fn task_docs_dir_rejects_traversal() {
        // Setup: valid base workspace (must be absolute).
        let ws = "/tmp/myagents-task-test-ws".to_string();
        assert!(task_docs_dir(&ws, "../etc").is_err());
        assert!(task_docs_dir(&ws, "..").is_err());
        assert!(task_docs_dir(&ws, "a/b").is_err());
        assert!(task_docs_dir(&ws, "a\\b").is_err());
        assert!(task_docs_dir(&ws, ".hidden").is_err());
        assert!(task_docs_dir(&ws, "").is_err());
        assert!(task_docs_dir("relative/ws", "abc").is_err());
        assert!(task_docs_dir("", "abc").is_err());
        // Valid UUID-ish id works
        assert!(task_docs_dir(&ws, "abc-123_ok").is_ok());
    }

    #[tokio::test]
    async fn crash_recovery_rewrites_running_to_blocked_on_reload() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());
        let a = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let b = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &a.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        store
            .update_status(status_input(
                &b.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        store
            .update_status(status_input(
                &b.id,
                TaskStatus::Verifying,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();
        drop(store);

        let recovered = TaskStore::new(store_dir);
        let ra = recovered.get(&a.id).await.unwrap();
        let rb = recovered.get(&b.id).await.unwrap();
        assert_eq!(ra.status, TaskStatus::Blocked);
        assert_eq!(rb.status, TaskStatus::Blocked);
        // Each has a crash-recovery transition appended.
        assert_eq!(
            ra.status_history.last().unwrap().source,
            Some(TransitionSource::Crash)
        );
        assert_eq!(
            rb.status_history.last().unwrap().source,
            Some(TransitionSource::Crash)
        );
    }

    #[tokio::test]
    async fn status_filter_accepts_single_or_array() {
        use serde_json::json;
        // Single value
        let f: TaskListFilter =
            serde_json::from_value(json!({"status": "running"})).unwrap();
        assert!(f.status.is_some());
        // Array of values
        let f: TaskListFilter =
            serde_json::from_value(json!({"status": ["running", "done"]})).unwrap();
        assert!(f.status.is_some());
    }

    #[tokio::test]
    async fn dispatch_origin_and_run_mode_serialize_kebab_case() {
        // PRD §3.2 / TS shared types — these wire values must match exactly.
        let d = TaskDispatchOrigin::AiAligned;
        assert_eq!(serde_json::to_string(&d).unwrap(), "\"ai-aligned\"");
        let r = TaskRunMode::SingleSession;
        assert_eq!(serde_json::to_string(&r).unwrap(), "\"single-session\"");
    }

    #[tokio::test]
    async fn end_conditions_deadline_serializes_as_ms() {
        let ec = TaskEndConditions {
            deadline: Some(1_700_000_000_000),
            max_executions: Some(5),
            ai_can_exit: true,
        };
        let s = serde_json::to_string(&ec).unwrap();
        assert!(s.contains("\"deadline\":1700000000000"));
    }

    #[tokio::test]
    async fn concurrent_creates_preserve_all_rows() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));

        let mut handles = Vec::new();
        for i in 0..20 {
            let s = store.clone();
            let w = ws.clone();
            handles.push(tokio::spawn(async move {
                let mut input = sample_direct_input(&w);
                input.name = format!("task {}", i);
                s.create_direct(input).await.unwrap()
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let listed = store.list(TaskListFilter::default()).await;
        assert_eq!(listed.len(), 20);
    }

    #[tokio::test]
    async fn append_session_idempotent() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store.append_session(&created.id, "sess-1").await.unwrap();
        store.append_session(&created.id, "sess-1").await.unwrap();
        store.append_session(&created.id, "sess-2").await.unwrap();
        let reloaded = store.get(&created.id).await.unwrap();
        assert_eq!(reloaded.session_ids, vec!["sess-1".to_string(), "sess-2".to_string()]);
    }

    #[tokio::test]
    async fn update_progress_appends_to_file() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store.update_progress(&created.id, "round 1 complete").await.unwrap();
        store.update_progress(&created.id, "round 2 complete").await.unwrap();
        let path = ws.join(".task").join(&created.id).join("progress.md");
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("round 1 complete"));
        assert!(content.contains("round 2 complete"));
        assert_eq!(content.lines().count(), 2);
    }
}
