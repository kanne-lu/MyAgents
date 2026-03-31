//! Embedded terminal module — PTY management for split-panel terminal.
//!
//! Each Chat Tab can own one terminal instance. The terminal lifecycle is tied
//! to the Tab, not the panel visibility (hiding the panel keeps the PTY alive).
//!
//! Uses `portable-pty` (wezterm's PTY library) for cross-platform PTY support:
//! - macOS/Linux: `forkpty()` (POSIX PTY)
//! - Windows: ConPTY (Windows 10 1809+)
//!
//! Data flow:
//!   User keypress → invoke(cmd_terminal_write) → PTY master write
//!   PTY master read → emit(terminal:data:{id}) → xterm.js render
//!
//! NOTE: This module does NOT use `process_cmd::new()` — portable-pty manages
//! process creation internally via `CommandBuilder` + `slave.spawn_command()`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::{ulog_info, ulog_error};

/// A single terminal session with its PTY pair and reader task.
struct TerminalSession {
    /// Writer end of the PTY master — receives user keystrokes.
    writer: Box<dyn Write + Send>,
    /// The PTY master handle — used for resize operations.
    /// Wrapped in a Mutex because `resize()` requires `&self` but we need
    /// shared access from the resize command while writer is also held.
    master: Arc<std::sync::Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Shell child process handle (Child is not Sync, use std Mutex).
    child: Arc<std::sync::Mutex<Box<dyn portable_pty::Child + Send>>>,
    // NOTE: portable_pty::Child does not implement Sync, so we must not
    // require Sync on the Box. The std::sync::Mutex handles thread safety.
    /// Background task that reads PTY output and emits Tauri events.
    reader_task: JoinHandle<()>,
}

/// Manages all terminal sessions across Tabs.
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

impl TerminalManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
        })
    }
}

/// Create a new terminal instance. Returns `terminal_id`.
#[tauri::command]
pub async fn cmd_terminal_create(
    app: AppHandle,
    state: tauri::State<'_, Arc<TerminalManager>>,
    workspace_path: String,
    rows: u16,
    cols: u16,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Build shell command
    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&workspace_path);

    // Inject environment: bundled runtimes PATH + proxy config
    inject_terminal_env(&mut cmd, &app);

    // Spawn shell on the slave end
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{}': {}", shell, e))?;

    // Drop slave — we only interact via master
    drop(pair.slave);

    // Get reader from master (clone before moving master)
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    // Get writer from master
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    // Wrap master and child for shared access
    let master = Arc::new(std::sync::Mutex::new(pair.master));
    let child: Arc<std::sync::Mutex<Box<dyn portable_pty::Child + Send>>> =
        Arc::new(std::sync::Mutex::new(child));

    // Spawn background reader task
    let emit_id = id.clone();
    let app_clone = app.clone();
    let reader_task = tokio::task::spawn_blocking(move || {
        terminal_read_loop(reader, &emit_id, &app_clone);
    });

    let session = TerminalSession {
        writer,
        master,
        child,
        reader_task,
    };

    state.sessions.lock().await.insert(id.clone(), session);

    ulog_info!(
        "[terminal] Created terminal {} (shell={}, cwd={})",
        id, shell, workspace_path
    );

    Ok(id)
}

/// Write data to a terminal (user keystrokes).
#[tauri::command]
pub async fn cmd_terminal_write(
    state: tauri::State<'_, Arc<TerminalManager>>,
    terminal_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&terminal_id)
        .ok_or_else(|| format!("Terminal {} not found", terminal_id))?;

    session
        .writer
        .write_all(&data)
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;

    // Flush to ensure data is sent immediately (important for single keystrokes)
    session
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;

    Ok(())
}

/// Resize a terminal (when split panel is resized or window changes).
#[tauri::command]
pub async fn cmd_terminal_resize(
    state: tauri::State<'_, Arc<TerminalManager>>,
    terminal_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal {} not found", terminal_id))?;

    let master = session
        .master
        .lock()
        .map_err(|e| format!("Failed to lock PTY master: {}", e))?;

    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;

    Ok(())
}

/// Close a terminal and kill its shell process.
#[tauri::command]
pub async fn cmd_terminal_close(
    state: tauri::State<'_, Arc<TerminalManager>>,
    terminal_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.remove(&terminal_id) {
        cleanup_session(session, &terminal_id);
    }
    Ok(())
}

/// Close all terminals. Called on app exit alongside `stop_all_sidecars()`.
pub async fn close_all_terminals(state: &Arc<TerminalManager>) {
    let mut sessions = state.sessions.lock().await;
    let ids: Vec<String> = sessions.keys().cloned().collect();
    for id in &ids {
        if let Some(session) = sessions.remove(id) {
            cleanup_session(session, id);
        }
    }
    if !ids.is_empty() {
        ulog_info!("[terminal] Closed {} terminal(s) on shutdown", ids.len());
    }
}

/// Clean up a single terminal session: kill child, abort reader task.
fn cleanup_session(session: TerminalSession, terminal_id: &str) {
    // Kill the shell process
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
    }
    // Abort the reader task (will exit naturally once PTY closes, but abort as backup)
    session.reader_task.abort();
    // Writer and master are dropped automatically
    ulog_info!("[terminal] Closed terminal {}", terminal_id);
}

/// Background loop: reads PTY output and emits Tauri events.
fn terminal_read_loop(
    mut reader: Box<dyn Read + Send>,
    terminal_id: &str,
    app: &AppHandle,
) {
    let mut buf = [0u8; 4096];
    let event_data = format!("terminal:data:{}", terminal_id);
    let event_exit = format!("terminal:exit:{}", terminal_id);

    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                // PTY closed (shell exited)
                let _ = app.emit(&event_exit, ());
                ulog_info!("[terminal] Shell exited for terminal {}", terminal_id);
                break;
            }
            Ok(n) => {
                // Send raw bytes to frontend as Vec<u8> (Tauri serializes to JSON array)
                let _ = app.emit(&event_data, buf[..n].to_vec());
            }
            Err(e) => {
                ulog_error!("[terminal] Read error for {}: {}", terminal_id, e);
                let _ = app.emit(&event_exit, ());
                break;
            }
        }
    }
}

/// Select the default shell for the current platform.
fn default_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
    #[cfg(windows)]
    {
        // Prefer PowerShell 7 → PowerShell 5 → cmd.exe
        // Use system_binary::find() instead of bare which::which() (CLAUDE.md constraint)
        if crate::system_binary::find("pwsh").is_some() {
            "pwsh".into()
        } else {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
        }
    }
}

/// Inject environment variables into the terminal shell process.
///
/// This ensures the terminal has access to:
/// 1. Bundled Bun and Node.js (same PATH as SDK subprocesses)
/// 2. Proxy configuration (NO_PROXY protects localhost)
/// 3. ~/.myagents/bin (CLI tools)
fn inject_terminal_env(cmd: &mut CommandBuilder, app: &AppHandle) {
    // 1. Build PATH with bundled runtimes
    //    Priority: bundled bun dir → bundled node dir → ~/.myagents/bin → system PATH
    let mut extra_paths: Vec<String> = Vec::new();

    // Bundled Bun directory
    if let Ok(resource_dir) = app.path().resource_dir() {
        let resource_dir: std::path::PathBuf = resource_dir;

        #[cfg(target_os = "macos")]
        {
            if let Some(contents_dir) = resource_dir.parent() {
                let macos_dir = contents_dir.join("MacOS");
                if macos_dir.exists() {
                    extra_paths.push(macos_dir.to_string_lossy().into_owned());
                }
            }
        }
        let binaries_dir = resource_dir.join("binaries");
        if binaries_dir.exists() {
            extra_paths.push(binaries_dir.to_string_lossy().into_owned());
        }

        // Bundled Node.js directory
        #[cfg(target_os = "windows")]
        let node_dir = resource_dir.join("nodejs");
        #[cfg(not(target_os = "windows"))]
        let node_dir = resource_dir.join("nodejs").join("bin");
        if node_dir.exists() {
            extra_paths.push(node_dir.to_string_lossy().into_owned());
        }
    }

    // ~/.myagents/bin (CLI tools)
    if let Some(home) = dirs::home_dir() {
        let cli_bin = home.join(".myagents").join("bin");
        if cli_bin.exists() {
            extra_paths.push(cli_bin.to_string_lossy().into());
        }
    }

    if !extra_paths.is_empty() {
        let current_path = std::env::var("PATH").unwrap_or_default();
        #[cfg(unix)]
        let new_path = format!("{}:{}", extra_paths.join(":"), current_path);
        #[cfg(windows)]
        let new_path = format!("{};{}", extra_paths.join(";"), current_path);
        cmd.env("PATH", new_path);
    }

    // 2. Proxy configuration — reuse proxy_config logic
    //    We can't call proxy_config::apply_to_subprocess() directly because it takes
    //    &mut std::process::Command, not CommandBuilder. Apply the same logic manually,
    //    matching the error handling of the canonical apply_to_subprocess().
    if let Some(proxy) = crate::proxy_config::read_proxy_settings() {
        match crate::proxy_config::get_proxy_url(&proxy) {
            Ok(proxy_url) => {
                cmd.env("HTTP_PROXY", &proxy_url);
                cmd.env("HTTPS_PROXY", &proxy_url);
                cmd.env("http_proxy", &proxy_url);
                cmd.env("https_proxy", &proxy_url);
                cmd.env("MYAGENTS_PROXY_INJECTED", "1");
            }
            Err(e) => {
                ulog_error!(
                    "[terminal] Invalid proxy configuration: {}. Terminal will start without proxy.",
                    e
                );
                // Don't inject proxy vars — let terminal inherit system network behavior
            }
        }
    }
    // MUST always inject NO_PROXY to protect localhost (reuse canonical constant)
    cmd.env("NO_PROXY", crate::proxy_config::LOCALHOST_NO_PROXY);
    cmd.env("no_proxy", crate::proxy_config::LOCALHOST_NO_PROXY);

    // 3. Terminal indicator (so scripts can detect they're in MyAgents terminal)
    cmd.env("MYAGENTS_TERMINAL", "1");
}
