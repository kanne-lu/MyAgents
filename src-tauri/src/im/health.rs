// IM Health State — periodic persistence to ~/.myagents/im_bots/{botId}/state.json
// Used for Desktop UI status display, restart recovery, and diagnostics.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio::time::{interval, Duration};

use super::types::{ImActiveSession, ImHealthState, ImStatus};
use crate::{ulog_info, ulog_warn};

/// Persist interval (seconds)
const PERSIST_INTERVAL_SECS: u64 = 5;

/// Managed health state with periodic persistence
pub struct HealthManager {
    state: Arc<Mutex<ImHealthState>>,
    persist_path: PathBuf,
}

impl HealthManager {
    pub fn new(persist_path: PathBuf) -> Self {
        // Try to load existing state, or start fresh
        let state = if persist_path.exists() {
            match std::fs::read_to_string(&persist_path) {
                Ok(content) => serde_json::from_str::<ImHealthState>(&content).unwrap_or_default(),
                Err(_) => ImHealthState::default(),
            }
        } else {
            ImHealthState::default()
        };

        Self {
            state: Arc::new(Mutex::new(state)),
            persist_path,
        }
    }

    /// Get a clone of current health state
    pub async fn get_state(&self) -> ImHealthState {
        self.state.lock().await.clone()
    }

    /// Update status
    pub async fn set_status(&self, status: ImStatus) {
        self.state.lock().await.status = status;
    }

    /// Set bot username
    pub async fn set_bot_username(&self, username: Option<String>) {
        self.state.lock().await.bot_username = username;
    }

    /// Set error message
    pub async fn set_error(&self, message: Option<String>) {
        self.state.lock().await.error_message = message;
    }

    /// Increment restart count
    pub async fn increment_restart_count(&self) {
        self.state.lock().await.restart_count += 1;
    }

    /// Update uptime
    pub async fn set_uptime(&self, seconds: u64) {
        self.state.lock().await.uptime_seconds = seconds;
    }

    /// Update last message timestamp
    pub async fn set_last_message_at(&self, timestamp: String) {
        self.state.lock().await.last_message_at = Some(timestamp);
    }

    /// Update buffered messages count
    pub async fn set_buffered_messages(&self, count: usize) {
        self.state.lock().await.buffered_messages = count;
    }

    /// Update active sessions
    pub async fn set_active_sessions(&self, sessions: Vec<ImActiveSession>) {
        self.state.lock().await.active_sessions = sessions;
    }

    /// Add an active session
    pub async fn add_active_session(&self, session: ImActiveSession) {
        self.state.lock().await.active_sessions.push(session);
    }

    /// Remove an active session
    pub async fn remove_active_session(&self, session_key: &str) {
        self.state
            .lock()
            .await
            .active_sessions
            .retain(|s| s.session_key != session_key);
    }

    /// Reset state (on stop)
    pub async fn reset(&self) {
        let mut state = self.state.lock().await;
        *state = ImHealthState::default();
    }

    /// Persist current state to disk
    pub async fn persist(&self) -> Result<(), String> {
        let mut state = self.state.lock().await;
        state.last_persisted = chrono::Utc::now().to_rfc3339();

        let json = serde_json::to_string_pretty(&*state)
            .map_err(|e| format!("Serialize error: {}", e))?;

        // Ensure parent directory exists
        if let Some(parent) = self.persist_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create health dir: {}", e))?;
        }

        std::fs::write(&self.persist_path, json)
            .map_err(|e| format!("Failed to write health state: {}", e))?;

        Ok(())
    }

    /// Start periodic persistence task (runs until shutdown)
    pub fn start_persist_loop(
        &self,
        mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
    ) -> tokio::task::JoinHandle<()> {
        let state = Arc::clone(&self.state);
        let persist_path = self.persist_path.clone();

        tokio::spawn(async move {
            let mut tick = interval(Duration::from_secs(PERSIST_INTERVAL_SECS));

            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let mut s = state.lock().await;
                        s.last_persisted = chrono::Utc::now().to_rfc3339();
                        let json = serde_json::to_string_pretty(&*s).unwrap_or_default();
                        drop(s);

                        if let Some(parent) = persist_path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if let Err(e) = std::fs::write(&persist_path, &json) {
                            ulog_warn!("[im-health] Failed to persist: {}", e);
                        }
                    }
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            ulog_info!("[im-health] Persist loop shutting down");
                            break;
                        }
                    }
                }
            }
        })
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// ~/.myagents/
fn myagents_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
}

/// ~/.myagents/im_bots/{botId}/
/// Panics if bot_id contains path separators or `..` (defense in depth).
pub fn bot_data_dir(bot_id: &str) -> PathBuf {
    assert!(
        !bot_id.is_empty()
            && !bot_id.contains('/')
            && !bot_id.contains('\\')
            && !bot_id.contains(".."),
        "[im-health] Invalid bot_id for path construction: {:?}",
        bot_id
    );
    myagents_dir().join("im_bots").join(bot_id)
}

/// v3 path: ~/.myagents/im_bots/{botId}/state.json
pub fn bot_health_path(bot_id: &str) -> PathBuf {
    bot_data_dir(bot_id).join("state.json")
}

/// v3 path: ~/.myagents/im_bots/{botId}/buffer.json
pub fn bot_buffer_path(bot_id: &str) -> PathBuf {
    bot_data_dir(bot_id).join("buffer.json")
}

/// v3 path: ~/.myagents/im_bots/{botId}/dedup.json
pub fn bot_dedup_path(bot_id: &str) -> PathBuf {
    bot_data_dir(bot_id).join("dedup.json")
}

// ---------------------------------------------------------------------------
// Legacy path helpers (private, migration only)
// ---------------------------------------------------------------------------

/// v1 legacy: single-bot era — ~/.myagents/im_state.json
fn legacy_health_path() -> PathBuf { myagents_dir().join("im_state.json") }
/// v1 legacy: single-bot era — ~/.myagents/im_buffer.json
fn legacy_buffer_path() -> PathBuf { myagents_dir().join("im_buffer.json") }

/// v2 flat: multi-bot era — ~/.myagents/im_{botId}_state.json
fn flat_health_path(bot_id: &str) -> PathBuf { myagents_dir().join(format!("im_{}_state.json", bot_id)) }
/// v2 flat: multi-bot era — ~/.myagents/im_{botId}_buffer.json
fn flat_buffer_path(bot_id: &str) -> PathBuf { myagents_dir().join(format!("im_{}_buffer.json", bot_id)) }
/// v2 flat: multi-bot era — ~/.myagents/im_{botId}_dedup.json
fn flat_dedup_path(bot_id: &str) -> PathBuf { myagents_dir().join(format!("im_{}_dedup.json", bot_id)) }

// ---------------------------------------------------------------------------
// Migration: v1 (single-bot) + v2 (flat) → v3 (subdir)
// ---------------------------------------------------------------------------

static ORPHAN_CLEANUP: std::sync::Once = std::sync::Once::new();

/// Migrate legacy/flat files to v3 subdir structure, then clean orphans once.
pub fn migrate_legacy_files(bot_id: &str) {
    // Ensure target directory exists
    let target_dir = bot_data_dir(bot_id);
    if let Err(e) = std::fs::create_dir_all(&target_dir) {
        ulog_warn!("[im-health] Failed to create bot data dir {:?}: {}, skipping migration", target_dir, e);
        return;
    }

    // --- v1: single-bot era → v3 subdir ---
    migrate_single_file(
        &legacy_health_path(),
        &bot_health_path(bot_id),
        "health",
    );
    migrate_single_file(
        &legacy_buffer_path(),
        &bot_buffer_path(bot_id),
        "buffer",
    );

    // --- v2: flat multi-bot → v3 subdir ---
    migrate_flat_file(&flat_health_path(bot_id), &bot_health_path(bot_id), "health");
    migrate_flat_file(&flat_buffer_path(bot_id), &bot_buffer_path(bot_id), "buffer");
    migrate_flat_file(&flat_dedup_path(bot_id), &bot_dedup_path(bot_id), "dedup");

    // --- One-time cleanup of orphaned flat files + legacy markers ---
    ORPHAN_CLEANUP.call_once(|| {
        cleanup_orphaned_flat_files();
        cleanup_legacy_markers();
    });
}

/// v1 migration: copy then rename original to `.migrated`.
fn migrate_single_file(legacy: &Path, target: &Path, label: &str) {
    if !legacy.exists() || target.exists() {
        return;
    }
    match std::fs::copy(legacy, target) {
        Ok(_) => {
            ulog_info!("[im-health] Migrated legacy {} → {:?}", label, target);
            let migrated = legacy.with_extension("json.migrated");
            if let Err(e) = std::fs::rename(legacy, &migrated) {
                ulog_warn!("[im-health] Failed to rename legacy {} to .migrated: {}", label, e);
            }
        }
        Err(e) => {
            ulog_warn!("[im-health] Failed to migrate legacy {} file: {}", label, e);
        }
    }
}

/// v2 flat migration: copy then delete source (per-bot file, no sharing concern).
fn migrate_flat_file(src: &Path, dst: &Path, label: &str) {
    if !src.exists() || dst.exists() {
        return;
    }
    match std::fs::copy(src, dst) {
        Ok(_) => {
            if let Err(e) = std::fs::remove_file(src) {
                ulog_warn!("[im-health] Migrated flat {} → {:?} but failed to remove source: {}", label, dst, e);
            } else {
                ulog_info!("[im-health] Migrated flat {} → {:?}", label, dst);
            }
        }
        Err(e) => ulog_warn!("[im-health] Failed to migrate flat {}: {}", label, e),
    }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/// Delete all persisted files for a bot (called when bot config is removed).
pub fn cleanup_bot_data(bot_id: &str) {
    // Remove v3 subdir
    let dir = bot_data_dir(bot_id);
    if dir.exists() {
        match std::fs::remove_dir_all(&dir) {
            Ok(_) => ulog_info!("[im-health] Cleaned bot data dir: {}", bot_id),
            Err(e) => ulog_warn!("[im-health] Failed to remove bot dir {:?}: {}", dir, e),
        }
    }

    // Clean up any residual v2 flat files
    for path in [flat_health_path(bot_id), flat_buffer_path(bot_id), flat_dedup_path(bot_id)] {
        let _ = std::fs::remove_file(&path);
    }
}

/// Remove v1 legacy `.migrated` marker files.
fn cleanup_legacy_markers() {
    let dir = myagents_dir();
    for name in ["im_state.json.migrated", "im_buffer.json.migrated"] {
        let path = dir.join(name);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
            ulog_info!("[im-health] Cleaned legacy marker: {}", name);
        }
    }
}

/// Scan ~/.myagents/ for orphaned v2 flat files (bot IDs not in config.json).
fn cleanup_orphaned_flat_files() {
    let dir = myagents_dir();
    let active_ids = read_active_bot_ids(&dir);
    // If we can't read config, don't delete anything (safety)
    if active_ids.is_none() {
        return;
    }
    let active_ids = active_ids.unwrap();

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("im_")
            && (name.ends_with("_state.json")
                || name.ends_with("_buffer.json")
                || name.ends_with("_dedup.json"))
        {
            if let Some(bot_id) = extract_bot_id_from_flat_filename(&name) {
                // Skip active bots (their files will be migrated on next start)
                if active_ids.contains(&bot_id) {
                    continue;
                }
                let _ = std::fs::remove_file(entry.path());
                ulog_info!("[im-health] Cleaned orphaned flat file: {}", name);
            }
        }
    }
}

/// Read active bot IDs from config.json. Returns None on any read/parse error.
fn read_active_bot_ids(myagents: &Path) -> Option<HashSet<String>> {
    let config_path = myagents.join("config.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    let config: serde_json::Value = serde_json::from_str(&content).ok()?;
    let bots = config.get("imBotConfigs")?.as_array()?;
    Some(
        bots.iter()
            .filter_map(|b| b.get("id")?.as_str().map(|s| s.to_string()))
            .collect(),
    )
}

/// Extract bot_id from flat filename like "im_{botId}_state.json".
fn extract_bot_id_from_flat_filename(name: &str) -> Option<String> {
    let name = name.strip_prefix("im_")?;
    // Find the suffix (_state.json, _buffer.json, _dedup.json)
    for suffix in ["_state.json", "_buffer.json", "_dedup.json"] {
        if let Some(bot_id) = name.strip_suffix(suffix) {
            if !bot_id.is_empty() {
                return Some(bot_id.to_string());
            }
        }
    }
    None
}
