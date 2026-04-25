//! Generic cross-process file lock helper (Pattern 5 — single-writer invariant).
//!
//! Mirrors `src/server/utils/file-lock.ts`. The lock primitive is atomic
//! `create_dir`; an `owner` file inside the lockdir holds `<runtime>:<pid>`
//! (`rust:<pid>` here) so other processes (Node sidecar, renderer) can probe
//! liveness for stale-recovery. We delegate the actual blocking work to
//! `tokio::task::spawn_blocking` so the async runtime worker stays free.
//!
//! Stale-recovery rules (matching the Node helper):
//! - lockdir age > `stale_ms` AND owner pid is no longer alive (unix:
//!   `nix::sys::signal::kill(pid, None)` returns ESRCH) → forcibly remove.
//! - Owner format `renderer:<ts>` has no observable pid; we fall through to
//!   age-only break.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::ulog_warn;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_STALE: Duration = Duration::from_secs(30);
const DEFAULT_POLL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone)]
pub struct FileLockOptions {
    pub timeout: Duration,
    pub stale: Duration,
    pub poll: Duration,
}

impl Default for FileLockOptions {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_TIMEOUT,
            stale: DEFAULT_STALE,
            poll: DEFAULT_POLL,
        }
    }
}

#[derive(Debug)]
pub enum FileLockError {
    /// Lock could not be acquired within `timeout`.
    Busy { lock_path: PathBuf, timeout: Duration },
    /// Filesystem error while attempting to acquire / release the lock.
    Io(std::io::Error),
}

impl std::fmt::Display for FileLockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileLockError::Busy { lock_path, timeout } => write!(
                f,
                "[file-lock] File busy: could not acquire lock {} within {}ms; retry",
                lock_path.display(),
                timeout.as_millis()
            ),
            FileLockError::Io(e) => write!(f, "[file-lock] I/O error: {}", e),
        }
    }
}

impl std::error::Error for FileLockError {}

impl From<FileLockError> for String {
    fn from(e: FileLockError) -> Self {
        e.to_string()
    }
}

/// Probe whether `pid` is alive. Unix-only via `nix::sys::signal::kill(pid, 0)`.
/// On Windows we conservatively return true (don't break) — the cron writer
/// is the only Rust user and doesn't currently target Windows lifecycle issues.
#[cfg(unix)]
fn is_pid_alive(pid: i32) -> Option<bool> {
    use nix::sys::signal;
    use nix::unistd::Pid;
    match signal::kill(Pid::from_raw(pid), None) {
        Ok(_) => Some(true),
        Err(nix::errno::Errno::ESRCH) => Some(false),
        Err(_) => None, // EPERM etc. — be conservative, don't break.
    }
}

#[cfg(not(unix))]
fn is_pid_alive(_pid: i32) -> Option<bool> {
    // Conservative on Windows: treat as alive (don't break) until we wire up
    // OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION). Stale recovery still
    // works there via age-based break for renderer:<ts> owners.
    None
}

/// Try to break a stale lockdir if its owner pid is dead and age > `stale`.
/// Returns `true` if we removed it (caller should retry mkdir immediately).
fn try_break_stale_lock(lock_path: &Path, stale: Duration) -> bool {
    let metadata = match fs::metadata(lock_path) {
        Ok(m) => m,
        Err(_) => return true, // gone — retry mkdir
    };

    let age = match metadata.modified().ok().and_then(|t| t.elapsed().ok()) {
        Some(a) => a,
        None => return false,
    };
    if age <= stale {
        return false;
    }

    let owner = fs::read_to_string(lock_path.join("owner"))
        .unwrap_or_default()
        .trim()
        .to_string();

    // node:<pid> / rust:<pid> — probe pid liveness.
    if let Some(rest) = owner.strip_prefix("node:").or_else(|| owner.strip_prefix("rust:")) {
        if let Ok(pid) = rest.parse::<i32>() {
            match is_pid_alive(pid) {
                Some(true) => return false, // owner alive — don't break
                Some(false) => { /* dead — proceed */ }
                None => return false, // unknown — be conservative
            }
        }
    }
    // For renderer:<ts> or unrecognized owners we fall through and break by age.

    ulog_warn!(
        "[file-lock] Breaking stale lock {} (age={}ms owner={})",
        lock_path.display(),
        age.as_millis(),
        if owner.is_empty() { "unknown" } else { &owner }
    );
    fs::remove_dir_all(lock_path).is_ok()
}

/// Synchronous lock acquisition + release wrapping `mutator`. Designed to be
/// called from `spawn_blocking` (or any blocking context). For async sites use
/// [`with_file_lock`] which delegates here under `spawn_blocking`.
pub fn with_file_lock_blocking<F, T>(
    lock_path: &Path,
    opts: FileLockOptions,
    mutator: F,
) -> Result<T, FileLockError>
where
    F: FnOnce() -> Result<T, FileLockError>,
{
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent).map_err(FileLockError::Io)?;
    }

    let start = Instant::now();
    loop {
        match fs::create_dir(lock_path) {
            Ok(()) => {
                let owner_path = lock_path.join("owner");
                let _ = fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&owner_path)
                    .and_then(|mut f| writeln!(f, "rust:{}", std::process::id()));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if try_break_stale_lock(lock_path, opts.stale) {
                    continue; // retry mkdir immediately
                }
                if start.elapsed() >= opts.timeout {
                    return Err(FileLockError::Busy {
                        lock_path: lock_path.to_path_buf(),
                        timeout: opts.timeout,
                    });
                }
                std::thread::sleep(opts.poll);
            }
            Err(e) => return Err(FileLockError::Io(e)),
        }
    }

    let result = mutator();

    let _ = fs::remove_dir_all(lock_path);
    result
}

/// Async wrapper — runs the blocking lock acquisition + the mutator on a tokio
/// blocking-thread so the async runtime stays free.
pub async fn with_file_lock<F, T>(
    lock_path: &Path,
    opts: FileLockOptions,
    mutator: F,
) -> Result<T, FileLockError>
where
    F: FnOnce() -> Result<T, FileLockError> + Send + 'static,
    T: Send + 'static,
{
    let lock_path = lock_path.to_path_buf();
    tokio::task::spawn_blocking(move || with_file_lock_blocking(&lock_path, opts, mutator))
        .await
        .map_err(|join_err| {
            FileLockError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("file-lock join error: {}", join_err),
            ))
        })?
}
