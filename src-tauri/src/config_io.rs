//! Shared `~/.myagents/config.json` read-modify-write helper.
//!
//! The renderer, Node sidecar, and Rust commands coordinate on the same
//! `config.json.lock` directory. Directory creation is atomic across processes
//! on supported app filesystems and is available from all three runtimes without
//! adding a platform-specific dependency.
//!
//! Pattern 5 (Single-Writer Invariant) — lock acquisition + stale-recovery now
//! lives in `crate::utils::file_lock`; this module just composes it.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::utils::file_lock::{with_file_lock_blocking, FileLockError, FileLockOptions};

fn read_config_json(config_path: &Path) -> Result<serde_json::Value, String> {
    if !config_path.exists() {
        return Ok(serde_json::json!({}));
    }

    let content = fs::read_to_string(config_path)
        .map_err(|e| format!("[config-io] Cannot read config.json: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("[config-io] Cannot parse config.json: {}", e))
}

fn write_all_synced(path: &Path, content: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("[config-io] Cannot open tmp config: {}", e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("[config-io] Cannot write tmp config: {}", e))?;
    file.sync_all()
        .map_err(|e| format!("[config-io] Cannot fsync tmp config: {}", e))?;
    Ok(())
}

fn fsync_parent_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        if let Some(parent) = path.parent() {
            let dir = File::open(parent)
                .map_err(|e| format!("[config-io] Cannot open config dir for fsync: {}", e))?;
            dir.sync_all()
                .map_err(|e| format!("[config-io] Cannot fsync config dir: {}", e))?;
        }
    }
    Ok(())
}

/// Re-read `config.json` under lock, apply `mutator`, and atomically publish it.
///
/// `keep_backup` preserves existing `.bak` behavior for call sites that already
/// created one before this helper was introduced.
pub fn with_config_lock<F>(
    config_path: &Path,
    keep_backup: bool,
    mutator: F,
) -> Result<serde_json::Value, String>
where
    F: FnOnce(&mut serde_json::Value) -> Result<(), String>,
{
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("[config-io] Cannot create config dir: {}", e))?;
    }

    let lock_path = config_path.with_file_name("config.json.lock");
    let config_path_owned: PathBuf = config_path.to_path_buf();

    // Borrow checker: the mutator + post-write logic capture environment by
    // value via the closure passed to `with_file_lock_blocking`. The error
    // helper converts our String errors into FileLockError::Io.
    fn to_io_err(msg: String) -> FileLockError {
        FileLockError::Io(std::io::Error::new(std::io::ErrorKind::Other, msg))
    }

    let result = with_file_lock_blocking(
        &lock_path,
        FileLockOptions::default(),
        move || -> Result<serde_json::Value, FileLockError> {
            let mut config = read_config_json(&config_path_owned).map_err(to_io_err)?;
            let before = config.clone();
            mutator(&mut config).map_err(to_io_err)?;

            if config == before {
                return Ok(config);
            }

            let content = serde_json::to_string_pretty(&config)
                .map_err(|e| to_io_err(format!("[config-io] Cannot serialize config: {}", e)))?;
            let tmp_path = config_path_owned.with_file_name("config.json.tmp.rust");
            let bak_path = config_path_owned.with_file_name("config.json.bak");

            write_all_synced(&tmp_path, &content).map_err(to_io_err)?;

            if keep_backup && config_path_owned.exists() {
                let _ = fs::copy(&config_path_owned, bak_path);
            }

            fs::rename(&tmp_path, &config_path_owned).map_err(|e| {
                to_io_err(format!("[config-io] Cannot rename tmp config: {}", e))
            })?;
            fsync_parent_dir(&config_path_owned).map_err(to_io_err)?;

            Ok(config)
        },
    );

    result.map_err(|e| match e {
        FileLockError::Busy { .. } => e.to_string(),
        FileLockError::Io(io_err) => format!("[config-io] {}", io_err),
    })
}

/// Fsync a file or directory path for renderer-side atomic writes.
#[tauri::command]
pub async fn cmd_fsync_path(path: String, directory: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = PathBuf::from(path);
        if directory {
            #[cfg(unix)]
            {
                let dir = File::open(&p)
                    .map_err(|e| format!("[config-io] Cannot open dir for fsync: {}", e))?;
                dir.sync_all()
                    .map_err(|e| format!("[config-io] Cannot fsync dir: {}", e))?;
            }
            Ok(())
        } else {
            let file = File::open(&p)
                .map_err(|e| format!("[config-io] Cannot open file for fsync: {}", e))?;
            file.sync_all()
                .map_err(|e| format!("[config-io] Cannot fsync file: {}", e))
        }
    })
    .await
    .map_err(|e| format!("[config-io] fsync task failed: {}", e))?
}
