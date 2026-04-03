// browser.rs — Embedded browser panel (Tauri Multi-Webview)
//
// Manages child Webview instances for in-app web browsing.
// Each Chat Tab can have one browser Webview. The Webview floats
// above the React DOM at OS level, positioned by frontend coordinates.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager,
    webview::{PageLoadEvent, WebviewBuilder},
    LogicalPosition, LogicalSize, Url,
};

use crate::ulog_info;

/// Per-tab browser session.
struct BrowserSession {
    webview_label: String,
    #[allow(dead_code)]
    tab_id: String,
    visible: bool,
    /// Cache last-known position/size for show-after-hide restoration.
    last_x: f64,
    last_y: f64,
    last_width: f64,
    last_height: f64,
}

pub struct BrowserManager {
    sessions: Mutex<HashMap<String, BrowserSession>>,
}

impl BrowserManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
        })
    }
}

// ──────────────────────────────────────────────────────────
// IPC Commands
// ──────────────────────────────────────────────────────────

/// Create a child Webview for the given tab, positioned at (x, y) with (width, height).
#[tauri::command]
pub async fn cmd_browser_create(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = format!("browser-{}", tab_id);

    // Prevent duplicate creation
    {
        let sessions = state.sessions.lock().await;
        if sessions.contains_key(&tab_id) {
            return Err(format!("Browser already exists for tab {}", tab_id));
        }
    }

    let parsed_url: Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;

    // Clone values for closures
    let app_nav = app.clone();
    let tab_id_nav = tab_id.clone();
    let app_load = app.clone();
    let tab_id_load = tab_id.clone();
    let app_new_win = app.clone();
    let label_new_win = label.clone();

    let builder = WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed_url))
        .on_navigation(move |nav_url| {
            // Emit URL change to frontend
            let _ = app_nav.emit(
                &format!("browser:url-changed:{}", tab_id_nav),
                nav_url.to_string(),
            );
            true // allow all navigation
        })
        .on_page_load(move |_webview, payload| {
            let event_name = format!("browser:loading:{}", tab_id_load);
            match payload.event() {
                PageLoadEvent::Started => {
                    let _ = app_load.emit(&event_name, true);
                }
                PageLoadEvent::Finished => {
                    let _ = app_load.emit(&event_name, false);
                    // Emit final URL (may differ from navigation URL due to redirects)
                    if let Ok(final_url) = _webview.url() {
                        let _ = app_load.emit(
                            &format!("browser:url-changed:{}", tab_id_load),
                            final_url.to_string(),
                        );
                    }
                }
            }
        })
        .on_new_window(move |url, _features| {
            // Redirect target="_blank" / window.open() into the current webview
            let app = app_new_win.clone();
            let lbl = label_new_win.clone();
            let nav_url = url.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(webview) = app.get_webview(&lbl) {
                    let _ = webview.navigate(nav_url);
                }
            });
            tauri::webview::NewWindowResponse::Deny
        });

    // Get the Window (not WebviewWindow) to add a child webview
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let position = LogicalPosition::new(x, y);
    let size = LogicalSize::new(width, height);

    window
        .add_child(builder, position, size)
        .map_err(|e| format!("Failed to create browser webview: {e}"))?;

    // Store session
    let mut sessions = state.sessions.lock().await;
    sessions.insert(
        tab_id.clone(),
        BrowserSession {
            webview_label: label.clone(),
            tab_id: tab_id.clone(),
            visible: true,
            last_x: x,
            last_y: y,
            last_width: width,
            last_height: height,
        },
    );

    ulog_info!("[browser] Created webview '{}' for tab {}", label, tab_id);
    Ok(())
}

/// Navigate the existing browser webview to a new URL.
#[tauri::command]
pub async fn cmd_browser_navigate(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    let parsed_url: Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;
    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .navigate(parsed_url)
        .map_err(|e| format!("Navigation failed: {e}"))
}

/// Go back in browser history.
#[tauri::command]
pub async fn cmd_browser_go_back(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .eval("window.history.back()")
        .map_err(|e| format!("Go back failed: {e}"))
}

/// Go forward in browser history.
#[tauri::command]
pub async fn cmd_browser_go_forward(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .eval("window.history.forward()")
        .map_err(|e| format!("Go forward failed: {e}"))
}

/// Reload the current page.
#[tauri::command]
pub async fn cmd_browser_reload(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .reload()
        .map_err(|e| format!("Reload failed: {e}"))
}

/// Update webview position and size.
#[tauri::command]
pub async fn cmd_browser_resize(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    // Update cached position
    session.last_x = x;
    session.last_y = y;
    session.last_width = width;
    session.last_height = height;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    let _ = webview.set_position(LogicalPosition::new(x, y));
    let _ = webview.set_size(LogicalSize::new(width, height));
    Ok(())
}

/// Show the browser webview (restore from hidden state).
#[tauri::command]
pub async fn cmd_browser_show(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    if session.visible {
        return Ok(());
    }

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    // Restore position and show
    let _ = webview.set_position(LogicalPosition::new(session.last_x, session.last_y));
    let _ = webview.set_size(LogicalSize::new(session.last_width, session.last_height));
    let _ = webview.show();
    session.visible = true;
    Ok(())
}

/// Hide the browser webview (move off-screen).
#[tauri::command]
pub async fn cmd_browser_hide(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    if !session.visible {
        return Ok(());
    }

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    let _ = webview.hide();
    session.visible = false;
    Ok(())
}

/// Destroy the browser webview for a tab.
#[tauri::command]
pub async fn cmd_browser_close(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.remove(&tab_id) {
        if let Some(webview) = app.get_webview(&session.webview_label) {
            let _ = webview.close();
        }
        ulog_info!(
            "[browser] Closed webview '{}' for tab {}",
            session.webview_label,
            tab_id
        );
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────

/// Close all browser webviews (app exit cleanup).
pub async fn close_all_browsers(state: &Arc<BrowserManager>, app: &AppHandle) {
    let mut sessions = state.sessions.lock().await;
    let count = sessions.len();
    for (_tab_id, session) in sessions.drain() {
        if let Some(webview) = app.get_webview(&session.webview_label) {
            let _ = webview.close();
        }
    }
    if count > 0 {
        ulog_info!("[browser] Closed {} browser(s) on shutdown", count);
    }
}
