// Custom `myagents://` URI scheme for binary attachment delivery.
//
// Replaces the previous architecture where GET /sessions/:id embedded every
// image attachment as a base64 data URL in the JSON body — that synchronously
// read files on the Bun event loop, bloated the response 1.33×, and forced
// both Bun and the WebView to round-trip 50-100MB strings through JSON.
//
// Now the server only returns attachment metadata; `<img src="myagents://...">`
// triggers this handler which serves bytes directly through WebKit's resource
// pipeline. Zero JSON, zero base64, zero main-thread blocking.
//
// URL form:
//   macOS / Linux: myagents://attachment/<sessionId>/<filename.ext>
//   Windows:       http://myagents.localhost/attachment/<sessionId>/<filename.ext>
// The Windows form is what Tauri 2 auto-rewrites custom schemes to; the parser
// accepts either by anchoring on "attachment/" in the URI string.

use std::path::{Path, PathBuf};

use tauri::http::{Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

use crate::app_dirs::myagents_data_dir;

fn attachments_root() -> Option<PathBuf> {
    myagents_data_dir().map(|d| d.join("attachments"))
}

fn mime_from_ext(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain; charset=utf-8",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .unwrap()
}

fn extract_relative_path(uri: &str) -> Option<String> {
    // Accept both "myagents://attachment/<rel>" and "http://myagents.localhost/attachment/<rel>".
    let marker = "attachment/";
    let idx = uri.find(marker)?;
    let rest = &uri[idx + marker.len()..];
    // Strip query string and fragment.
    let rest = rest.split('?').next().unwrap_or(rest);
    let rest = rest.split('#').next().unwrap_or(rest);
    if rest.is_empty() {
        return None;
    }
    // Crude URL decode — attachments are saved with UUID filenames, so %-sequences
    // are rare, but Chinese file names may appear in custom uploads.
    Some(percent_decode(rest))
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn build_response(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri_str = request.uri().to_string();
    let Some(rel) = extract_relative_path(&uri_str) else {
        return empty(StatusCode::NOT_FOUND);
    };

    let Some(root) = attachments_root() else {
        return empty(StatusCode::NOT_FOUND);
    };
    let candidate = root.join(&rel);

    // Path traversal guard: resolve to canonical paths and require containment.
    // If the file doesn't exist yet, canonicalize() fails — treat as not found.
    let canonical = match candidate.canonicalize() {
        Ok(p) => p,
        Err(_) => return empty(StatusCode::NOT_FOUND),
    };
    let root_canonical = match root.canonicalize() {
        Ok(p) => p,
        Err(_) => return empty(StatusCode::NOT_FOUND),
    };
    if !canonical.starts_with(&root_canonical) {
        return empty(StatusCode::FORBIDDEN);
    }

    let bytes = match std::fs::read(&canonical) {
        Ok(b) => b,
        Err(_) => return empty(StatusCode::NOT_FOUND),
    };

    let mime = mime_from_ext(&canonical);
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime)
        .header("Content-Length", bytes.len().to_string())
        // Attachment files are immutable once written (UUID-named), so long cache is safe.
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap()
}

/// Async URI scheme handler. File I/O runs on Tauri's pooled blocking executor
/// so a large image read never blocks the webview thread, and rapid scrolling
/// through a paginated gallery doesn't spawn one fresh OS thread per request.
pub fn handle<R: Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    tauri::async_runtime::spawn_blocking(move || {
        let response = build_response(&request);
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_macos_form() {
        let r = extract_relative_path("myagents://attachment/abc/file.png").unwrap();
        assert_eq!(r, "abc/file.png");
    }

    #[test]
    fn extract_windows_form() {
        let r = extract_relative_path("http://myagents.localhost/attachment/abc/file.png").unwrap();
        assert_eq!(r, "abc/file.png");
    }

    #[test]
    fn strips_query_string() {
        let r = extract_relative_path("myagents://attachment/abc/file.png?v=1").unwrap();
        assert_eq!(r, "abc/file.png");
    }

    #[test]
    fn percent_decodes_spaces() {
        assert_eq!(percent_decode("foo%20bar"), "foo bar");
    }

    #[test]
    fn rejects_non_attachment_uri() {
        assert!(extract_relative_path("myagents://other/foo").is_none());
    }
}
