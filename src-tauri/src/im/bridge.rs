// OpenClaw Channel Plugin Bridge Adapter
//
// Implements ImAdapter + ImStreamAdapter for OpenClaw community channel plugins.
// The Bridge is an independent Bun process that loads the plugin and communicates
// with Rust via HTTP endpoints.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;
use serde_json::json;
use tokio::sync::{mpsc, Mutex};

use crate::im::adapter::{AdapterResult, ImAdapter, ImStreamAdapter};
use crate::im::types::ImMessage;
use crate::{ulog_info, ulog_error, ulog_debug};

// ===== Bridge Sender Registry =====
// Lets management API route inbound messages from Bridge → processing loop.

static BRIDGE_SENDERS: OnceLock<Mutex<HashMap<String, mpsc::Sender<ImMessage>>>> = OnceLock::new();

fn get_registry() -> &'static Mutex<HashMap<String, mpsc::Sender<ImMessage>>> {
    BRIDGE_SENDERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn register_bridge_sender(bot_id: &str, tx: mpsc::Sender<ImMessage>) {
    get_registry().lock().await.insert(bot_id.to_string(), tx);
}

pub async fn unregister_bridge_sender(bot_id: &str) {
    get_registry().lock().await.remove(bot_id);
}

pub async fn get_bridge_sender(bot_id: &str) -> Option<mpsc::Sender<ImMessage>> {
    get_registry().lock().await.get(bot_id).cloned()
}

// ===== BridgeAdapter =====

pub struct BridgeAdapter {
    plugin_id: String,
    bridge_port: u16,
    client: Client,
    #[allow(dead_code)]
    max_msg_length: usize,
}

impl BridgeAdapter {
    pub fn new(plugin_id: String, bridge_port: u16) -> Self {
        let client = crate::local_http::json_client(Duration::from_secs(30));
        Self {
            plugin_id,
            bridge_port,
            client,
            max_msg_length: 4096,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.bridge_port, path)
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
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

    fn use_draft_streaming(&self) -> bool {
        false
    }

    fn preferred_throttle_ms(&self) -> u64 {
        1000
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
            let bundled = resource_dir.join("plugin-bridge-dist.js");
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

    let mut child = std::process::Command::new(&bun_path)
        .arg(bridge_script.to_string_lossy().as_ref())
        .arg("--plugin-dir")
        .arg(plugin_dir)
        .arg("--port")
        .arg(port.to_string())
        .arg("--rust-port")
        .arg(rust_port.to_string())
        .arg("--bot-id")
        .arg(bot_id)
        .arg("--config")
        .arg(&config_json)
        // Prevent system proxy (Clash/V2Ray) from intercepting localhost traffic
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("no_proxy", "127.0.0.1,localhost")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn bridge process: {}", e))?;

    // Pipe stdout/stderr to unified log (same pattern as sidecar.rs)
    {
        use std::io::{BufRead, BufReader};
        if let Some(stdout) = child.stdout.take() {
            let bot_id_clone = bot_id.to_string();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().flatten() {
                    log::info!("[bridge-out][{}] {}", bot_id_clone, line);
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let bot_id_clone = bot_id.to_string();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    log::error!("[bridge-err][{}] {}", bot_id_clone, line);
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

/// Install an OpenClaw plugin from npm
pub async fn install_openclaw_plugin<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    npm_spec: &str,
) -> Result<serde_json::Value, String> {
    use crate::sidecar::find_bun_executable_pub;

    let bun_path = find_bun_executable_pub(app_handle)
        .ok_or_else(|| "Bun executable not found".to_string())?;

    // Derive plugin ID from npm spec (e.g. "@openclaw/channel-qqbot" → "channel-qqbot")
    let plugin_id = npm_spec
        .split('/')
        .last()
        .unwrap_or(npm_spec)
        .split('@')
        .next()
        .unwrap_or(npm_spec)
        .to_string();

    let base_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join("openclaw-plugins")
        .join(&plugin_id);

    // Create directory
    tokio::fs::create_dir_all(&base_dir)
        .await
        .map_err(|e| format!("Failed to create plugin dir: {}", e))?;

    // Run bun init + bun add (blocking I/O → spawn_blocking)
    ulog_info!("[bridge] Installing plugin {} into {:?}", npm_spec, base_dir);

    let bun_for_init = bun_path.clone();
    let base_for_init = base_dir.clone();
    let init_output = tokio::task::spawn_blocking(move || {
        std::process::Command::new(&bun_for_init)
            .args(["init", "-y"])
            .current_dir(&base_for_init)
            .output()
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
    .map_err(|e| format!("bun init failed: {}", e))?;

    if !init_output.status.success() {
        let stderr = String::from_utf8_lossy(&init_output.stderr);
        return Err(format!("bun init failed: {}", stderr));
    }

    let bun_for_add = bun_path.clone();
    let base_for_add = base_dir.clone();
    let npm_spec_owned = npm_spec.to_string();
    let add_output = tokio::task::spawn_blocking(move || {
        std::process::Command::new(&bun_for_add)
            .args(["add", &npm_spec_owned])
            .current_dir(&base_for_add)
            .output()
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
    .map_err(|e| format!("bun add failed: {}", e))?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!("bun add {} failed: {}", npm_spec, stderr));
    }

    // Install plugin-sdk shim
    install_sdk_shim(&base_dir).await?;

    // Try to read plugin manifest
    let manifest = read_plugin_manifest(&base_dir, npm_spec).await;

    ulog_info!("[bridge] Plugin {} installed successfully", plugin_id);

    Ok(json!({
        "pluginId": plugin_id,
        "installDir": base_dir.to_string_lossy(),
        "manifest": manifest,
    }))
}

/// Install the openclaw/plugin-sdk shim into the plugin's node_modules
async fn install_sdk_shim(plugin_dir: &std::path::Path) -> Result<(), String> {
    let shim_dir = plugin_dir.join("node_modules").join("openclaw");
    let sdk_dir = shim_dir.join("plugin-sdk");

    tokio::fs::create_dir_all(&sdk_dir)
        .await
        .map_err(|e| format!("Failed to create SDK shim dir: {}", e))?;

    // package.json
    let pkg_json = json!({
        "name": "openclaw",
        "version": "0.0.1-shim",
        "exports": {
            "./plugin-sdk": "./plugin-sdk/index.js"
        }
    });
    tokio::fs::write(
        shim_dir.join("package.json"),
        serde_json::to_string_pretty(&pkg_json).unwrap(),
    )
    .await
    .map_err(|e| format!("Failed to write shim package.json: {}", e))?;

    // plugin-sdk/index.js
    let sdk_js = r#"
// OpenClaw plugin-sdk shim for MyAgents
export function emptyPluginConfigSchema() {
  return { type: "object", properties: {}, additionalProperties: false };
}

export function applyAccountNameToChannelSection(config, section, name) {
  if (!config) config = {};
  if (!config[section]) config[section] = {};
  config[section].name = name;
  return config;
}

export function deleteAccountFromConfigSection(config, section) {
  if (config && config[section]) {
    delete config[section];
  }
  return config || {};
}

export function setAccountEnabledInConfigSection(config, section, enabled) {
  if (!config) config = {};
  if (!config[section]) config[section] = {};
  config[section].enabled = enabled;
  return config;
}
"#;
    tokio::fs::write(sdk_dir.join("index.js"), sdk_js.trim())
        .await
        .map_err(|e| format!("Failed to write SDK shim index.js: {}", e))?;

    // plugin-sdk/index.d.ts (minimal type declarations)
    let sdk_dts = r#"
export interface OpenClawPluginApi {
  registerChannel(plugin: any): void;
  config: any;
  logger: any;
}

export interface OpenClawConfig {
  [key: string]: any;
}

export interface ChannelPlugin {
  id: string;
  name: string;
  gateway: any;
  [key: string]: any;
}

export interface PluginRuntime {
  channel: any;
  [key: string]: any;
}

export function emptyPluginConfigSchema(): any;
export function applyAccountNameToChannelSection(config: any, section: string, name: string): any;
export function deleteAccountFromConfigSection(config: any, section: string): any;
export function setAccountEnabledInConfigSection(config: any, section: string, enabled: boolean): any;
"#;
    tokio::fs::write(sdk_dir.join("index.d.ts"), sdk_dts.trim())
        .await
        .map_err(|e| format!("Failed to write SDK shim index.d.ts: {}", e))?;

    Ok(())
}

/// Try to read plugin manifest from node_modules
async fn read_plugin_manifest(
    plugin_dir: &std::path::Path,
    npm_spec: &str,
) -> serde_json::Value {
    // Derive package name (strip version specifier)
    let pkg_name = npm_spec.split('@').next().unwrap_or(npm_spec);
    let pkg_name = if pkg_name.is_empty() && npm_spec.starts_with('@') {
        // Scoped package: @scope/name@version
        let parts: Vec<&str> = npm_spec.splitn(3, '@').collect();
        if parts.len() >= 3 {
            format!("@{}", parts[1])
        } else {
            npm_spec.to_string()
        }
    } else {
        pkg_name.to_string()
    };

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
