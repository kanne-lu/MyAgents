/**
 * Widget Tag Parser — Extracts <widget> tags from streaming text.
 *
 * Splits text content into segments: plain text and widget blocks.
 * Used by Message.tsx to render widgets inline with Markdown content.
 *
 * Handles:
 * - Complete widgets: <widget title="xxx">HTML</widget>
 * - Partial/streaming widgets: <widget title="xxx">partial HTML...
 * - Multiple widgets in a single text block
 * - Text before, between, and after widgets
 */

export interface WidgetSegment {
  type: 'widget';
  title: string;
  code: string;
  isComplete: boolean;
}

export interface TextSegment {
  type: 'text';
  content: string;
}

export type Segment = TextSegment | WidgetSegment;

// Match opening <widget title="..."> tag
const WIDGET_OPEN_RE = /<widget\s+title\s*=\s*"([^"]+)"\s*>/i;
// Match closing </widget> tag
const WIDGET_CLOSE_RE = /<\/widget>/i;

/**
 * Parse text into segments of plain text and widget blocks.
 * Supports streaming: if text ends mid-widget (no closing tag), returns
 * the widget with isComplete=false.
 */
export function parseWidgetTags(text: string): Segment[] {
  const segments: Segment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const openMatch = WIDGET_OPEN_RE.exec(remaining);

    if (!openMatch) {
      // No more widget tags — rest is plain text
      if (remaining.trim()) {
        segments.push({ type: 'text', content: remaining });
      }
      break;
    }

    // Text before the widget tag
    const textBefore = remaining.slice(0, openMatch.index);
    if (textBefore.trim()) {
      segments.push({ type: 'text', content: textBefore });
    }

    const title = openMatch[1];
    const afterOpen = remaining.slice(openMatch.index + openMatch[0].length);

    // Look for closing tag
    const closeMatch = WIDGET_CLOSE_RE.exec(afterOpen);

    if (closeMatch) {
      // Complete widget
      const widgetCode = afterOpen.slice(0, closeMatch.index);
      segments.push({
        type: 'widget',
        title,
        code: widgetCode,
        isComplete: true,
      });
      remaining = afterOpen.slice(closeMatch.index + closeMatch[0].length);
    } else {
      // Partial widget (still streaming) — everything after the opening tag is widget code
      segments.push({
        type: 'widget',
        title,
        code: afterOpen,
        isComplete: false,
      });
      break; // Nothing more to parse
    }
  }

  return segments;
}

/**
 * Quick check: does the text contain any <widget> tags?
 * Used to avoid expensive parsing for plain text messages.
 */
export function hasWidgetTags(text: string): boolean {
  return WIDGET_OPEN_RE.test(text);
}
