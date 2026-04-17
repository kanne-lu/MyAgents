// Shared tag-parse + boundary rules, kept in lock-step with the Rust parser at
// `src-tauri/src/thought.rs::parse_tags`. The UI uses this to:
//   1. Render inline `#xxx` highlights identical to what the Rust side extracts
//      into `thought.tags` (so the card never shows a highlighted "tag" that
//      the backend disagrees with).
//   2. Let the user click a highlighted tag to filter the thought stream.
//
// Keep the char ranges and boundary set in sync with `is_tag_char` /
// `is_tag_boundary_char` in the Rust module. Cross-review regression guard:
// the Rust parser rejects mid-word `url?x=a#b` and accepts `#维护` after `。` /
// `，`; our `splitWithTagHighlights` below does the same.

/** Characters that may appear inside a tag body. Mirrors `is_tag_char` in Rust. */
function isTagChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  // ASCII alphanumeric / `_` / `-`
  if (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x2d
  ) {
    return true;
  }
  // CJK Unified Ideographs (U+4E00..U+9FFF)
  if (code >= 0x4e00 && code <= 0x9fff) return true;
  // CJK Extension A (U+3400..U+4DBF)
  if (code >= 0x3400 && code <= 0x4dbf) return true;
  // Hiragana/Katakana (U+3040..U+30FF)
  if (code >= 0x3040 && code <= 0x30ff) return true;
  return false;
}

const BOUNDARY_PUNCT = new Set([
  '(',
  '[',
  '{',
  ',',
  '，',
  '。',
  '、',
  '：',
  ':',
  ';',
  '；',
  '（',
  '【',
]);

function isBoundaryChar(ch: string): boolean {
  if (/\s/.test(ch)) return true;
  return BOUNDARY_PUNCT.has(ch);
}

export interface TagSegment {
  type: 'text' | 'tag';
  value: string;
  /** Tag body (without the leading `#`), only set when `type === 'tag'`. */
  tag?: string;
}

/**
 * Split `content` into `{type, value}` segments, marking `#xxx` runs as tags
 * when they pass the Rust parser's boundary + char-class rules.
 */
export function splitWithTagHighlights(content: string): TagSegment[] {
  const segments: TagSegment[] = [];
  const chars = [...content]; // splits by codepoint
  let cursor = 0;
  let plainStart = 0;

  while (cursor < chars.length) {
    const ch = chars[cursor];
    if (ch === '#') {
      const prevOk =
        cursor === 0 || isBoundaryChar(chars[cursor - 1]);
      if (prevOk) {
        // Collect tag body
        let j = cursor + 1;
        while (j < chars.length && isTagChar(chars[j])) j += 1;
        if (j > cursor + 1) {
          // Emit preceding plain text.
          if (cursor > plainStart) {
            segments.push({
              type: 'text',
              value: chars.slice(plainStart, cursor).join(''),
            });
          }
          const bodyChars = chars.slice(cursor + 1, j);
          segments.push({
            type: 'tag',
            value: '#' + bodyChars.join(''),
            tag: bodyChars.join(''),
          });
          cursor = j;
          plainStart = j;
          continue;
        }
      }
    }
    cursor += 1;
  }
  if (plainStart < chars.length) {
    segments.push({
      type: 'text',
      value: chars.slice(plainStart).join(''),
    });
  }
  return segments;
}
