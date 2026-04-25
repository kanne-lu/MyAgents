//! Shared `~/.myagents/config.json` read-modify-write helper.
//!
//! The renderer, Node sidecar, and Rust commands coordinate on the same
//! `config.json.lock` directory. Directory creation is atomic across processes
//! on supported app filesystems and is available from all three runtimes without
//! adding a platform-specific dependency.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const LOCK_POLL: Duration = Duration::from_millis(50);

struct ConfigLockGuard {
    lock_dir: PathBuf,
}

impl Drop for ConfigLockGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.lock_dir);
    }
}

fn acquire_config_lock(config_path: &Path) -> Result<ConfigLockGuard, String> {
    let lock_dir = config_path.with_file_name("config.json.lock");
    let start = Instant::now();

    loop {
        match fs::create_dir(&lock_dir) {
            Ok(()) => {
                let owner = lock_dir.join("owner");
                let _ = fs::write(owner, format!("rust:{}\n", std::process::id()));
                return Ok(ConfigLockGuard { lock_dir });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if start.elapsed() >= LOCK_TIMEOUT {
                    return Err(
                        "[config-io] Config busy: could not acquire config.json.lock within 5000ms; retry"
                            .to_string(),
                    );
                }
                thread::sleep(LOCK_POLL);
            }
            Err(e) => {
                return Err(format!("[config-io] Cannot create config lock: {}", e));
            }
        }
    }
}

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

    let _guard = acquire_config_lock(config_path)?;

    let mut config = read_config_json(config_path)?;
    let before = config.clone();
    mutator(&mut config)?;

    if config == before {
        return Ok(config);
    }

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("[config-io] Cannot serialize config: {}", e))?;
    let tmp_path = config_path.with_file_name("config.json.tmp.rust");
    let bak_path = config_path.with_file_name("config.json.bak");

    write_all_synced(&tmp_path, &content)?;

    if keep_backup && config_path.exists() {
        let _ = fs::copy(config_path, bak_path);
    }

    fs::rename(&tmp_path, config_path)
        .map_err(|e| format!("[config-io] Cannot rename tmp config: {}", e))?;
    fsync_parent_dir(config_path)?;

    Ok(config)
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
