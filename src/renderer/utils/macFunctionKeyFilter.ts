// macOS NSEvent encodes function keys (arrows, F1-F35, page up/down, …)
// as Unicode private-use codepoints in `[NSEvent characters]` — see
// `NSFunctionKey` family in AppKit. WebKit *should* consume them in
// `keydown` (cursor move / scroll) and never dispatch `keypress` /
// `input`, but at input boundaries (cursor at index 0 pressing ←, or
// cursor at end pressing →) the keydown handler does nothing → the raw
// private-use codepoint falls through to the `input` event → ends up in
// the textarea/input value as a tofu glyph (no font carries U+F700-F74F).
//
// Tauri's WKWebView on macOS exposes the bug; WebView2 (Win) and
// webkit2gtk (Linux) don't, so this helper is effectively a macOS-only
// workaround that is a no-op on every other path.
//
// Apple reserves U+F700 through U+F8FF for "function key Unicodes",
// but in practice the keys we care about live in U+F700-F74F. We strip
// the whole F700-F74F band — wider than the canonical 4 arrows because
// page-up / home / end / fn-arrow can all leak the same way, and nothing
// legitimate puts those codepoints into user text.
//
// Built via `RegExp` constructor with explicit `\\u` escapes so the
// source stays printable in editors / git diffs — a literal U+F702
// inside a regex is a tofu in most fonts, indistinguishable from
// whitespace and very easy to corrupt during a copy-paste.
const MAC_FUNCTION_KEY_RANGE = new RegExp('[\\u{F700}-\\u{F74F}]', 'gu');

export function stripMacFunctionKeys(s: string): string {
  // Cheap fast-path so the common case (no leak) does not pay regex cost.
  // `search` returns -1 quickly when the input is ASCII / non-private-use,
  // which is ~all of the time.
  if (s.search(MAC_FUNCTION_KEY_RANGE) === -1) return s;
  return s.replace(MAC_FUNCTION_KEY_RANGE, '');
}
