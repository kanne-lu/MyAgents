#!/usr/bin/env bun
/**
 * myagents — Self-Configuration CLI for MyAgents
 *
 * A thin wrapper that parses CLI arguments and forwards them as HTTP requests
 * to the Sidecar's Admin API. All business logic lives in the Sidecar.
 *
 * Environment:
 *   MYAGENTS_PORT — Sidecar port (injected by buildClaudeSessionEnv)
 */

// ---------------------------------------------------------------------------
// Port discovery
// ---------------------------------------------------------------------------

// Port is resolved after arg parsing (--port flag can override env)
let PORT = process.env.MYAGENTS_PORT ?? '';
let BASE = '';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);

/** Parse CLI arguments into structured flags and positional args */
function parseArgs(args: string[]): { positional: string[]; flags: Record<string, unknown> } {
  const positional: string[] = [];
  const flags: Record<string, unknown> = {};
  const repeatable = new Set(['args', 'env', 'headers', 'models', 'model-names']);

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      // Boolean flags (no value follows)
      if (key === 'help' || key === 'json' || key === 'dry-run' || key === 'disable-nonessential') {
        flags[camelCase(key)] = true;
        i++;
        continue;
      }
      // Repeatable flags: ALWAYS consume the next token as a value, even if it
      // starts with '--' (e.g. --args "--stdio"). The boolean-fallback check
      // below must NOT run for repeatable flags — it would overwrite the
      // accumulated array with `true`.
      if (repeatable.has(key)) {
        const value = args[i + 1];
        if (value === undefined) {
          // No value — normalize to empty array (not boolean) to keep type consistent
          const cKey = camelCase(key);
          if (!flags[cKey]) flags[cKey] = [];
          i++;
          continue;
        }
        // Collect values under camelCase key for consistency with non-repeatable flags
        const cKey = camelCase(key);
        const arr = (flags[cKey] as string[]) || [];
        arr.push(value);
        flags[cKey] = arr;
        i += 2;
        continue;
      }
      // Key-value flags (non-repeatable)
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags[camelCase(key)] = true;
        i++;
        continue;
      }
      {
        flags[camelCase(key)] = value;
        i += 2;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}

function camelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const TOP_HELP = `myagents — MyAgents Self-Configuration CLI

Usage: myagents <command> [options]

Commands:
  mcp       Manage MCP tool servers
  model     Manage model providers
  agent     Manage agents & channels
  skill     Manage skills (install from URL, list, enable/disable, sync)
  cron      Manage scheduled tasks (list/add/runs/exit ...)
  task      Manage Task Center tasks (list/get/update-status/run/rerun ...)
  thought   Manage Task Center thoughts (list/create)
  im        IM runtime actions for current chat (send-media)
  widget    Generative UI widget design guidelines (readme)
  plugin    Manage OpenClaw channel plugins
  config    Read/write application config
  status    Show app running state
  version   Show app version
  reload    Hot-reload configuration

Global flags:
  --help      Show help for any command
  --json      Output as JSON
  --dry-run   Preview changes without applying
  --port NUM  Override Sidecar port (default: $MYAGENTS_PORT)

Examples:
  myagents mcp list
  myagents mcp add --id playwright --type stdio --command npx --args @playwright/mcp@latest
  myagents mcp enable playwright --scope both
  myagents mcp oauth discover notion-mcp
  myagents mcp oauth start notion-mcp
  myagents model list
  myagents model set-key deepseek sk-xxx
  myagents skill list
  myagents skill add vercel-labs/skills --skill react-best-practices
  myagents skill add https://github.com/anthropics/skills --plugin document-skills
  myagents skill add "npx skills add foo/bar --skill baz" --force
  myagents skill remove my-skill
  myagents skill sync
  myagents cron list
  myagents task list
  myagents task get <taskId>            # returns metadata + docs paths
                                        # (task.md / verify.md / progress.md /
                                        #  alignment.md — read/edit them with
                                        #  standard Read/Edit/Write tools)
  myagents task update-status <taskId> running --message "starting work"
  myagents task update-status <taskId> verifying
  myagents task update-status <taskId> done --message "bundle size dropped 40%"
  myagents task append-session <taskId> <sessionId>
  myagents task run <taskId>
  myagents task rerun <taskId>
  myagents task create-from-alignment <alignmentSessionId> \
    --name "新任务" --workspaceId ws-abc --workspacePath /path/to/ws \
    --executionMode once --sourceThoughtId <thoughtId>
  myagents thought list
  myagents plugin list
  myagents version
  myagents reload

Run 'myagents <command> --help' for details on a specific command.`;

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function callApi(route: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
    const resp = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Non-JSON error bodies (e.g. axum 4xx returns plain text like
    // "Failed to deserialize query string: missing field `doc`") would
    // crash `resp.json()` with a SyntaxError — translate to an
    // AdminResponse-shaped error so the caller can surface it cleanly.
    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const text = await resp.text();
      return {
        success: false,
        error: text.trim() || `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    return await resp.json() as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      console.error('Error: Cannot connect to MyAgents. Is the app running?');
      process.exit(3);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printResult(group: string, action: string, result: Record<string, unknown>, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    return;
  }

  // Dry-run
  if (result.dryRun) {
    console.log('[DRY RUN] Would apply:');
    console.log(formatObject(result.preview as Record<string, unknown>));
    console.log('\nRun without --dry-run to apply.');
    return;
  }

  // Group-specific formatting
  if (group === 'mcp' && action === 'list') {
    printMcpList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'model' && action === 'list') {
    printModelList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'agent' && action === 'list') {
    printAgentList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'cron' && action === 'list') {
    printCronList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'cron' && action === 'runs') {
    printCronRuns(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'cron' && action === 'status') {
    printCronStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'plugin' && action === 'list') {
    printPluginList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'task' && action === 'list') {
    printTaskList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'task' && action === 'get') {
    printTaskDetail(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'thought' && action === 'list') {
    printThoughtList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'skill' && action === 'list') {
    printSkillList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'skill' && action === 'info') {
    printSkillInfo(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'skill' && action === 'add') {
    printSkillAdd(result as Record<string, unknown>);
    return;
  }
  if (group === 'mcp' && action === 'oauth') {
    printMcpOAuth(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'version') {
    console.log((result.data as { version: string })?.version ?? 'Unknown');
    return;
  }
  if (group === 'agent' && action === 'runtime-status') {
    printAgentRuntimeStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'status') {
    printStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'help') {
    console.log((result.data as { text: string })?.text ?? '');
    return;
  }

  // Tool readmes: `cron readme` / `im readme` / any `widget ...` form all
  // return a raw text body in result.data.text. Print it as-is — no padding,
  // no status line, no ticks — so AI can consume it directly as context.
  if (action === 'readme' || group === 'widget') {
    console.log((result.data as { text: string })?.text ?? '');
    return;
  }

  // Generic success output
  const symbol = '\u2713'; // ✓
  const hint = result.hint ? ` ${result.hint}` : '';
  const id = (result.data as Record<string, unknown>)?.id ?? '';
  console.log(`${symbol} ${action} ${id}${hint}`);
}

function printMcpList(servers: Array<Record<string, unknown>>): void {
  if (!servers || servers.length === 0) {
    console.log('No MCP servers configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 24) + pad('Type', 8) + pad('Status', 10) + 'Name');
  for (const s of servers) {
    const status = s.enabled ? 'enabled' : 'disabled';
    const builtin = s.isBuiltin ? ' (built-in)' : '';
    console.log(pad(String(s.id), 24) + pad(String(s.type), 8) + pad(status, 10) + String(s.name) + builtin);
  }
  const enabled = servers.filter(s => s.enabled).length;
  console.log(`\n${servers.length} MCP servers (${enabled} enabled)`);
}

function printModelList(providers: Array<Record<string, unknown>>): void {
  if (!providers || providers.length === 0) {
    console.log('No model providers configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 24) + pad('Status', 12) + 'Name');
  for (const p of providers) {
    console.log(pad(String(p.id), 24) + pad(String(p.status), 12) + String(p.name));
  }
}

function printAgentList(agents: Array<Record<string, unknown>>): void {
  if (!agents || agents.length === 0) {
    console.log('No agents configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 38) + pad('Status', 10) + pad('Channels', 10) + 'Name');
  for (const a of agents) {
    const status = a.enabled ? 'enabled' : 'disabled';
    console.log(pad(String(a.id).slice(0, 36), 38) + pad(status, 10) + pad(String(a.channelCount), 10) + String(a.name));
  }
}

function printStatus(data: Record<string, unknown>): void {
  const mcp = data.mcpServers as Record<string, number>;
  console.log(`MCP Servers: ${mcp?.total ?? 0} total, ${mcp?.enabled ?? 0} enabled`);
  console.log(`Active MCP in session: ${data.activeMcpInSession}`);
  console.log(`Default provider: ${data.defaultProvider}`);
  console.log(`Agents: ${data.agents}`);
}

function printCronList(tasks: Array<Record<string, unknown>>): void {
  if (!tasks || tasks.length === 0) {
    console.log('No cron tasks configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 24) + pad('Status', 10) + pad('Schedule', 20) + 'Name');
  for (const t of tasks) {
    const schedule = t.schedule
      ? (typeof t.schedule === 'object' && (t.schedule as Record<string, unknown>).kind === 'cron'
        ? String((t.schedule as Record<string, unknown>).expr)
        : `Every ${t.intervalMinutes}m`)
      : `Every ${t.intervalMinutes}m`;
    console.log(
      pad(String(t.id).slice(0, 22), 24) +
      pad(String(t.status), 10) +
      pad(schedule.slice(0, 18), 20) +
      String(t.name ?? (t.prompt as string)?.slice(0, 40) ?? '')
    );
  }
  const running = tasks.filter(t => t.status === 'Running' || t.status === 'running').length;
  console.log(`\n${tasks.length} cron tasks (${running} running)`);
}

function printCronRuns(runs: Array<Record<string, unknown>>): void {
  if (!runs || runs.length === 0) {
    console.log('No execution records.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('Time', 22) + pad('Status', 8) + pad('Duration', 12) + 'Output');
  for (const r of runs) {
    const time = r.ts ? new Date(Number(r.ts)).toLocaleString() : '?';
    const status = r.ok ? '\u2713' : '\u2717';
    const dur = r.durationMs ? `${(Number(r.durationMs) / 1000).toFixed(1)}s` : '?';
    const output = r.ok
      ? String(r.content ?? '').slice(0, 50)
      : String(r.error ?? '').slice(0, 50);
    console.log(pad(time, 22) + pad(status, 8) + pad(dur, 12) + output);
  }
}

function printCronStatus(data: Record<string, unknown>): void {
  console.log(`Total tasks: ${data.totalTasks ?? 0}`);
  console.log(`Running: ${data.runningTasks ?? 0}`);
  if (data.lastExecutedAt) console.log(`Last executed: ${data.lastExecutedAt}`);
  if (data.nextExecutionAt) console.log(`Next execution: ${data.nextExecutionAt}`);
}

function printPluginList(plugins: Array<Record<string, unknown>>): void {
  if (!plugins || plugins.length === 0) {
    console.log('No plugins installed.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 30) + pad('Version', 12) + 'Name');
  for (const p of plugins) {
    console.log(
      pad(String(p.name ?? p.id ?? '?'), 30) +
      pad(String(p.version ?? '?'), 12) +
      String(p.description ?? '')
    );
  }
  console.log(`\n${plugins.length} plugins installed`);
}

function printSkillList(skills: Array<Record<string, unknown>>): void {
  if (!skills || skills.length === 0) {
    console.log('No skills installed.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('Folder', 28) + pad('Scope', 10) + pad('Enabled', 10) + 'Description');
  for (const s of skills) {
    const enabled = s.enabled === false ? 'off' : 'on';
    const desc = String(s.description ?? '').slice(0, 60);
    console.log(
      pad(String(s.folderName ?? s.name ?? '?').slice(0, 26), 28) +
      pad(String(s.scope ?? 'user'), 10) +
      pad(enabled, 10) +
      desc,
    );
  }
  console.log(`\n${skills.length} skill(s)`);
}

function printSkillInfo(data: Record<string, unknown>): void {
  if (!data) {
    console.log('Skill not found.');
    return;
  }
  const fm = (data.frontmatter as Record<string, unknown>) || {};
  console.log(`Name:        ${fm.name ?? data.name ?? '?'}`);
  console.log(`Folder:      ${data.folderName ?? '?'}`);
  console.log(`Scope:       ${data.scope ?? 'user'}`);
  console.log(`Description: ${fm.description ?? ''}`);
  if (fm.author) console.log(`Author:      ${fm.author}`);
  if (fm['allowed-tools']) console.log(`Allowed:     ${JSON.stringify(fm['allowed-tools'])}`);
  console.log(`Path:        ${data.path ?? ''}`);
}

function printSkillAdd(result: Record<string, unknown>): void {
  const installed = result.installed as Array<Record<string, unknown>> | undefined;
  if (installed && installed.length > 0) {
    console.log(`\u2713 Installed ${installed.length} skill(s):`);
    for (const s of installed) {
      console.log(`  - ${s.folderName} — ${s.description ?? ''}`);
    }
    if (result.sourceUrl) console.log(`\nSource: ${result.sourceUrl}`);
    return;
  }
  // Fall-through: preview / dry-run / error path already handled by generic branch
  console.log(`\u2713 ${result.hint ?? 'done'}`);
}

function printTaskList(tasks: Array<Record<string, unknown>>): void {
  if (!tasks || tasks.length === 0) {
    console.log('(no tasks)');
    return;
  }
  console.log(`Tasks (${tasks.length}):`);
  for (const t of tasks) {
    const status = String(t.status ?? '?');
    const mode = String(t.executionMode ?? 'once');
    const origin = String(t.dispatchOrigin ?? 'direct');
    console.log(`  ${t.id}  [${status}]  ${t.name}`);
    console.log(
      `     mode=${mode}  origin=${origin}  workspace=${t.workspaceId}  sessions=${
        Array.isArray(t.sessionIds) ? (t.sessionIds as string[]).length : 0
      }`,
    );
  }
}

function printTaskDetail(task: Record<string, unknown>): void {
  if (!task) {
    console.log('(task not found)');
    return;
  }

  // Identity + top-line state
  console.log(`Task: ${task.name ?? '(unnamed)'}`);
  console.log(`  ID:             ${task.id}`);
  const statusLine = String(task.status ?? '?');
  const updatedAt = typeof task.updatedAt === 'number' ? new Date(task.updatedAt).toISOString() : undefined;
  console.log(`  Status:         ${statusLine}${updatedAt ? ` (updated ${updatedAt})` : ''}`);
  console.log(`  Executor:       ${task.executor ?? '?'}`);
  console.log(`  Execution mode: ${task.executionMode ?? '?'}`);
  console.log(`  Dispatch:       ${task.dispatchOrigin ?? '?'}`);
  if (task.workspacePath || task.workspaceId) {
    console.log(`  Workspace:      ${task.workspacePath ?? task.workspaceId}`);
  }
  if (task.description) console.log(`  Description:    ${task.description}`);
  if (task.runMode) console.log(`  Run mode:       ${task.runMode}`);
  if (task.runtime) console.log(`  Runtime:        ${task.runtime}`);
  if (task.model) console.log(`  Model override: ${task.model}`);
  if (task.permissionMode) console.log(`  Permission:     ${task.permissionMode}`);
  if (Array.isArray(task.tags) && (task.tags as string[]).length > 0) {
    console.log(`  Tags:           ${(task.tags as string[]).join(', ')}`);
  }

  // Docs paths — the highlight of `task get`. AI consumers read these
  // files with standard Read/Edit/Write tools; there are no separate
  // `show-doc` / `write-doc` CLIs (removed v0.1.69+).
  const docs = task.docs as Record<string, string | undefined> | undefined;
  if (docs) {
    console.log('\nDocs (read/edit/write these directly — they are YOUR workspace):');
    if (docs.dir) console.log(`  Dir:            ${docs.dir}`);
    if (docs.taskMd) console.log(`  task.md:        ${docs.taskMd}`);
    if (docs.verifyMd) console.log(`  verify.md:      ${docs.verifyMd}`);
    if (docs.progressMd) console.log(`  progress.md:    ${docs.progressMd}`);
    if (docs.alignmentMd) console.log(`  alignment.md:   ${docs.alignmentMd}`);
  }

  // Schedule — only for scheduled / recurring / loop tasks
  const mode = String(task.executionMode ?? 'once');
  if (mode !== 'once') {
    console.log('\nSchedule:');
    if (task.cronExpression) {
      console.log(
        `  Cron:           ${task.cronExpression}${task.cronTimezone ? ` (${task.cronTimezone})` : ''}`,
      );
    } else if (task.intervalMinutes) {
      console.log(`  Interval:       every ${task.intervalMinutes} minute(s)`);
    } else if (task.dispatchAt) {
      const when = typeof task.dispatchAt === 'number' ? new Date(task.dispatchAt).toISOString() : String(task.dispatchAt);
      console.log(`  Dispatch at:    ${when}`);
    }
    if (task.lastExecutedAt) {
      const last = typeof task.lastExecutedAt === 'number' ? new Date(task.lastExecutedAt).toISOString() : String(task.lastExecutedAt);
      console.log(`  Last executed:  ${last}`);
    }
  }

  // End conditions — when present, they're decision-relevant
  const end = task.endConditions as Record<string, unknown> | undefined;
  if (end && (end.deadline || end.maxExecutions || end.aiCanExit === false)) {
    console.log('\nEnd conditions:');
    if (end.deadline) {
      const dl = typeof end.deadline === 'number' ? new Date(end.deadline).toISOString() : String(end.deadline);
      console.log(`  Deadline:       ${dl}`);
    }
    if (end.maxExecutions) console.log(`  Max executions: ${end.maxExecutions}`);
    if (end.aiCanExit === false) console.log(`  AI can exit:    no (must run to end conditions)`);
  }

  // Notification
  const notif = task.notification as Record<string, unknown> | undefined;
  if (notif) {
    console.log('\nNotification:');
    console.log(`  Desktop:        ${notif.desktop !== false ? 'on' : 'off'}`);
    if (notif.botChannelId) console.log(`  Bot channel:    ${notif.botChannelId}`);
  }

  // Sessions + source thought
  const sessionIds = Array.isArray(task.sessionIds) ? (task.sessionIds as string[]) : [];
  if (sessionIds.length > 0) {
    console.log(`\nSessions:         ${sessionIds.join(', ')} (${sessionIds.length} total)`);
  }

  // Recent status changes — last 5, with counter
  const hist = task.statusHistory as Array<Record<string, unknown>> | undefined;
  if (hist && hist.length > 0) {
    const last5 = hist.slice(-5);
    console.log(`\nRecent changes (${last5.length} of ${hist.length}):`);
    for (const h of last5) {
      const at = typeof h.at === 'number' ? new Date(h.at).toISOString() : String(h.at ?? '');
      const actor = String(h.actor ?? '?');
      const source = h.source ? `/${h.source}` : '';
      const from = h.from ?? '—';
      const msg = h.message ? `   "${h.message}"` : '';
      console.log(`  ${at}  ${actor}${source}  ${from} → ${h.to}${msg}`);
    }
  }

  // Footer — next-step hints so the AI / user doesn't have to guess
  console.log('\nNext steps:');
  console.log('  myagents task update-status <id> <status> [--message ...]  # transition state machine');
  console.log('  myagents task run <id>                                     # dispatch immediately');
  console.log('  myagents task rerun <id>                                   # re-arm stopped/blocked task');
  console.log('  myagents task --help                                       # full Task CLI reference');
}

function printThoughtList(thoughts: Array<Record<string, unknown>>): void {
  if (!thoughts || thoughts.length === 0) {
    console.log('(no thoughts)');
    return;
  }
  console.log(`Thoughts (${thoughts.length}):`);
  for (const t of thoughts) {
    const content = String(t.content ?? '');
    const preview = content.length > 80 ? content.slice(0, 77) + '...' : content;
    const tags = Array.isArray(t.tags) ? (t.tags as string[]) : [];
    const convCount = Array.isArray(t.convertedTaskIds)
      ? (t.convertedTaskIds as string[]).length
      : 0;
    console.log(`  ${t.id}  ${preview}`);
    if (tags.length || convCount) {
      const bits: string[] = [];
      if (tags.length) bits.push(`tags=${tags.join(',')}`);
      if (convCount) bits.push(`tasks=${convCount}`);
      console.log(`     ${bits.join('  ')}`);
    }
  }
}

function printMcpOAuth(data: Record<string, unknown>): void {
  if (!data) return;
  const id = data.id ?? '';

  // discover result
  if (data.required !== undefined) {
    console.log(`MCP: ${id}`);
    console.log(`OAuth required: ${data.required ? 'yes' : 'no'}`);
    if (data.supportsDynamicRegistration) console.log('Dynamic registration: supported (zero-config)');
    if (data.scopes) console.log(`Scopes: ${(data.scopes as string[]).join(', ')}`);
    return;
  }

  // status result
  if (data.status !== undefined) {
    const symbol = data.status === 'connected' ? '\u2713' : data.status === 'expired' ? '\u26A0' : '\u2717';
    console.log(`${symbol} ${id}: ${data.status}`);
    if (data.expiresAt) console.log(`  Expires: ${new Date(Number(data.expiresAt)).toLocaleString()}`);
    if (data.scope) console.log(`  Scope: ${data.scope}`);
    return;
  }

  // start result (authUrl present)
  if (data.authUrl) {
    console.log(`OAuth authorization URL:\n  ${data.authUrl}`);
    return;
  }

  // Generic fallback (revoke, etc.)
  console.log(`\u2713 ${id}: done`);
}

function printAgentRuntimeStatus(data: Record<string, unknown>): void {
  const entries = Object.values(data);
  if (entries.length === 0) {
    console.log('No agents running.');
    return;
  }
  for (const a of entries as Array<Record<string, unknown>>) {
    const enabled = a.enabled ? 'enabled' : 'disabled';
    console.log(`Agent: ${a.agentName} (${a.agentId}) [${enabled}]`);
    const channels = (a.channels as Array<Record<string, unknown>>) ?? [];
    if (channels.length === 0) {
      console.log('  No channels');
    } else {
      const pad = (s: string, n: number) => s.padEnd(n);
      for (const ch of channels) {
        const uptime = ch.uptimeSeconds ? `uptime: ${Math.round(Number(ch.uptimeSeconds) / 60)}m` : '';
        const err = ch.errorMessage ? `error: ${ch.errorMessage}` : '';
        console.log(`  ${pad(String(ch.channelId).slice(0, 16), 18)} ${pad(String(ch.channelType), 12)} ${pad(String(ch.status), 12)} ${uptime || err}`);
      }
    }
    console.log('');
  }
}

function formatObject(obj: Record<string, unknown> | undefined, indent = '  '): string {
  if (!obj) return `${indent}(empty)`;
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${indent}${k}: ${v.join(' ')}`;
      if (typeof v === 'object') return `${indent}${k}: ${JSON.stringify(v)}`;
      return `${indent}${k}: ${v}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(rawArgs);
  const jsonMode = !!flags.json;

  // Top-level help (no args, or bare --help)
  if (positional.length === 0) {
    console.log(TOP_HELP);
    return;
  }

  // Resolve port: --port flag overrides env
  PORT = (flags.port as string) || PORT;
  if (!PORT) {
    console.error('Error: MYAGENTS_PORT not set. This CLI runs within the MyAgents app.');
    process.exit(3);
  }
  BASE = `http://127.0.0.1:${PORT}/api/admin`;

  // Help flag for sub-commands
  if (flags.help) {
    const result = await callApi('help', { path: positional });
    printResult('help', 'help', result, jsonMode);
    return;
  }

  const group = positional[0];
  const action = positional[1] || 'list';

  // Simple commands (no subcommand)
  let result: Record<string, unknown>;
  if (group === 'status') {
    result = await callApi('status');
    printResult('status', 'status', result, jsonMode);
  } else if (group === 'reload') {
    result = await callApi('reload', { workspacePath: flags.workspacePath });
    printResult('reload', 'reload', result, jsonMode);
  } else if (group === 'version') {
    result = await callApi('version');
    printResult('version', 'version', result, jsonMode);
  } else {
    // Build request body based on group/action
    const restArgs = positional.slice(2);
    const body = buildRequestBody(group, action, restArgs, flags);
    const route = buildRoute(group, action, restArgs);
    result = await callApi(route, body);
    printResult(group, action, result, jsonMode);
  }

  // Exit with proper code: 0 = success, 1 = business error
  if (result && !result.success) process.exit(1);
}

function buildRoute(group: string, action: string, rest: string[]): string {
  // Handle nested commands like "agent channel list/add/remove"
  if (group === 'agent' && action === 'channel') {
    const channelAction = rest[0] || 'list';
    return `agent/channel/${channelAction}`;
  }
  // Agent runtime status
  if (group === 'agent' && action === 'runtime-status') {
    return 'agent/runtime-status';
  }
  // MCP OAuth subcommands: mcp oauth discover/start/status/revoke
  if (group === 'mcp' && action === 'oauth') {
    const oauthAction = rest[0] || 'status';
    return `mcp/oauth/${oauthAction}`;
  }
  // Tool readmes: `myagents cron readme`, `myagents im readme`, `myagents widget ...`
  if (action === 'readme' && (group === 'cron' || group === 'im' || group === 'widget')) {
    return `readme/${group}`;
  }
  // `widget` only exists for readme lookup — any form of invocation
  // (`myagents widget`, `myagents widget chart`, `myagents widget readme chart`)
  // routes to the same handler. The handler parses modules from the payload.
  if (group === 'widget') {
    return 'readme/widget';
  }
  return `${group}/${action}`;
}

function buildRequestBody(
  group: string,
  action: string,
  rest: string[],
  flags: Record<string, unknown>,
): Record<string, unknown> {
  // MCP commands
  if (group === 'mcp') {
    if (action === 'add') {
      return {
        server: {
          id: flags.id,
          name: flags.name,
          type: flags.type || 'stdio',
          command: flags.command,
          args: flags.args,
          url: flags.url,
          env: parseEnvFlags(flags.env as string[] | undefined),
          headers: parseEnvFlags(flags.headers as string[] | undefined),
          description: flags.description,
        },
        dryRun: flags.dryRun,
      };
    }
    if (action === 'remove' || action === 'enable' || action === 'disable' || action === 'test') {
      return { id: rest[0] || flags.id, scope: flags.scope };
    }
    if (action === 'oauth') {
      const oauthAction = rest[0] || 'status'; // discover | start | status | revoke
      const serverId = rest[1] || (flags.id as string);
      if (!serverId) return { id: undefined }; // will trigger missing field error
      if (oauthAction === 'start') {
        return {
          id: serverId,
          clientId: flags.clientId,
          clientSecret: flags.clientSecret,
          scopes: flags.scopes,
          callbackPort: flags.callbackPort ? Number(flags.callbackPort) : undefined,
        };
      }
      return { id: serverId };
    }
    if (action === 'env') {
      const serverId = rest[0];
      const subAction = rest[1]; // set | get | delete
      const envPairs = rest.slice(2);
      // For 'delete', bare keys (no =value) are valid — convert to KEY=1 for parseEnvFlags
      const envInput = subAction === 'delete'
        ? envPairs.map(k => k.includes('=') ? k : `${k}=`)
        : envPairs;
      return {
        id: serverId,
        action: subAction,
        env: parseEnvFlags(envInput.length > 0 ? envInput : flags.env as string[] | undefined),
      };
    }
    return {};
  }

  // Model commands
  if (group === 'model') {
    if (action === 'set-key') return { id: rest[0] || flags.id, apiKey: rest[1] || flags.apiKey };
    if (action === 'verify') return { id: rest[0] || flags.id, model: flags.model };
    if (action === 'set-default') return { id: rest[0] || flags.id };
    if (action === 'add') {
      // Structure the provider object from flags
      const provider: Record<string, unknown> = {
        id: flags.id,
        name: flags.name,
        baseUrl: flags.baseUrl,
        models: flags.models,           // array (repeatable)
        modelNames: flags.modelNames,   // array (repeatable)
        modelSeries: flags.modelSeries,
        primaryModel: flags.primaryModel,
        authType: flags.authType,
        apiProtocol: flags.protocol,    // --protocol maps to apiProtocol
        upstreamFormat: flags.upstreamFormat,
        maxOutputTokens: flags.maxOutputTokens,
        vendor: flags.vendor,
        websiteUrl: flags.websiteUrl,
        timeout: flags.timeout,
        disableNonessential: flags.disableNonessential,
      };
      // Build aliases from --aliases sonnet=model-id,opus=model-id
      if (typeof flags.aliases === 'string') {
        const aliases: Record<string, string> = {};
        for (const pair of (flags.aliases as string).split(',')) {
          const [k, v] = pair.split('=');
          if (k && v) aliases[k.trim()] = v.trim();
        }
        provider.aliases = aliases;
      }
      return { provider, dryRun: flags.dryRun };
    }
    if (action === 'remove') return { id: rest[0] || flags.id };
    return {};
  }

  // Agent commands
  if (group === 'agent') {
    if (action === 'enable' || action === 'disable') return { id: rest[0] || flags.id };
    if (action === 'set') return { id: rest[0], key: rest[1], value: tryParseJson(rest[2]) };
    if (action === 'channel') {
      const channelAction = rest[0] || 'list'; // list | add | remove
      if (channelAction === 'list') return { agentId: rest[1] || flags.agentId };
      if (channelAction === 'add') return { agentId: rest[1] || flags.agentId, channel: stripGlobalFlags(flags) };
      if (channelAction === 'remove') return { agentId: rest[1], channelId: rest[2] };
      return { agentId: rest[1] };
    }
    return {};
  }

  // Cron commands
  if (group === 'cron') {
    if (action === 'add') {
      // Resolve prompt: --prompt-file (industry standard for long text, avoids
      // shell escape hell for multiline / quoted / backtick content) takes
      // precedence over --prompt when both are set.
      let promptText = flags.prompt as string | undefined;
      if (flags.promptFile && typeof flags.promptFile === 'string') {
        try {
          // Lazy load — keep CLI startup fast for non-cron commands.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = require('fs') as typeof import('fs');
          // Size guard: 1 MB is already pathologically large for a cron prompt
          // (~250k English words). Refuse /dev/zero, runaway files, binaries
          // disguised as text, etc., with a clear error instead of blocking
          // the CLI or flooding Admin API.
          const MAX_PROMPT_BYTES = 1024 * 1024;
          const stat = fs.statSync(flags.promptFile);
          if (stat.size > MAX_PROMPT_BYTES) {
            console.error(`Error: --prompt-file "${flags.promptFile}" is ${stat.size} bytes, exceeds ${MAX_PROMPT_BYTES} (1 MB) limit`);
            process.exit(1);
          }
          const raw = fs.readFileSync(flags.promptFile, 'utf-8');
          // NUL-byte guard: a prompt with embedded NULs is almost certainly a
          // binary file being passed in by mistake, and most downstream JSON
          // serialisation / log processing chokes on them. Refuse explicitly.
          if (raw.includes('\0')) {
            console.error(`Error: --prompt-file "${flags.promptFile}" contains NUL bytes (is this a binary file?)`);
            process.exit(1);
          }
          promptText = raw;
        } catch (err) {
          console.error(`Error: failed to read --prompt-file "${flags.promptFile}": ${err instanceof Error ? err.message : String(err)}`);
          // exit(1) matches the existing CLI convention: 1 = business error,
          // 3 = can't connect to Sidecar. Anything CLI-local falls under 1.
          process.exit(1);
        }
      }
      return {
        name: flags.name,
        message: promptText,
        workspacePath: flags.workspace,
        schedule: flags.schedule ? { kind: 'cron', expr: flags.schedule } : undefined,
        intervalMinutes: flags.every ? Number(flags.every) : undefined,
      };
    }
    if (action === 'exit') {
      return { reason: flags.reason || rest[0] };
    }
    if (action === 'readme') {
      return {}; // no body
    }
    if (action === 'start' || action === 'stop' || action === 'remove') {
      return { taskId: rest[0] || flags.id };
    }
    if (action === 'update') {
      // Map CLI flags to Rust field names expected by update_task_fields
      const patch: Record<string, unknown> = {};
      if (flags.name !== undefined) patch.name = flags.name;
      if (flags.prompt !== undefined) patch.prompt = flags.prompt;
      if (flags.schedule !== undefined) patch.schedule = { kind: 'cron', expr: flags.schedule };
      if (flags.every !== undefined) patch.intervalMinutes = Number(flags.every);
      if (flags.model !== undefined) patch.model = flags.model;
      if (flags.permissionMode !== undefined) patch.permissionMode = flags.permissionMode;
      return { taskId: rest[0] || flags.id, patch };
    }
    if (action === 'runs') {
      return { taskId: rest[0] || flags.id, limit: flags.limit ? Number(flags.limit) : undefined };
    }
    if (action === 'list' || action === 'status') {
      return { workspacePath: flags.workspace };
    }
    return {};
  }

  // IM runtime commands — session-scoped, only work inside an IM Bot session
  if (group === 'im') {
    if (action === 'send-media') {
      return {
        filePath: (flags.file as string) || rest[0],
        caption: flags.caption,
      };
    }
    if (action === 'readme') {
      return {};
    }
    return {};
  }

  // Generative UI widget readme. Accept any of:
  //   myagents widget                         → action='list',    rest=[]           → modules=[]
  //   myagents widget readme                  → action='readme',  rest=[]           → modules=[]
  //   myagents widget readme chart            → action='readme',  rest=['chart']    → modules=['chart']
  //   myagents widget readme chart interactive → rest=['chart','interactive']       → modules=['chart','interactive']
  //   myagents widget chart                   → action='chart',   rest=[]           → modules=['chart']
  //   myagents widget chart interactive       → action='chart',   rest=['interactive'] → modules=['chart','interactive']
  // Modules = positional args AFTER `widget`, minus any leading `readme`/`list` keyword.
  if (group === 'widget') {
    const candidates = [action, ...rest].filter(Boolean);
    const modules = candidates[0] === 'readme' || candidates[0] === 'list'
      ? candidates.slice(1)
      : candidates;
    return { modules };
  }

  // Plugin commands
  if (group === 'plugin') {
    if (action === 'install') return { npmSpec: rest[0] || flags.npmSpec };
    if (action === 'remove') return { pluginId: rest[0] || flags.pluginId };
    return {};
  }

  // Skill commands
  if (group === 'skill') {
    if (action === 'add') {
      return {
        url: rest[0] || flags.url,
        scope: (flags.scope as string) || 'user',
        plugin: flags.plugin,
        skill: flags.skill,
        force: !!flags.force,
        dryRun: !!flags.dryRun,
      };
    }
    if (action === 'remove' || action === 'info' || action === 'enable' || action === 'disable') {
      return { name: rest[0] || flags.name, scope: (flags.scope as string) || 'user' };
    }
    if (action === 'list' || action === 'sync') {
      return {};
    }
    return {};
  }

  // Config commands
  if (group === 'config') {
    if (action === 'get') return { key: rest[0] || flags.key };
    if (action === 'set') return { key: rest[0] || flags.key, value: tryParseJson(rest[1] ?? String(flags.value ?? '')), dryRun: flags.dryRun };
    return {};
  }

  // Task Center (v0.1.69) — covers all `myagents task <action>` subcommands.
  //
  // The `actor` / `source` trust fields are NOT settable via the CLI; the
  // admin-api handler derives them from the calling process environment
  // (MYAGENTS_PORT present → agent subprocess; otherwise user terminal).
  if (group === 'task') {
    if (action === 'list') {
      return {
        workspaceId: flags.workspaceId,
        status: flags.status,
        tag: flags.tag,
        includeDeleted: flags.includeDeleted,
      };
    }
    if (action === 'get') return { id: rest[0] || flags.id };
    if (action === 'update-status') {
      return {
        id: rest[0],
        status: rest[1],
        message: flags.message,
      };
    }
    if (action === 'append-session') {
      return { id: rest[0], sessionId: rest[1] || flags.sessionId };
    }
    if (action === 'archive') return { id: rest[0], message: flags.message };
    if (action === 'delete') return { id: rest[0] };
    if (action === 'create-direct') {
      return {
        name: rest[0] || flags.name,
        executor: flags.executor ?? 'agent',
        description: flags.description,
        workspaceId: flags.workspaceId,
        workspacePath: flags.workspacePath,
        taskMdContent: flags.taskMdContent ?? rest.slice(1).join(' '),
        executionMode: flags.executionMode ?? 'once',
        runMode: flags.runMode,
        sourceThoughtId: flags.sourceThoughtId,
        tags: typeof flags.tags === 'string'
          ? (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean)
          : undefined,
      };
    }
    if (action === 'create-from-alignment') {
      // First positional MUST be the alignmentSessionId. Use --name for the
      // task title (to avoid ambiguity when the user writes a task name that
      // happens to parse as a sessionId). An empty alignmentSessionId will be
      // rejected by the Rust layer's `validate_safe_id`.
      return {
        name: flags.name,
        executor: flags.executor ?? 'agent',
        description: flags.description,
        workspaceId: flags.workspaceId,
        workspacePath: flags.workspacePath,
        alignmentSessionId: flags.alignmentSessionId ?? rest[0],
        executionMode: flags.executionMode ?? 'once',
        runMode: flags.runMode,
        sourceThoughtId: flags.sourceThoughtId,
        tags: typeof flags.tags === 'string'
          ? (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean)
          : undefined,
      };
    }
    if (action === 'run' || action === 'rerun') {
      return { id: rest[0] || flags.id };
    }
    return {};
  }

  // Thought (v0.1.69) — `myagents thought <list|create>`
  if (group === 'thought') {
    if (action === 'list') {
      return {
        tag: flags.tag,
        query: flags.query,
        limit: flags.limit ? Number(flags.limit) : undefined,
      };
    }
    if (action === 'create') {
      return {
        content: rest.join(' ') || flags.content,
      };
    }
    return {};
  }

  return flags;
}

/** Parse KEY=VALUE pairs from --env flags */
function parseEnvFlags(envPairs: string[] | undefined): Record<string, string> | undefined {
  if (!envPairs || envPairs.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const pair of envPairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Strip CLI-global flags that should not be persisted into config data */
function stripGlobalFlags(flags: Record<string, unknown>): Record<string, unknown> {
  const globalKeys = new Set(['json', 'dryRun', 'help', 'port', 'workspacePath']);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (!globalKeys.has(k)) result[k] = v;
  }
  return result;
}

/** Try to parse a string as JSON, otherwise return as-is */
function tryParseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main().catch(err => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
