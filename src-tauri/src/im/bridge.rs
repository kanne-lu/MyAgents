// OpenClaw Channel Plugin Bridge Adapter
//
// Implements ImAdapter + ImStreamAdapter for OpenClaw community channel plugins.
// The Bridge is an independent Bun process that loads the plugin and communicates
// with Rust via HTTP endpoints.

use tauri::Manager;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;
use serde_json::json;
use tokio::sync::{mpsc, Mutex};

use crate::im::adapter::{AdapterResult, ImAdapter, ImStreamAdapter};
use crate::im::types::ImMessage;
use crate::{ulog_info, ulog_warn, ulog_error, ulog_debug};
// Note: ulog_* macros write to BOTH system log AND unified log (~/.myagents/logs/unified-*.log)
// This is critical for bridge stdout/stderr — using log::info! only writes to system log.

// ===== Bridge Sender Registry =====
// Lets management API route inbound messages from Bridge → processing loop.

/// Registry entry: sender channel + plugin ID (for uninstall safety check).
struct BridgeSenderEntry {
    tx: mpsc::Sender<ImMessage>,
    plugin_id: String,
}

static BRIDGE_SENDERS: OnceLock<Mutex<HashMap<String, BridgeSenderEntry>>> = OnceLock::new();

fn get_registry() -> &'static Mutex<HashMap<String, BridgeSenderEntry>> {
    BRIDGE_SENDERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn register_bridge_sender(bot_id: &str, plugin_id: &str, tx: mpsc::Sender<ImMessage>) {
    get_registry().lock().await.insert(bot_id.to_string(), BridgeSenderEntry {
        tx,
        plugin_id: plugin_id.to_string(),
    });
}

pub async fn unregister_bridge_sender(bot_id: &str) {
    get_registry().lock().await.remove(bot_id);
}

pub async fn get_bridge_sender(bot_id: &str) -> Option<mpsc::Sender<ImMessage>> {
    get_registry().lock().await.get(bot_id).map(|e| e.tx.clone())
}

/// Check if any running bot uses the given plugin_id.
pub async fn is_plugin_in_use(plugin_id: &str) -> bool {
    get_registry().lock().await.values().any(|e| e.plugin_id == plugin_id)
}

/// Return all bot_ids currently using the given plugin_id.
pub async fn get_bot_ids_using_plugin(plugin_id: &str) -> Vec<String> {
    get_registry()
        .lock()
        .await
        .iter()
        .filter(|(_, e)| e.plugin_id == plugin_id)
        .map(|(bot_id, _)| bot_id.clone())
        .collect()
}

// ===== BridgeAdapter =====

pub struct BridgeAdapter {
    plugin_id: String,
    bridge_port: u16,
    client: Client,
    #[allow(dead_code)]
    max_msg_length: usize,
    supports_streaming: bool,
    supports_cardkit: bool,
    enabled_tool_groups: Vec<String>,
    /// Plugin-registered slash commands (name → description)
    commands: Vec<(String, String)>,
}

impl BridgeAdapter {
    pub fn new(plugin_id: String, bridge_port: u16) -> Self {
        let client = crate::local_http::json_client(Duration::from_secs(30));
        Self {
            plugin_id,
            bridge_port,
            client,
            max_msg_length: 4096,
            supports_streaming: false,
            supports_cardkit: false,
            enabled_tool_groups: Vec::new(),
            commands: Vec::new(),
        }
    }

    /// Fetch plugin capabilities from bridge and update max_msg_length + streaming flags.
    /// Called once after bridge is verified healthy.
    pub async fn sync_capabilities(&mut self) {
        match self.client.get(self.url("/capabilities")).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(body) = resp.json::<serde_json::Value>().await {
                    if let Some(limit) = body["textChunkLimit"].as_u64() {
                        self.max_msg_length = limit as usize;
                        ulog_info!("[bridge:{}] textChunkLimit = {}", self.plugin_id, limit);
                    }
                    // CardKit / streaming capability flags (nested under capabilities object)
                    let caps = &body["capabilities"];
                    if caps["streaming"].as_bool() == Some(true) {
                        self.supports_streaming = true;
                        ulog_info!("[bridge:{}] streaming enabled", self.plugin_id);
                    }
                    if caps["streamingCardKit"].as_bool() == Some(true) {
                        self.supports_cardkit = true;
                        ulog_info!("[bridge:{}] CardKit enabled", self.plugin_id);
                    }
                    // Plugin commands
                    if let Some(cmds) = caps["commands"].as_array() {
                        self.commands = cmds.iter()
                            .filter_map(|c| {
                                let name = c["name"].as_str()?.to_string();
                                let desc = c["description"].as_str().unwrap_or("").to_string();
                                Some((name, desc))
                            })
                            .collect();
                        if !self.commands.is_empty() {
                            ulog_info!("[bridge:{}] commands: {:?}", self.plugin_id, self.commands.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>());
                        }
                    }
                    // Tool groups
                    if let Some(groups) = caps["toolGroups"].as_array() {
                        self.enabled_tool_groups = groups.iter()
                            .filter_map(|g| g.as_str().map(String::from))
                            .collect();
                        if !self.enabled_tool_groups.is_empty() {
                            ulog_info!("[bridge:{}] tool groups: {:?}", self.plugin_id, self.enabled_tool_groups);
                        }
                    }
                }
            }
            _ => {
                ulog_debug!("[bridge:{}] Could not fetch capabilities, using defaults", self.plugin_id);
            }
        }
    }

    /// Override enabled tool groups with user-configured selection.
    /// Called after sync_capabilities() to replace plugin-declared groups
    /// with the user's choices from the channel config UI.
    pub fn set_enabled_tool_groups(&mut self, groups: Vec<String>) {
        ulog_info!("[bridge:{}] user-configured tool groups: {:?}", self.plugin_id, groups);
        self.enabled_tool_groups = groups;
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.bridge_port, path)
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    /// Check if text matches a plugin-registered command. Returns (command_name, args).
    pub fn match_command(&self, text: &str) -> Option<(String, String)> {
        let trimmed = text.trim();
        for (name, _desc) in &self.commands {
            let cmd = format!("/{}", name);
            if trimmed == cmd || trimmed.starts_with(&format!("{} ", cmd)) {
                let args = trimmed.strip_prefix(&cmd).unwrap_or("").trim().to_string();
                return Some((name.clone(), args));
            }
        }
        None
    }

    /// Execute a plugin command via Bridge's /execute-command endpoint.
    pub async fn execute_command(&self, command: &str, args: &str, user_id: &str, chat_id: &str) -> AdapterResult<String> {
        let body = serde_json::json!({
            "command": command,
            "args": args,
            "userId": user_id,
            "chatId": chat_id,
        });
        let resp = self.client
            .post(self.url("/execute-command"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge execute-command failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge execute-command returned {}: {}", status, text));
        }

        let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
        if resp_body["ok"].as_bool() != Some(true) {
            return Err(format!("Command error: {}", resp_body["error"].as_str().unwrap_or("unknown")));
        }
        Ok(resp_body["result"].as_str().unwrap_or("OK").to_string())
    }

    /// Get registered commands for /help display.
    pub fn get_commands(&self) -> &[(String, String)] {
        &self.commands
    }
}

impl ImAdapter for BridgeAdapter {
    async fn verify_connection(&self) -> AdapterResult<String> {
        // Poll /status with retries — loadPlugin() may still be running
        // (health check only verifies HTTP server is up, not that the plugin is loaded)
        let max_attempts = 30; // 30 * 500ms = 15s max wait for plugin load + credential validation
        for attempt in 0..max_attempts {
            let resp = self.client
                .get(self.url("/status"))
                .send()
                .await
                .map_err(|e| format!("Bridge status check failed: {}", e))?;

            if !resp.status().is_success() {
                return Err(format!("Bridge returned status {}", resp.status()));
            }

            let body: serde_json::Value = resp.json().await
                .map_err(|e| format!("Bridge status parse error: {}", e))?;

            // If there's a gateway error, fail immediately with the specific message
            if let Some(err_msg) = body["error"].as_str() {
                return Err(format!("Bridge plugin error: {}", err_msg));
            }

            if body["ready"].as_bool() == Some(true) {
                let name = body["pluginName"].as_str()
                    .unwrap_or(&self.plugin_id)
                    .to_string();
                return Ok(name);
            }

            // Plugin not ready yet — wait and retry
            if attempt < max_attempts - 1 {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }

        Err("Bridge plugin not ready after 15s (registration or credential validation may have failed)".to_string())
    }

    async fn register_commands(&self) -> AdapterResult<()> {
        // No-op for bridge plugins
        Ok(())
    }

    async fn listen_loop(&self, mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        // Bridge pushes messages to Rust via management API.
        // We periodically health-check the bridge process to detect crashes.
        ulog_info!("[bridge:{}] Listen loop with health watchdog started", self.plugin_id);
        let mut consecutive_failures: u32 = 0;
        const MAX_FAILURES: u32 = 3;

        loop {
            tokio::select! {
                result = shutdown_rx.changed() => {
                    if result.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                }
                _ = tokio::time::sleep(Duration::from_secs(30)) => {
                    // Periodic health check
                    match self.client.get(self.url("/health")).send().await {
                        Ok(resp) if resp.status().is_success() => {
                            if consecutive_failures > 0 {
                                ulog_info!("[bridge:{}] Health check recovered after {} failures", self.plugin_id, consecutive_failures);
                                consecutive_failures = 0;
                            }
                        }
                        Ok(resp) => {
                            consecutive_failures += 1;
                            ulog_error!("[bridge:{}] Health check returned {}, failure {}/{}", self.plugin_id, resp.status(), consecutive_failures, MAX_FAILURES);
                        }
                        Err(e) => {
                            consecutive_failures += 1;
                            ulog_error!("[bridge:{}] Health check failed: {}, failure {}/{}", self.plugin_id, e, consecutive_failures, MAX_FAILURES);
                        }
                    }
                    if consecutive_failures >= MAX_FAILURES {
                        ulog_error!("[bridge:{}] Bridge process appears dead ({} consecutive health check failures), exiting listen loop", self.plugin_id, MAX_FAILURES);
                        break;
                    }
                }
            }
        }
        // Signal bridge to stop (best effort — may already be dead)
        ulog_info!("[bridge:{}] Sending stop to bridge", self.plugin_id);
        let _ = self.client.post(self.url("/stop")).send().await;
    }


    async fn send_message(&self, chat_id: &str, text: &str) -> AdapterResult<()> {
        let body = json!({
            "chatId": chat_id,
            "text": text,
        });
        let resp = self.client
            .post(self.url("/send-text"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge send-text failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge send-text returned {}: {}", status, text));
        }
        Ok(())
    }

    async fn ack_received(&self, _chat_id: &str, _message_id: &str) {
        // No-op
    }

    async fn ack_processing(&self, _chat_id: &str, _message_id: &str) {
        // No-op
    }

    async fn ack_clear(&self, _chat_id: &str, _message_id: &str) {
        // No-op
    }

    async fn send_typing(&self, _chat_id: &str) {
        // No-op
    }
}

impl ImStreamAdapter for BridgeAdapter {
    async fn send_message_returning_id(
        &self,
        chat_id: &str,
        text: &str,
    ) -> AdapterResult<Option<String>> {
        let body = json!({
            "chatId": chat_id,
            "text": text,
        });
        let resp = self.client
            .post(self.url("/send-text"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge send-text failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge send-text returned {}: {}", status, text));
        }

        let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
        Ok(resp_body["messageId"].as_str().map(|s| s.to_string()))
    }

    async fn edit_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> AdapterResult<()> {
        let body = json!({
            "chatId": chat_id,
            "messageId": message_id,
            "text": text,
        });
        let resp = self.client
            .post(self.url("/edit-message"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge edit-message failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge edit-message returned {}: {}", status, text));
        }
        Ok(())
    }

    async fn delete_message(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> AdapterResult<()> {
        let body = json!({
            "chatId": chat_id,
            "messageId": message_id,
        });
        let resp = self.client
            .post(self.url("/delete-message"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge delete-message failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge delete-message returned {}: {}", status, text));
        }
        Ok(())
    }

    fn max_message_length(&self) -> usize {
        self.max_msg_length
    }

    async fn send_approval_card(
        &self,
        _chat_id: &str,
        _request_id: &str,
        _tool_name: &str,
        _tool_input: &str,
    ) -> AdapterResult<Option<String>> {
        // No approval card support for bridge plugins
        Ok(None)
    }

    async fn update_approval_status(
        &self,
        _chat_id: &str,
        _message_id: &str,
        _status: &str,
    ) -> AdapterResult<()> {
        // No-op
        Ok(())
    }

    async fn send_photo(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        caption: Option<&str>,
    ) -> AdapterResult<Option<String>> {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        let body = json!({
            "chatId": chat_id,
            "type": "image",
            "filename": filename,
            "data": b64,
            "caption": caption,
        });
        let resp = self.client
            .post(self.url("/send-media"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge send-media failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge send-media returned {}: {}", status, text));
        }
        let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
        Ok(resp_body["messageId"].as_str().map(|s| s.to_string()))
    }

    async fn send_file(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        mime_type: &str,
        caption: Option<&str>,
    ) -> AdapterResult<Option<String>> {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        let body = json!({
            "chatId": chat_id,
            "type": "file",
            "filename": filename,
            "mimeType": mime_type,
            "data": b64,
            "caption": caption,
        });
        let resp = self.client
            .post(self.url("/send-media"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge send-media failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge send-media returned {}: {}", status, text));
        }
        let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
        Ok(resp_body["messageId"].as_str().map(|s| s.to_string()))
    }

    async fn finalize_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<()> {
        self.edit_message(chat_id, message_id, text).await
    }

    fn use_draft_streaming(&self) -> bool {
        false
    }

    fn preferred_throttle_ms(&self) -> u64 {
        300
    }

    fn bridge_context(&self) -> Option<(u16, String, Vec<String>)> {
        Some((self.bridge_port, self.plugin_id.clone(), self.enabled_tool_groups.clone()))
    }

    fn supports_streaming(&self) -> bool {
        self.supports_streaming
    }

    async fn start_stream(
        &self,
        chat_id: &str,
        initial_text: &str,
    ) -> AdapterResult<String> {
        let body = json!({
            "chatId": chat_id,
            "initialContent": initial_text,
            "streamMode": if self.supports_cardkit { "cardkit" } else { "text" },
        });
        let resp = self.client
            .post(self.url("/start-stream"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge start-stream failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge start-stream returned {}: {}", status, text));
        }

        let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
        Ok(resp_body["streamId"].as_str().unwrap_or("").to_string())
    }

    async fn stream_chunk(
        &self,
        chat_id: &str,
        stream_id: &str,
        text: &str,
        sequence: u32,
        is_thinking: bool,
    ) -> AdapterResult<()> {
        let body = json!({
            "chatId": chat_id,
            "streamId": stream_id,
            "content": text,
            "sequence": sequence,
            "isThinking": is_thinking,
        });
        let resp = self.client
            .post(self.url("/stream-chunk"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge stream-chunk failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge stream-chunk returned {}: {}", status, text));
        }
        Ok(())
    }

    async fn finalize_stream(
        &self,
        chat_id: &str,
        stream_id: &str,
        final_text: &str,
    ) -> AdapterResult<()> {
        let body = json!({
            "chatId": chat_id,
            "streamId": stream_id,
            "finalContent": final_text,
        });
        let resp = self.client
            .post(self.url("/finalize-stream"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge finalize-stream failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge finalize-stream returned {}: {}", status, text));
        }
        Ok(())
    }

    async fn abort_stream(
        &self,
        chat_id: &str,
        stream_id: &str,
    ) -> AdapterResult<()> {
        let body = json!({
            "chatId": chat_id,
            "streamId": stream_id,
        });
        let resp = self.client
            .post(self.url("/abort-stream"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge abort-stream failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge abort-stream returned {}: {}", status, text));
        }
        Ok(())
    }
}

// ===== Bridge Process Management =====

/// Handle to a running bridge process
pub struct BridgeProcess {
    child: std::process::Child,
    pub port: u16,
}

impl BridgeProcess {
    pub fn kill_sync(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait(); // Reap zombie
    }

    pub async fn kill(&mut self) {
        // Use spawn_blocking to avoid blocking the tokio runtime
        // We take ownership issues here, so just do sync kill inline
        // since kill + wait are fast operations on an already-killed process.
        self.kill_sync();
    }
}

/// Find the plugin-bridge script (dev: TS source, prod: bundled JS)
fn find_bridge_script<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<PathBuf> {
    // Production: bundled JS in resources
    #[cfg(not(debug_assertions))]
    {
        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            let bundled: PathBuf = resource_dir.join("plugin-bridge-dist.js");
            if bundled.exists() {
                ulog_info!("[bridge] Using bundled bridge script: {:?}", bundled);
                return Some(bundled);
            }
        }
    }

    // Development: source TS
    let dev_candidates = [
        // Relative to project root
        "src/server/plugin-bridge/index.ts",
    ];

    // Find project root from Cargo.toml location
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let project_root = std::path::Path::new(manifest_dir)
        .parent()
        .unwrap_or(std::path::Path::new("."));

    for candidate in dev_candidates {
        let path = project_root.join(candidate);
        if path.exists() {
            ulog_info!("[bridge] Using dev bridge script: {:?}", path);
            return Some(path);
        }
    }

    // Suppress unused variable warning in release builds
    let _ = app_handle;

    ulog_error!("[bridge] Bridge script not found");
    None
}

/// Spawn a plugin bridge Bun process
pub async fn spawn_plugin_bridge<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    plugin_dir: &str,
    port: u16,
    rust_port: u16,
    bot_id: &str,
    plugin_config: Option<&serde_json::Value>,
) -> Result<BridgeProcess, String> {
    use crate::sidecar::find_bun_executable_pub;

    let bun_path = find_bun_executable_pub(app_handle)
        .ok_or_else(|| "Bun executable not found".to_string())?;

    let bridge_script = find_bridge_script(app_handle)
        .ok_or_else(|| "Plugin bridge script not found".to_string())?;

    let config_json = plugin_config
        .map(|v| v.to_string())
        .unwrap_or_else(|| "{}".to_string());

    ulog_info!(
        "[bridge] Spawning bridge: bun={:?} script={:?} plugin_dir={} port={} rust_port={}",
        bun_path, bridge_script, plugin_dir, port, rust_port
    );

    let mut cmd = crate::process_cmd::new(&bun_path);
    cmd.arg(bridge_script.to_string_lossy().as_ref())
        // Same marker as regular sidecars — ensures cleanup_stale_sidecars()
        // can find and kill orphaned bridge processes after a crash
        .arg("--myagents-sidecar")
        .arg("--plugin-dir")
        .arg(plugin_dir)
        .arg("--port")
        .arg(port.to_string())
        .arg("--rust-port")
        .arg(rust_port.to_string())
        .arg("--bot-id")
        .arg(bot_id)
        // Pass config via env var to avoid leaking secrets in `ps` process listing
        .env("BRIDGE_PLUGIN_CONFIG", &config_json);

    // Inject proxy env vars — reuse shared helper (pit-of-success: single source of truth)
    apply_proxy_env(&mut cmd);

    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn bridge process: {}", e))?;

    // Pipe stdout/stderr to unified log
    {
        use std::io::{BufRead, BufReader};
        if let Some(stdout) = child.stdout.take() {
            let bot_id_clone = bot_id.to_string();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().flatten() {
                    ulog_info!("[bridge-out][{}] {}", bot_id_clone, line);
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let bot_id_clone = bot_id.to_string();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    ulog_error!("[bridge-err][{}] {}", bot_id_clone, line);
                }
            });
        }
    }

    // Wait for health check
    let client = crate::local_http::json_client(Duration::from_secs(5));
    let health_url = format!("http://127.0.0.1:{}/health", port);
    let mut healthy = false;

    for attempt in 0..30 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        match client.get(&health_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                ulog_info!("[bridge] Health check passed after {} attempts", attempt + 1);
                healthy = true;
                break;
            }
            _ => {
                if attempt % 5 == 4 {
                    ulog_debug!("[bridge] Health check attempt {} failed, retrying...", attempt + 1);
                }
            }
        }
    }

    if !healthy {
        // Kill the orphaned child process before returning error
        let _ = child.kill();
        let _ = child.wait();
        return Err("Bridge process did not become healthy within 15s".to_string());
    }

    Ok(BridgeProcess { child, port })
}

/// Apply MyAgents proxy policy to a child `Command`.
/// Reusable across spawn_plugin_bridge, npm install, etc.
fn apply_proxy_env(cmd: &mut std::process::Command) {
    if let Some(proxy_settings) = crate::proxy_config::read_proxy_settings() {
        match crate::proxy_config::get_proxy_url(&proxy_settings) {
            Ok(proxy_url) => {
                ulog_info!("[bridge] Injecting proxy: {}", proxy_url);
                cmd.env("HTTP_PROXY", &proxy_url);
                cmd.env("HTTPS_PROXY", &proxy_url);
                cmd.env("http_proxy", &proxy_url);
                cmd.env("https_proxy", &proxy_url);
                cmd.env("NO_PROXY", "localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]");
                cmd.env("no_proxy", "localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]");
            }
            Err(e) => {
                ulog_warn!("[bridge] Invalid proxy config ({}), stripping proxy env vars", e);
                for var in &["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
                             "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] {
                    cmd.env_remove(var);
                }
            }
        }
    } else {
        ulog_debug!("[bridge] No proxy configured, stripping inherited proxy env vars");
        for var in &["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
                     "ALL_PROXY", "all_proxy"] {
            cmd.env_remove(var);
        }
        cmd.env("NO_PROXY", "localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]");
        cmd.env("no_proxy", "localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]");
    }
}

/// Locate bundled Node.js binary and npm-cli.js for plugin installation.
/// Dual-runtime principle: social ecosystem packages use Node.js (not Bun) to avoid
/// Bun's npm compatibility issues on Windows.
///
/// Layout:
/// - macOS prod:  Contents/Resources/nodejs/bin/node + ../lib/node_modules/npm/bin/npm-cli.js
/// - macOS dev:   src-tauri/resources/nodejs/bin/node + ../lib/node_modules/npm/bin/npm-cli.js
/// - Windows prod: <install_dir>/nodejs/node.exe + node_modules/npm/bin/npm-cli.js
/// - Windows dev:  src-tauri/resources/nodejs/node.exe + node_modules/npm/bin/npm-cli.js
fn find_bundled_node_npm<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<(PathBuf, PathBuf)> {
    let check = |nodejs_dir: &Path| -> Option<(PathBuf, PathBuf)> {
        #[cfg(target_os = "windows")]
        let node_bin = nodejs_dir.join("node.exe");
        #[cfg(not(target_os = "windows"))]
        let node_bin = nodejs_dir.join("bin").join("node");

        // Windows npm layout: nodejs/node_modules/npm/... (flat, no lib/)
        // macOS/Linux npm layout: nodejs/lib/node_modules/npm/... (standard Unix)
        #[cfg(target_os = "windows")]
        let npm_cli = nodejs_dir.join("node_modules").join("npm").join("bin").join("npm-cli.js");
        #[cfg(not(target_os = "windows"))]
        let npm_cli = nodejs_dir.join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js");

        if node_bin.exists() && npm_cli.exists() {
            ulog_info!("[bridge] Bundled Node.js found: node={:?}, npm-cli={:?}", node_bin, npm_cli);
            Some((node_bin, npm_cli))
        } else {
            None
        }
    };

    // Production: nodejs/ inside resource_dir
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let resource_dir: PathBuf = resource_dir;
        let prod_dir = resource_dir.join("nodejs");
        if let Some(result) = check(&prod_dir) {
            return Some(result);
        }
        // Windows: resource_dir parent might be the install dir
        #[cfg(target_os = "windows")]
        if let Some(parent) = resource_dir.parent() {
            let parent_dir = parent.join("nodejs");
            if let Some(result) = check(&parent_dir) {
                return Some(result);
            }
        }
    }

    // Development: walk up to find src-tauri/resources/nodejs/
    if cfg!(debug_assertions) {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let dev_dir = manifest_dir.join("resources").join("nodejs");
        if let Some(result) = check(&dev_dir) {
            return Some(result);
        }
    }

    ulog_warn!("[bridge] Bundled Node.js not found, falling back to Bun for plugin install");
    None
}

/// Install an OpenClaw plugin from npm.
/// Uses bundled Node.js (npm install) instead of Bun to avoid Bun's npm compatibility
/// issues — especially on Windows where certain packages fail with Bun but work with npm.
pub async fn install_openclaw_plugin<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    npm_spec: &str,
) -> Result<serde_json::Value, String> {
    // Validate npm_spec: must look like an npm package name (with optional scope/version).
    // Reject file:, git:, http:, and path traversal attempts.
    let trimmed = npm_spec.trim();
    if trimmed.is_empty()
        || trimmed.contains("..")
        || trimmed.starts_with('/')
        || trimmed.starts_with('.')
        || trimmed.contains("file:")
        || trimmed.contains("git:")
        || trimmed.contains("git+")
        || trimmed.contains("http:")
        || trimmed.contains("https:")
    {
        return Err(format!("Invalid npm spec '{}': only npm package names are allowed", npm_spec));
    }

    // Derive plugin ID from npm spec (e.g. "@openclaw/channel-qqbot" → "channel-qqbot")
    let plugin_id = trimmed
        .split('/')
        .last()
        .unwrap_or(trimmed)
        .split('@')
        .next()
        .unwrap_or(trimmed)
        .to_string();

    // Validate derived plugin_id (no path separators, no empty)
    if plugin_id.is_empty()
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains("..")
    {
        return Err(format!("Invalid plugin ID derived from '{}': '{}'", npm_spec, plugin_id));
    }

    let base_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join("openclaw-plugins")
        .join(&plugin_id);

    // Create directory
    tokio::fs::create_dir_all(&base_dir)
        .await
        .map_err(|e| format!("Failed to create plugin dir: {}", e))?;

    ulog_info!("[bridge] Installing plugin {} into {:?}", npm_spec, base_dir);

    // Prefer bundled Node.js (npm) over Bun for ecosystem compatibility.
    // Bun has known issues with certain npm packages on Windows.
    if let Some((node_bin, npm_cli)) = find_bundled_node_npm(app_handle) {
        // Convert npm_cli path to String before closures to avoid OsStr issues
        let npm_cli_str = npm_cli.to_str()
            .ok_or_else(|| format!("npm-cli.js path contains invalid UTF-8: {:?}", npm_cli))?
            .to_string();

        // Prepend node binary's directory to PATH so postinstall scripts can find `node`.
        // Without this, `sh -c node scripts/postinstall` fails with "node: command not found".
        let node_dir_for_path = node_bin.parent()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_default();
        let augmented_path = {
            let system_path = std::env::var("PATH").unwrap_or_default();
            #[cfg(target_os = "windows")]
            { format!("{};{}", node_dir_for_path, system_path) }
            #[cfg(not(target_os = "windows"))]
            { format!("{}:{}", node_dir_for_path, system_path) }
        };

        // npm init -y
        let node_for_init = node_bin.clone();
        let cli_str_init = npm_cli_str.clone();
        let base_for_init = base_dir.clone();
        let path_for_init = augmented_path.clone();
        let init_output = tokio::task::spawn_blocking(move || {
            let mut cmd = crate::process_cmd::new(&node_for_init);
            cmd.args([cli_str_init.as_str(), "init", "-y"])
                .current_dir(&base_for_init)
                .env("PATH", &path_for_init);
            apply_proxy_env(&mut cmd);
            cmd.output()
        })
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
        .map_err(|e| format!("npm init failed: {}", e))?;

        if !init_output.status.success() {
            let stderr = String::from_utf8_lossy(&init_output.stderr);
            return Err(format!("npm init failed: {}", stderr));
        }

        // npm install <package>
        let node_for_add = node_bin;
        let cli_str_add = npm_cli_str;
        let base_for_add = base_dir.clone();
        let npm_spec_owned = npm_spec.to_string();
        let path_for_add = augmented_path;
        let add_output = tokio::task::spawn_blocking(move || {
            let mut cmd = crate::process_cmd::new(&node_for_add);
            cmd.args([cli_str_add.as_str(), "install", npm_spec_owned.as_str()])
                .current_dir(&base_for_add)
                .env("PATH", &path_for_add);
            apply_proxy_env(&mut cmd);
            cmd.output()
        })
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
        .map_err(|e| format!("npm install failed: {}", e))?;

        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            return Err(format!("npm install {} failed: {}", npm_spec, stderr));
        }
    } else {
        // Fallback: use Bun if bundled Node.js is not available (pre-v0.1.44 builds)
        use crate::sidecar::find_bun_executable_pub;
        let bun_path = find_bun_executable_pub(app_handle)
            .ok_or_else(|| "Neither bundled Node.js nor Bun found".to_string())?;

        ulog_warn!("[bridge] Using Bun fallback for plugin install (Node.js not bundled)");

        let bun_for_init = bun_path.clone();
        let base_for_init = base_dir.clone();
        let init_output = tokio::task::spawn_blocking(move || {
            let mut cmd = crate::process_cmd::new(&bun_for_init);
            cmd.args(["init", "-y"])
                .current_dir(&base_for_init);
            apply_proxy_env(&mut cmd);
            cmd.output()
        })
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
        .map_err(|e| format!("bun init failed: {}", e))?;

        if !init_output.status.success() {
            let stderr = String::from_utf8_lossy(&init_output.stderr);
            return Err(format!("bun init failed: {}", stderr));
        }

        let bun_for_add = bun_path;
        let base_for_add = base_dir.clone();
        let npm_spec_owned = npm_spec.to_string();
        let add_output = tokio::task::spawn_blocking(move || {
            let mut cmd = crate::process_cmd::new(&bun_for_add);
            cmd.args(["add", npm_spec_owned.as_str()])
                .current_dir(&base_for_add);
            apply_proxy_env(&mut cmd);
            cmd.output()
        })
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
        .map_err(|e| format!("bun add failed: {}", e))?;

        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            return Err(format!("bun add {} failed: {}", npm_spec, stderr));
        }
    }

    // Install plugin-sdk shim (copies from bundled resource files)
    install_sdk_shim(app_handle, &base_dir).await?;

    // Try to read plugin manifest
    let manifest = read_plugin_manifest(&base_dir, npm_spec).await;

    // Extract required config fields from plugin source (isConfigured pattern)
    // read_plugin_manifest already resolved the package name; reuse the same logic
    // to locate the package directory inside node_modules.
    let npm_pkg_name = resolve_npm_pkg_name(trimmed);
    let npm_pkg_dir = base_dir.join("node_modules").join(&npm_pkg_name);
    let required_fields = extract_required_fields(&npm_pkg_dir).await;

    // Read installed package version from node_modules/{npmSpec}/package.json
    let dep_pkg_path = npm_pkg_dir.join("package.json");
    let package_version = if let Ok(content) = tokio::fs::read_to_string(&dep_pkg_path).await {
        serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|v| v.get("version").cloned())
    } else {
        None
    };

    ulog_info!("[bridge] Plugin {} installed successfully", plugin_id);

    Ok(json!({
        "pluginId": plugin_id,
        "installDir": base_dir.to_string_lossy(),
        "npmSpec": trimmed,
        "manifest": manifest,
        "packageVersion": package_version,
        "requiredFields": required_fields,
    }))
}

/// Find the SDK shim source directory (dev: source tree, prod: bundled resource)
fn find_sdk_shim_dir<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<PathBuf> {
    // Production: bundled in resources
    #[cfg(not(debug_assertions))]
    {
        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            let bundled: PathBuf = resource_dir.join("plugin-bridge-sdk-shim");
            if bundled.exists() {
                return Some(bundled);
            }
        }
    }

    // Development: source tree
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let project_root = std::path::Path::new(manifest_dir)
        .parent()
        .unwrap_or(std::path::Path::new("."));
    let dev_path = project_root.join("src/server/plugin-bridge/sdk-shim");
    if dev_path.exists() {
        return Some(dev_path);
    }

    let _ = app_handle;
    None
}

/// Recursively copy a directory
async fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dst)
        .await
        .map_err(|e| format!("Failed to create dir {:?}: {}", dst, e))?;

    let mut entries = tokio::fs::read_dir(src)
        .await
        .map_err(|e| format!("Failed to read dir {:?}: {}", src, e))?;

    while let Some(entry) = entries.next_entry().await
        .map_err(|e| format!("Failed to read entry in {:?}: {}", src, e))?
    {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let file_type = entry.file_type().await
            .map_err(|e| format!("Failed to get file type for {:?}: {}", src_path, e))?;

        if file_type.is_dir() {
            Box::pin(copy_dir_recursive(&src_path, &dst_path)).await?;
        } else {
            tokio::fs::copy(&src_path, &dst_path)
                .await
                .map_err(|e| format!("Failed to copy {:?} → {:?}: {}", src_path, dst_path, e))?;
        }
    }

    Ok(())
}

/// Install the openclaw/plugin-sdk shim into the plugin's node_modules.
/// Copies from bundled resource files instead of hardcoded strings.
async fn install_sdk_shim<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    plugin_dir: &std::path::Path,
) -> Result<(), String> {
    let shim_src = find_sdk_shim_dir(app_handle)
        .ok_or_else(|| "SDK shim source directory not found".to_string())?;

    let shim_dst = plugin_dir.join("node_modules").join("openclaw");

    // Remove existing shim if present (ensure clean state)
    if shim_dst.exists() {
        let _ = tokio::fs::remove_dir_all(&shim_dst).await;
    }

    copy_dir_recursive(&shim_src, &shim_dst).await?;

    ulog_info!("[bridge] SDK shim installed from {:?} → {:?}", shim_src, shim_dst);

    // Patch @larksuiteoapi/node-sdk to use a fetch-based axios adapter.
    // Bun's default axios http adapter has a bug where socket connections are
    // silently closed, causing 30s hangs. This patch replaces the SDK's
    // defaultHttpInstance with one using native fetch (252ms vs 30278ms).
    patch_lark_sdk_for_bun(plugin_dir).await;

    Ok(())
}

/// Patch @larksuiteoapi/node-sdk's defaultHttpInstance to use a fetch-based
/// axios adapter instead of the default Node.js http adapter (incompatible with Bun).
async fn patch_lark_sdk_for_bun(plugin_dir: &std::path::Path) {
    let sdk_file = plugin_dir
        .join("node_modules")
        .join("@larksuiteoapi")
        .join("node-sdk")
        .join("lib")
        .join("index.js");

    if !sdk_file.exists() {
        return; // Not a Lark SDK plugin, skip
    }

    let code = match tokio::fs::read_to_string(&sdk_file).await {
        Ok(c) => c,
        Err(_) => return,
    };

    let target = r#"const defaultHttpInstance = axios__default["default"].create();"#;
    if !code.contains(target) {
        return; // Already patched or different SDK version
    }

    // Minimal fetch-based adapter that replaces axios's Node.js http adapter
    let adapter = concat!(
        "function bunFetchAdapter(c){return new Promise(async(r,j)=>{try{",
        "let u=c.baseURL?c.baseURL+c.url:c.url;",
        "let h={};if(c.headers)for(let[k,v]of Object.entries(c.headers))if(v!=null)h[k]=String(v);",
        "if(c.params){let q=new URLSearchParams();for(let[k,v]of Object.entries(c.params)){",
        "if(Array.isArray(v))v.forEach(i=>q.append(k,String(i)));",
        "else if(v!=null)q.append(k,String(v))}",
        "let s=q.toString();if(s)u+=(u.includes('?')?'&':'?')+s}",
        "let m=(c.method||'get').toUpperCase();",
        "let opts={method:m,headers:h};",
        "if(c.data&&m!=='GET'&&m!=='HEAD'&&m!=='OPTIONS'){",
        "opts.body=typeof c.data==='string'?c.data:JSON.stringify(c.data)}",
        "let resp=await fetch(u,opts);",
        "let d;try{d=await resp.json()}catch{d=await resp.text()}",
        "r({data:d,status:resp.status,statusText:resp.statusText,",
        "headers:Object.fromEntries(resp.headers.entries()),config:c,request:{}})",
        "}catch(e){j(e)}})}",
    );

    let replacement = format!(
        "{}; const defaultHttpInstance = axios__default[\"default\"].create({{adapter: bunFetchAdapter}});",
        adapter
    );

    let patched = code.replace(target, &replacement);
    if let Err(e) = tokio::fs::write(&sdk_file, patched).await {
        ulog_warn!("[bridge] Failed to patch Lark SDK for Bun: {}", e);
    } else {
        ulog_info!("[bridge] Patched @larksuiteoapi/node-sdk with fetch adapter for Bun compatibility");
    }
}

/// Resolve npm spec to the package directory name in node_modules.
/// e.g. "@sliverp/qqbot" → "@sliverp/qqbot", "foo@1.2.3" → "foo",
/// "@scope/name@1.0.0" → "@scope/name"
fn resolve_npm_pkg_name(npm_spec: &str) -> String {
    let first = npm_spec.split('@').next().unwrap_or(npm_spec);
    if first.is_empty() && npm_spec.starts_with('@') {
        // Scoped: "@scope/name" or "@scope/name@version"
        let parts: Vec<&str> = npm_spec.splitn(3, '@').collect();
        if parts.len() >= 3 {
            // "@scope/name@version" → splitn(3,'@') = ["", "scope/name", "version"]
            format!("@{}", parts[1])
        } else {
            // "@scope/name" (no version) → splitn(3,'@') = ["", "scope/name"]
            npm_spec.to_string()
        }
    } else {
        first.to_string()
    }
}

/// Try to read plugin manifest from node_modules
async fn read_plugin_manifest(
    plugin_dir: &std::path::Path,
    npm_spec: &str,
) -> serde_json::Value {
    let pkg_name = resolve_npm_pkg_name(npm_spec);

    // Try reading openclaw.plugin.json
    let manifest_path = plugin_dir
        .join("node_modules")
        .join(&pkg_name)
        .join("openclaw.plugin.json");

    if let Ok(content) = tokio::fs::read_to_string(&manifest_path).await {
        if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&content) {
            return manifest;
        }
    }

    // Try reading package.json for openclaw metadata
    let pkg_path = plugin_dir
        .join("node_modules")
        .join(&pkg_name)
        .join("package.json");

    if let Ok(content) = tokio::fs::read_to_string(&pkg_path).await {
        if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
            return json!({
                "name": pkg["name"],
                "version": pkg["version"],
                "description": pkg["description"],
                "openclaw": pkg["openclaw"],
            });
        }
    }

    json!({ "name": pkg_name })
}

/// Uninstall an OpenClaw plugin by removing its directory.
/// Returns error if any running bot depends on the plugin.
pub async fn uninstall_openclaw_plugin(plugin_id: &str) -> Result<(), String> {
    // Validate plugin_id to prevent path traversal
    if plugin_id.is_empty()
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains("..")
        || plugin_id.starts_with('.')
    {
        return Err(format!("Invalid plugin ID: '{}'", plugin_id));
    }

    let plugins_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join("openclaw-plugins")
        .join(plugin_id);

    if !plugins_dir.exists() {
        return Err(format!("Plugin '{}' not found", plugin_id));
    }

    // Check if any running bot uses this plugin
    if is_plugin_in_use(plugin_id).await {
        return Err(format!(
            "Cannot uninstall '{}': a running bot depends on it. Stop the bot first.",
            plugin_id
        ));
    }

    tokio::fs::remove_dir_all(&plugins_dir)
        .await
        .map_err(|e| format!("Failed to remove plugin directory: {}", e))?;

    ulog_info!("[bridge] Plugin '{}' uninstalled successfully", plugin_id);
    Ok(())
}

/// List all installed OpenClaw plugins
pub async fn list_openclaw_plugins() -> Result<Vec<serde_json::Value>, String> {
    let plugins_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join("openclaw-plugins");

    if !plugins_dir.exists() {
        return Ok(vec![]);
    }

    let mut plugins = Vec::new();
    let mut entries = tokio::fs::read_dir(&plugins_dir)
        .await
        .map_err(|e| format!("Failed to read plugins dir: {}", e))?;

    while let Some(entry) = entries.next_entry().await.map_err(|e| format!("{}", e))? {
        if !entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }

        let plugin_id = entry.file_name().to_string_lossy().to_string();
        let plugin_dir = entry.path();

        // Read project package.json to find the installed npm dependency
        let pkg_json_path = plugin_dir.join("package.json");
        let mut npm_spec = String::new();

        if let Ok(content) = tokio::fs::read_to_string(&pkg_json_path).await {
            if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(deps) = pkg["dependencies"].as_object() {
                    if let Some((name, _)) = deps.iter().next() {
                        npm_spec = name.clone();
                    }
                }
            }
        }

        if npm_spec.is_empty() {
            continue;
        }

        // Read the actual npm package's info
        let dep_pkg_path = plugin_dir
            .join("node_modules")
            .join(&npm_spec)
            .join("package.json");
        let pkg_info = if let Ok(content) = tokio::fs::read_to_string(&dep_pkg_path).await {
            serde_json::from_str::<serde_json::Value>(&content).unwrap_or_default()
        } else {
            serde_json::Value::Null
        };

        // Read openclaw.plugin.json manifest
        let manifest_path = plugin_dir
            .join("node_modules")
            .join(&npm_spec)
            .join("openclaw.plugin.json");
        let manifest = if let Ok(content) = tokio::fs::read_to_string(&manifest_path).await {
            serde_json::from_str::<serde_json::Value>(&content).unwrap_or_default()
        } else {
            serde_json::Value::Null
        };

        // Extract required config fields from channel source (isConfigured pattern)
        let pkg_dir = plugin_dir.join("node_modules").join(&npm_spec);
        let required_fields = extract_required_fields(&pkg_dir).await;

        plugins.push(json!({
            "pluginId": plugin_id,
            "installDir": plugin_dir.to_string_lossy(),
            "npmSpec": npm_spec,
            "manifest": manifest,
            "packageVersion": pkg_info.get("version"),
            "homepage": pkg_info.get("homepage"),
            "requiredFields": required_fields,
        }));
    }

    Ok(plugins)
}

/// Extract required config field names from the channel plugin source.
/// Looks for `isConfigured: (account) => Boolean(account?.fieldA && account?.fieldB)`
/// and extracts ["fieldA", "fieldB"].
async fn extract_required_fields(pkg_dir: &std::path::Path) -> Vec<String> {
    let candidates = [
        pkg_dir.join("src").join("channel.ts"),
        pkg_dir.join("dist").join("channel.js"),
        pkg_dir.join("channel.ts"),
        pkg_dir.join("channel.js"),
    ];

    for path in &candidates {
        if let Ok(content) = tokio::fs::read_to_string(path).await {
            if let Some(pos) = content.find("isConfigured") {
                // Only look at the single expression line — stop at first newline or `,\n`
                let rest = &content[pos..std::cmp::min(pos + 300, content.len())];
                let line_end = rest.find('\n').unwrap_or(rest.len());
                let snippet = &rest[..line_end];

                // Extract unique field names from "account?.fieldName" patterns
                let mut seen = std::collections::HashSet::new();
                let mut fields = Vec::new();
                let needle = "account?.";
                let mut search_from = 0;
                while let Some(idx) = snippet[search_from..].find(needle) {
                    let start = search_from + idx + needle.len();
                    let end = snippet[start..]
                        .find(|c: char| !c.is_alphanumeric() && c != '_')
                        .map(|i| start + i)
                        .unwrap_or(snippet.len());
                    let field = &snippet[start..end];
                    if !field.is_empty() && seen.insert(field.to_string()) {
                        fields.push(field.to_string());
                    }
                    search_from = end;
                }
                if !fields.is_empty() {
                    return fields;
                }
            }
        }
    }

    vec![]
}
