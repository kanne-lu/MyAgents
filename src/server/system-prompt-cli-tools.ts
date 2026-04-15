/**
 * CLI-backed capability hints for external runtimes (v0.1.67)
 *
 * Background
 * ----------
 * The builtin Claude Agent SDK runtime exposes MyAgents-specific capabilities
 * (cron scheduling, IM media sending, generative-UI widgets) as in-process
 * `SdkMcpServerConfig` tools — only the builtin runtime can see them. External
 * runtimes (Claude Code CLI / Codex CLI / Gemini CLI) speak plain JSON-RPC or
 * NDJSON over stdio; they can't consume those in-process MCP servers.
 *
 * Rather than re-implement every capability as a standalone stdio MCP server
 * (doubling the surface area to maintain), v0.1.67 exposes them through the
 * `myagents` CLI — which all three external runtimes can already invoke via
 * their native shell tool — and teaches the AI about them through this module.
 *
 * Progressive disclosure
 * ----------------------
 * We pre-inject only the *brief* description + trigger conditions + "fetch the
 * full docs via `myagents X readme`". The full usage is pulled on demand so
 * tokens aren't wasted on unused capabilities. This matches how the builtin
 * runtime uses `widget_read_me` — the AI calls a meta tool to load detail only
 * when it decides to use the feature.
 *
 * Scope gating
 * ------------
 * ONLY external runtimes call `buildCliToolsAppend()`. The builtin path keeps
 * using its existing MCP servers and NEVER gets this appendix (confirmed by
 * the `cliToolsEnabled` flag in `buildSystemPromptAppend` — see
 * `system-prompt.ts`). This keeps builtin behaviour byte-identical to v0.1.66,
 * zero regression risk.
 */

import type { InteractionScenario } from './system-prompt';

// ===== Capability sections =====
//
// Each section is a self-contained block with one responsibility. We stack
// them conditionally per scenario in `buildCliToolsAppend` below.

const SECTION_CRON = `<myagents-cli-cron>
You can create, inspect, and manage MyAgents scheduled tasks from the shell
using the \`myagents cron\` CLI. These tasks run inside MyAgents on a schedule
regardless of which runtime the user is currently chatting with. Use this
whenever the user asks for anything like:

  "每 N 分钟 / 每小时 / 每天 / 定时 / 到 HH:MM 提醒 / 循环检查 / run on a schedule"

Trigger: any request that implies repetition over time.

DO NOT use the system \`cron\` / \`crontab\` / \`at\` / \`launchctl\` / \`schtasks\`
commands for this — they can't see MyAgents state. Only \`myagents cron\` creates
tasks that can invoke the AI with a prompt on a schedule.

Quick reference (full docs: run \`myagents cron readme\`):
  myagents cron list                       # see existing tasks
  myagents cron add --name X --prompt "..." --every 30    # short prompts
  myagents cron add --name X --prompt-file /tmp/p.txt --every 30
      # Long / multiline / quoted prompts — write to a file first (using your
      # normal file-writing tool) and pass --prompt-file. This avoids shell
      # escape problems with quotes, newlines, and backticks.
  myagents cron runs <taskId> --limit 5    # inspect recent executions
  myagents cron remove <taskId>            # delete a task

Pass \`--json\` on any command for machine-parseable output. Non-zero exit means
the command failed; read stderr for the reason. Before running any command,
always call \`myagents cron readme\` once if you haven't yet this session.
</myagents-cli-cron>`;

const SECTION_CRON_EXIT = `<myagents-cli-cron-exit>
You are currently running as a scheduled task AND the task creator enabled
"Allow AI to exit". If the task goal is fully achieved, or further executions
would be pointless or counterproductive, end the task early:

  myagents cron exit --reason "goal achieved: ..."

This marks the task complete and stops future executions. Only use this when
you're sure — the user set up a schedule for a reason. Do NOT use it to bail
out of transient errors; retry instead.
</myagents-cli-cron-exit>`;

const SECTION_IM_MEDIA = `<myagents-cli-im-media>
You are running inside an IM Bot / Agent Channel session. To send a file
(image, document, chart, etc.) to the current chat, use:

  myagents im send-media --file <absolute-path> [--caption "..."]

Workflow:
  1. Generate or write the file to disk using your normal file-writing tools.
  2. Call \`myagents im send-media --file /abs/path\`. The session's bot/chat
     context is resolved automatically from the current Sidecar — you do not
     need to know the botId or chatId.

Use this when the user asks to receive a file, image, screenshot, chart, PDF,
CSV, etc. Do NOT use it for intermediate work files — only the deliverables
the user explicitly wants.

Full docs and supported formats: run \`myagents im readme\`.
</myagents-cli-im-media>`;

const SECTION_WIDGET = `<myagents-cli-widget>
For desktop chat replies that benefit from an interactive visual (chart,
diagram, dashboard, interactive explainer, SVG illustration), you can embed a
\`<generative-ui-widget>\` tag directly in your text response. MyAgents renders
the HTML inside the tag as a sandboxed interactive widget inline in the
conversation.

Trigger: the user asks to visualize / chart / draw / diagram / compare / build
an interactive explainer — or any request where a visual answer is clearly
better than text.

DO NOT use this for: simple text answers, code snippets (use fenced blocks),
static tables (use markdown tables), or ER/schema diagrams (Mermaid in a code
block is better).

Before outputting your first widget in a session, load the design guidelines
and output format contract:

  myagents widget readme <module> [<module> ...]

Modules: \`chart\` \`diagram\` \`interactive\` \`dashboard\` \`art\`. Pick the one(s)
that match your planned widget and request them together. The output includes
the mandatory \`<generative-ui-widget>\` tag format plus color palette, layout
classes, and streaming rules. Running this lookup is cheap — do it whenever
you're about to build a widget and don't already have the guidelines in
context.
</myagents-cli-widget>`;

// ===== Main entry =====

/**
 * Build the CLI-tools system-prompt appendix for a given interaction scenario.
 *
 * Conditional stacking:
 *   - cron CRUD         always (every scenario can benefit from scheduling)
 *   - cron self-exit    only when scenario.type === 'cron' && aiCanExit
 *   - IM media          only in 'im' / 'agent-channel' scenarios
 *   - generative UI     only in 'desktop' / 'cron' scenarios (widgets need a
 *                       desktop chat to render; cron tasks can still produce
 *                       widgets when the user later views the session history)
 *
 * Returns an empty string when nothing applies (defensive; not expected in
 * practice since cron is always emitted).
 */
export function buildCliToolsAppend(scenario: InteractionScenario): string {
  const parts: string[] = [];

  // cron — universal
  parts.push(SECTION_CRON);

  // cron self-exit — only inside a cron run that allows it
  if (scenario.type === 'cron' && scenario.aiCanExit) {
    parts.push(SECTION_CRON_EXIT);
  }

  // IM media — IM / agent-channel scenarios only
  if (scenario.type === 'im' || scenario.type === 'agent-channel') {
    parts.push(SECTION_IM_MEDIA);
  }

  // Generative UI widget — desktop only, matching the builtin path's gate in
  // agent-session.ts (`generativeUiEnabled: currentScenario.type === 'desktop'`).
  // Cron tasks run headless and their output isn't rendered in a live chat
  // view that can host a widget iframe, so there's no point teaching the AI
  // to emit widget tags from a cron context.
  if (scenario.type === 'desktop') {
    parts.push(SECTION_WIDGET);
  }

  return parts.join('\n\n');
}
