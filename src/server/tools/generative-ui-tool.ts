// Generative UI MCP Tool — AI generates interactive HTML widgets inline in chat
// Context-injected MCP server (same pattern as im-cron: always present for desktop sessions)
//
// Architecture:
//   1. widget_read_me MCP tool — On-demand design guideline loader (per-module)
//      Returns design system + instructions to output <widget> tags in text
//   2. AI outputs <widget title="...">HTML</widget> tags in regular text response
//   3. Frontend parses tags from chat:message-chunk stream → renders in sandbox iframe
//
// Why text tags instead of MCP tool_use:
//   Agent SDK buffers MCP tool input_json_delta until tool execution completes,
//   preventing real-time streaming. Text output (chat:message-chunk) streams token-by-token.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

// ===================================================================
// Design Guideline Sections (loaded on-demand by widget_read_me)
// ===================================================================

const SECTION_CORE = `# Widget Design System — Core

## Philosophy
Widgets render inline in the chat message flow. They must feel like a natural part of the conversation — not a foreign embed.
- **Seamless**: background transparent, typography matches surrounding text
- **Flat**: no gradients, mesh backgrounds, noise textures, drop shadows, blur, glow
- **Compact**: show essential content inline, explain the rest in your text response
- **Text goes in response, visuals go in \`<widget>\` tags**: all explanatory text must be OUTSIDE the widget tags

## Streaming rules
HTML streams token by token. Structure for progressive rendering:
- <style> first (short, ≤15 lines) — so elements are styled as they appear
- Content HTML next — visual elements render progressively
- <script> last — runs only after streaming completes
- Prefer inline style="..." over <style> blocks when possible
- SVG: <defs> (markers) first, then visual elements immediately

## Hard constraints
- widget_code = self-contained HTML fragment. NO <!DOCTYPE>, <html>, <head>, <body>
- 2 font weights only: 400 regular, 600 semibold. Never 700.
- No gradients, drop shadows, blur, glow (they flash during streaming DOM diffs)
- No HTML comments, CSS comments (waste tokens, break streaming)
- No font-size below 11px
- No emoji — use CSS shapes or SVG paths
- No position:fixed (iframe viewport auto-sizes to content height)
- No tabs, carousels, display:none during streaming
- No fetch() / XMLHttpRequest / WebSocket — all data must be inline in widget_code (network is blocked by CSP)
- Responsive: percentage widths, viewBox for SVG. Min width 300px.
- Match the conversation language for all text content.

## CSS variables (auto light/dark — always use these, never hardcode colors)
### Layout
- --widget-text: primary text
- --widget-text-secondary: secondary/muted text
- --widget-text-muted: subtle/hint text
- --widget-bg: main background (transparent in widget context)
- --widget-bg-elevated: card/surface background
- --widget-bg-inset: inset/input background
- --widget-border: default border (10% opacity)
- --widget-border-strong: hover/emphasis border (18% opacity)
- --widget-accent: warm accent (buttons, links, highlights)
- --widget-accent-subtle: 8% accent background
- --widget-radius: default border radius (10px)

### Semantic
- --widget-success / --widget-success-bg
- --widget-error / --widget-error-bg
- --widget-warning / --widget-warning-bg
- --widget-info / --widget-info-bg

## CDN libraries (CSP-enforced allowlist)
- Chart.js: https://cdn.jsdelivr.net/npm/chart.js
- D3.js: https://cdn.jsdelivr.net/npm/d3@7
- Mermaid: https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js
- Lucide: https://unpkg.com/lucide@latest
- Any package from: cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com, esm.sh`;

const SECTION_PALETTE = `# Color Palette — 7 ramps, 7 stops each

Colors encode meaning, not sequence. Don't cycle like a rainbow.
- 2-3 ramps max per widget
- Text on colored backgrounds: use 800/900 stop from same ramp, never pure black
- Light mode fills: 50 stop. Strokes/borders: 400-600 stop. Titles: 800 stop.
- Subtle backgrounds: use the 50 stop at 60% opacity for gentler tones.

| Ramp    | 50      | 100     | 300     | 500     | 700     | 800     | 900     |
|---------|---------|---------|---------|---------|---------|---------|---------|
| Warm    | #faf0e6 | #f0d9bf | #d4a574 | #c26d3a | #8b4513 | #6b3410 | #4a2409 |
| Teal    | #e6f5f0 | #b3e0cf | #5dbf9e | #2e8b6e | #1a6b50 | #0f5040 | #04342c |
| Coral   | #faeae5 | #f0bfad | #e08060 | #c25030 | #8b3018 | #6b2010 | #4a150a |
| Sage    | #f0f2ec | #d4dbc8 | #a3b08a | #6f8660 | #4a6040 | #3a4a30 | #2a3520 |
| Stone   | #f2f0eb | #d6d2c9 | #ada599 | #857d74 | #5f5a54 | #454240 | #2e2c2a |
| Sky     | #e8f1fa | #b8d4f0 | #70a8d8 | #3a7ab8 | #1a5a90 | #0e4070 | #052a4a |
| Amber   | #faf0dc | #f0d68a | #daa830 | #b88018 | #8a5a0a | #6a4005 | #4a2a02 |

### Assignment rules
- Primary data: Warm or Teal (the app's signature colors)
- Positive/growth: Teal or Sage
- Negative/decline: Coral
- Neutral/reference: Stone
- Informational: Sky
- Warning/attention: Amber
- Never use more than 3 ramps in a single widget`;

const SECTION_CHART = `# Charts — Chart.js patterns

## Canvas setup
Always wrap canvas in a sized container. Chart.js reads container dimensions.
\`\`\`html
<div style="width:100%;max-width:600px;margin:0 auto">
  <canvas id="myChart"></canvas>
</div>
\`\`\`

## Color usage
- Use palette ramps at the 500 stop for data series fills (with 20% opacity for area)
- Use 700 stop for line strokes and point borders
- Grid lines: var(--widget-border) at 50% opacity
- Axis labels: var(--widget-text-secondary)
- Tooltips: var(--widget-bg-elevated) background, var(--widget-text) text

## Legend
- Use HTML legend (not Chart.js built-in) for styling control
- Position below chart, centered, gap: 16px between items
- Legend dot: 8px circle with series color, margin-right: 6px
- Legend text: 12px, var(--widget-text-secondary)

## Number formatting
- Use Intl.NumberFormat for locale-aware formatting
- Abbreviate large numbers: 1,234,567 → 1.2M
- Percentages: always show 1 decimal (e.g., 45.2%)

## Dashboard layout (multiple charts)
- Use CSS Grid: grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))
- Gap: 16px
- Each chart card: var(--widget-bg-elevated) background, var(--widget-radius) border-radius, 16px padding
- Card title: 13px, 600 weight, var(--widget-text)
- Metric value: 24px, 600 weight, var(--widget-text)
- Metric label: 11px, var(--widget-text-muted)`;

const SECTION_DIAGRAM = `# Diagrams — SVG patterns

## SVG setup
- Always set viewBox. Width 100%, height auto.
- Font: system-ui (matches parent). Calibrate text widths for system-ui metrics.
- Use <defs> for markers (arrowheads) and reusable patterns.

## Box/node styling
- Fill: palette 50 stop
- Stroke: palette 500 stop, 1.5px
- Border radius: 8px (rx="8")
- Padding: 12px horizontal, 8px vertical
- Title: 13px, 600 weight, palette 800 stop
- Subtitle: 11px, 400 weight, palette 700 stop
- Max 5 words per subtitle

## Connectors
- Stroke: var(--widget-border-strong), 1.5px
- Arrow marker: 8x6, filled with stroke color
- Curved paths preferred (cubic bezier) over straight lines
- Labels on connectors: 10px, var(--widget-text-muted), white background knockout

## Layout rules
- Horizontal tier: max 4 boxes at full width
- Vertical spacing: 60-80px between tiers
- Horizontal spacing: 24-40px between boxes
- Center-align tiers, stagger connectors for clarity

## Flowchart types
| Type | When | Style |
|------|------|-------|
| Structural | "architecture", "components", "modules" | Boxes with hierarchy/containment |
| Process | "flow", "pipeline", "steps", "workflow" | Left-to-right or top-to-bottom sequence |
| Illustrative | "how does X work", "explain" | Visual metaphors, loose layout |

## Complexity budget
- Max 4 boxes per horizontal tier
- Max 3 tiers for simple diagrams, 5 for complex
- 2 color ramps max per diagram`;

const SECTION_INTERACTIVE = `# Interactive — UI component patterns

## Component tokens
- Card: var(--widget-bg-elevated), 1px solid var(--widget-border), var(--widget-radius) border-radius, 16px padding
- Button primary: var(--widget-accent) bg, white text, 8px radius, 8px 16px padding, 13px 600 weight
- Button secondary: var(--widget-bg-inset) bg, var(--widget-text) text
- Input: var(--widget-bg) bg, 1px solid var(--widget-border), 8px radius, 8px 12px padding, 13px
- Input focus: border-color var(--widget-accent)
- Slider: accent-color var(--widget-accent) (native range input)
- Toggle: 40x22px, var(--widget-border) off, var(--widget-accent) on, white knob
- Badge/tag: var(--widget-bg-inset) bg, var(--widget-text-secondary) text, 4px 10px padding, 9999px radius, 11px

## Interactive explainer pattern
Use when: "explain how X works", "teach me about Y", "show me how Z works"
- Controls (sliders, inputs, toggles) at top or left
- Visualization (chart, SVG, canvas) reacts to controls in real-time
- Key metric display: large number with label, updates live
- State management: use a plain object and a render() function. No framework needed.

## Comparison layout
Use when: "compare X vs Y", "help me choose", "pricing comparison"
- Side-by-side card grid: grid-template-columns: repeat(auto-fit, minmax(200px, 1fr))
- Each card: var(--widget-bg-elevated), matching height, 16px padding
- Highlight recommended: 2px solid var(--widget-accent) border
- Feature rows: alternating var(--widget-bg) / transparent

## Data record layout
Use when: "show me the contact card", "create a receipt", "display the record"
- Single card, centered, max-width 400px
- Header: colored stripe using palette 500 stop, white text, 12px 16px padding
- Field rows: label (11px, var(--widget-text-muted)) + value (13px, var(--widget-text)), 8px row gap`;

const SECTION_ART = `# Art and illustration

## When to use
- "Draw", "illustrate", "create a visual of"
- Abstract concepts that benefit from visual metaphor
- Decorative header images for documents

## Rules
- Pure SVG only, no external images
- Use palette colors, not arbitrary hex
- Minimum viable detail — suggest rather than depict
- Ensure all shapes have accessible contrast against background
- No text-heavy illustrations (text goes in the response, not the SVG)`;

// Module → sections mapping (deduplicated when multiple modules requested)
const MODULE_SECTIONS: Record<string, string[]> = {
  chart:       ['CORE', 'PALETTE', 'CHART'],
  diagram:     ['CORE', 'PALETTE', 'DIAGRAM'],
  interactive: ['CORE', 'PALETTE', 'INTERACTIVE'],
  dashboard:   ['CORE', 'PALETTE', 'CHART', 'INTERACTIVE'],
  art:         ['CORE', 'PALETTE', 'ART'],
};

const ALL_SECTIONS: Record<string, string> = {
  CORE: SECTION_CORE,
  PALETTE: SECTION_PALETTE,
  CHART: SECTION_CHART,
  DIAGRAM: SECTION_DIAGRAM,
  INTERACTIVE: SECTION_INTERACTIVE,
  ART: SECTION_ART,
};

function buildReadMeContent(modules: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const mod of modules) {
    const sectionKeys = MODULE_SECTIONS[mod];
    if (!sectionKeys) continue;
    for (const key of sectionKeys) {
      if (!seen.has(key)) {
        seen.add(key);
        parts.push(ALL_SECTIONS[key]);
      }
    }
  }
  if (parts.length === 0) {
    return 'Unknown module(s). Available: chart, diagram, interactive, dashboard, art.';
  }
  // Always prepend output format instructions
  return SECTION_OUTPUT_FORMAT + '\n\n---\n\n' + parts.join('\n\n---\n\n');
}

// ===================================================================
// Output Format Section (prepended to all widget_read_me responses)
// Teaches the AI to output <widget> tags in text instead of tool calls
// ===================================================================

const SECTION_OUTPUT_FORMAT = `# How to Output Widgets

## Output format
To create a widget, output a \`<widget>\` tag directly in your text response (NOT as a tool call).
The frontend will detect the tag, extract the HTML, and render it in a sandboxed iframe inline in the conversation.

\`\`\`
Your explanatory text here...

<widget title="snake_case_title">
<style>
  .widget { font-family: system-ui, sans-serif; color: var(--widget-text); padding: 16px; }
</style>
<div class="widget">
  <!-- SVG, canvas, or HTML content -->
</div>
<script>
  // Interactive logic. Runs after all HTML is rendered.
</script>
</widget>

More explanatory text here...
\`\`\`

## Rules
- The \`<widget>\` tag MUST have a \`title\` attribute (snake_case identifier)
- Content inside is a self-contained HTML fragment — NO <!DOCTYPE>, <html>, <head>, <body>
- Structure for streaming: <style> first (short) → content HTML → <script> last
- All explanatory text goes OUTSIDE the <widget> tags (in normal markdown)
- You can output multiple widgets in a single response
- The widget tag renders inline with your text — like an embedded figure

## When to use — route on the verb, not the noun
- "Show me / visualize / chart / graph / plot" → use <widget>
- Data visualization: charts, graphs, trend lines, comparisons (Chart.js)
- Architecture/flow diagrams: system architecture, data flow, process flows (SVG)
- Interactive explainers: calculators, converters, sliders, live demos
- Structured displays: timelines, org charts, cards, dashboards

## When NOT to use
- Simple text answers → regular text
- Code snippets → code blocks
- Static tables → Markdown tables
- "Show me the ERD / database schema" → Mermaid in code block
- Content the user explicitly asks as text/code`;

// ===================================================================
// Tool Description
// ===================================================================

const READ_ME_DESCRIPTION = `Load the design guidelines for creating interactive visual widgets.
You MUST call this before outputting any <widget> tags. It returns the design system (color palette, component specs, layout rules) and output format instructions.

Available modules:
- chart: Chart.js patterns, data colors, legends, dashboard layouts
- diagram: SVG flowcharts, architecture diagrams, connector styling
- interactive: Sliders, calculators, comparison cards, data records
- dashboard: Combines chart + interactive (multi-chart layouts with controls)
- art: SVG illustration, visual metaphors

Call with the module(s) most relevant to your planned widget. You can request multiple at once.`;

// ===================================================================
// MCP Server
// ===================================================================

export function createGenerativeUiServer() {
  return createSdkMcpServer({
    name: 'generative-ui',
    version: '1.0.0',
    tools: [
      tool(
        'widget_read_me',
        READ_ME_DESCRIPTION,
        {
          modules: z.array(z.string()).describe(
            'Design guideline modules to load. One or more of: chart, diagram, interactive, dashboard, art.'
          ),
        },
        async (args) => {
          const content = buildReadMeContent(args.modules);
          return {
            content: [{ type: 'text', text: content }],
          };
        }
      ),
    ],
  });
}

export const generativeUiServer = createGenerativeUiServer();
