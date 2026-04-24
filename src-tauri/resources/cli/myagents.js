#!/usr/bin/env bun
#!/usr/bin/env node
"use strict";

// src/cli/myagents.ts
var PORT = process.env.MYAGENTS_PORT ?? "";
var BASE = "";
var rawArgs = process.argv.slice(2);
function parseArgs(args) {
  const positional = [];
  const flags = {};
  const repeatable = /* @__PURE__ */ new Set(["args", "env", "headers", "models", "model-names"]);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const raw = arg.slice(2);
      const eq = raw.indexOf("=");
      const key = eq >= 0 ? raw.slice(0, eq) : raw;
      const inlineValue = eq >= 0 ? raw.slice(eq + 1) : void 0;
      if (key === "help" || key === "json" || key === "dry-run" || key === "disable-nonessential") {
        flags[camelCase(key)] = true;
        i++;
        continue;
      }
      if (repeatable.has(key)) {
        const cKey = camelCase(key);
        const arr = flags[cKey] || [];
        if (inlineValue !== void 0) {
          arr.push(inlineValue);
          flags[cKey] = arr;
          i++;
          continue;
        }
        const value2 = args[i + 1];
        if (value2 === void 0) {
          if (!flags[cKey]) flags[cKey] = [];
          i++;
          continue;
        }
        arr.push(value2);
        flags[cKey] = arr;
        i += 2;
        continue;
      }
      if (inlineValue !== void 0) {
        flags[camelCase(key)] = inlineValue;
        i++;
        continue;
      }
      const value = args[i + 1];
      if (value === void 0 || value.startsWith("--")) {
        flags[camelCase(key)] = true;
        i++;
        continue;
      }
      flags[camelCase(key)] = value;
      i += 2;
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}
function assertStringFlag(value, flagName) {
  if (value === true) {
    console.error(`Error: --${flagName} requires a value (e.g. --${flagName} foo or --${flagName}=foo)`);
    process.exit(2);
  }
}
function camelCase(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
var TOP_HELP = `myagents \u2014 MyAgents Self-Configuration CLI

Usage: myagents <command> [options]

Commands:
  mcp       Manage MCP tool servers
  model     Manage model providers
  agent     Manage agents & channels (+ 'agent show <id>' for effective defaults)
  runtime   Inspect Agent Runtimes (list installed + describe models/modes)
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
  myagents mcp show playwright
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
  myagents runtime list                       # see installed runtimes + install hints
  myagents runtime describe codex             # models + permission modes
  myagents agent show <agent-id>              # effective defaults for a workspace
  myagents task list
  myagents task get <taskId>            # returns metadata + docs paths
                                        # (task.md / verify.md / progress.md /
                                        #  alignment.md \u2014 read/edit them with
                                        #  standard Read/Edit/Write tools)
  myagents task update-status <taskId> running --message "starting work"
  myagents task update-status <taskId> verifying
  myagents task update-status <taskId> done --message "bundle size dropped 40%"
  myagents task append-session <taskId> <sessionId>
  myagents task run <taskId>
  myagents task rerun <taskId>
  myagents task create-direct --name "review PR" \\
      --workspaceId proj --workspacePath /path/to/proj \\
      --taskMdContent "Review this PR and file findings in progress.md" \\
      --runtime codex --model gpt-5.2 --permissionMode full-auto
    # Per-task runtime/model/permissionMode overrides \u2014 consult
    #   myagents runtime list  +  myagents runtime describe <runtime>
    # before choosing values. Omit any flag to inherit the agent workspace default.
  myagents task create-from-alignment <alignmentSessionId> --name "\u65B0\u4EFB\u52A1"
    # Backend auto-inherits workspaceId / workspacePath / sourceThoughtId
    # from the alignment session's metadata (set when \u300CAI \u8BA8\u8BBA\u300D launched).
    # Pass --run to dispatch immediately in the same call.
    # Pass --json for machine-readable output (task_id + docs_path).
    # Same per-task override flags as create-direct apply here.
  myagents thought list
  myagents plugin list
  myagents version
  myagents reload

Run 'myagents <command> --help' for details on a specific command.`;
async function callApi(route, body = {}) {
  try {
    const resp = await fetch(`${BASE}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = await resp.text();
      return {
        success: false,
        error: text.trim() || `HTTP ${resp.status} ${resp.statusText}`
      };
    }
    return await resp.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      console.error("Error: Cannot connect to MyAgents. Is the app running?");
      process.exit(3);
    }
    throw err;
  }
}
function printResult(group, action, result, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.success) {
    console.error(`Error: ${result.error}`);
    const hint2 = result.recoveryHint;
    if (hint2 && typeof hint2 === "object") {
      if (hint2.recoveryCommand) {
        const suffix = hint2.message ? `   ${hint2.message}` : "";
        console.error(`  \u2192 Run: ${hint2.recoveryCommand}${suffix}`);
      } else if (hint2.message) {
        console.error(`  ${hint2.message}`);
      }
    }
    return;
  }
  if (result.dryRun) {
    console.log("[DRY RUN] Would apply:");
    console.log(formatObject(result.preview));
    console.log("\nRun without --dry-run to apply.");
    return;
  }
  if (group === "mcp" && action === "list") {
    printMcpList(result.data);
    return;
  }
  if (group === "mcp" && action === "show") {
    printMcpShow(result.data);
    return;
  }
  if (group === "model" && action === "list") {
    printModelList(result.data);
    return;
  }
  if (group === "agent" && action === "list") {
    printAgentList(result.data);
    return;
  }
  if (group === "cron" && action === "list") {
    printCronList(result.data);
    return;
  }
  if (group === "cron" && action === "runs") {
    printCronRuns(result.data);
    return;
  }
  if (group === "cron" && action === "status") {
    printCronStatus(result.data);
    return;
  }
  if (group === "plugin" && action === "list") {
    printPluginList(result.data);
    return;
  }
  if (group === "task" && action === "list") {
    printTaskList(result.data);
    return;
  }
  if (group === "task" && action === "get") {
    printTaskDetail(result.data);
    return;
  }
  if (group === "thought" && action === "list") {
    printThoughtList(result.data);
    return;
  }
  if (group === "skill" && action === "list") {
    printSkillList(result.data);
    return;
  }
  if (group === "skill" && action === "info") {
    printSkillInfo(result.data);
    return;
  }
  if (group === "skill" && action === "add") {
    printSkillAdd(result);
    return;
  }
  if (group === "mcp" && action === "oauth") {
    printMcpOAuth(result.data);
    return;
  }
  if (group === "version") {
    console.log(result.data?.version ?? "Unknown");
    return;
  }
  if (group === "agent" && action === "runtime-status") {
    printAgentRuntimeStatus(result.data);
    return;
  }
  if (group === "agent" && action === "show") {
    printAgentShow(result.data);
    return;
  }
  if (group === "runtime" && action === "list") {
    printRuntimeList(result.data);
    return;
  }
  if (group === "runtime" && action === "describe") {
    printRuntimeDescribe(result.data);
    return;
  }
  if (group === "status") {
    printStatus(result.data);
    return;
  }
  if (group === "help") {
    console.log(result.data?.text ?? "");
    return;
  }
  if (action === "readme" || group === "widget") {
    console.log(result.data?.text ?? "");
    return;
  }
  if (group === "task" && (action === "create-direct" || action === "create-from-alignment")) {
    printTaskCreateResult(result.data);
    return;
  }
  if (group === "task" && (action === "run" || action === "rerun")) {
    printTaskDispatchResult(action, result.data);
    return;
  }
  const symbol = "\u2713";
  const hint = result.hint ? ` ${result.hint}` : "";
  const id = result.data?.id ?? "";
  console.log(`${symbol} ${action} ${id}${hint}`);
}
function printTaskCreateResult(data) {
  const task = data?.task ?? data;
  const id = String(task?.id ?? "");
  const name = String(task?.name ?? "");
  const home = process.env.HOME ?? "";
  const absDocs = `${home}/.myagents/tasks/${id}/`;
  const displayDocs = home && absDocs.startsWith(home) ? `~${absDocs.slice(home.length)}` : absDocs;
  console.log("\u2713 Task created");
  if (id) console.log(`  task_id:   ${id}`);
  if (name) console.log(`  name:      ${name}`);
  console.log(`  docs_path: ${displayDocs}`);
  const overridden = data?.overridden ?? [];
  const overridesRequested = data?.overridesRequested ?? [];
  const overrides = data?.overrides ?? {};
  if (overridden.length > 0) {
    console.log(`  overrides: ${overridden.join(", ")}`);
    for (const field of overridden) {
      const v = overrides[field];
      if (v !== null && v !== void 0 && v !== "") {
        const display = typeof v === "object" ? JSON.stringify(v) : String(v);
        console.log(`    ${field.padEnd(14)} = ${display}`);
      }
    }
  } else {
    console.log("  overrides: (none \u2014 inherits workspace defaults)");
  }
  const droppedFields = overridesRequested.filter((f) => !overridden.includes(f));
  if (droppedFields.length > 0) {
    console.log("");
    console.log(`  \u26A0 warning: requested overrides were NOT persisted: ${droppedFields.join(", ")}`);
    console.log("    This likely indicates a server-side deserialization gap \u2014 please report.");
  }
  const nextSteps = data?.nextSteps;
  const dispatch = nextSteps?.dispatch ?? (id ? `myagents task run ${id}` : "");
  if (dispatch) console.log(`  next:      ${dispatch}`);
  const runResult = data?.runResult;
  if (runResult) {
    console.log("");
    printTaskDispatchResult("run", runResult);
  }
}
function printRuntimeList(rows) {
  if (!rows || rows.length === 0) {
    console.log("No runtimes found.");
    return;
  }
  const pad = (s, n) => s.padEnd(n);
  console.log(pad("RUNTIME", 14) + pad("INSTALLED", 11) + pad("VERSION", 18) + "NAME");
  for (const row of rows) {
    const rt = String(row.runtime ?? "");
    const installed = row.installed ? "yes" : "no";
    const version = String(row.version ?? "").split("\n")[0].slice(0, 16) || "-";
    console.log(pad(rt, 14) + pad(installed, 11) + pad(version, 18) + String(row.displayName ?? ""));
    const hint = row.notInstalledHint;
    if (hint) console.log(`    \u2192 ${String(hint)}`);
  }
  console.log("");
  console.log("Describe a runtime:  myagents runtime describe <runtime>");
}
function printRuntimeDescribe(data) {
  const runtime = String(data.runtime ?? "");
  const name = String(data.displayName ?? runtime);
  const installed = data.installed ? "yes" : "no";
  const version = data.version ? ` (${String(data.version).split("\n")[0]})` : "";
  console.log(`${name}  [${runtime}]`);
  console.log(`  installed: ${installed}${version}`);
  const defaultMode = String(data.defaultPermissionMode ?? "");
  if (defaultMode) console.log(`  default permissionMode: ${defaultMode}`);
  const models = data.models ?? [];
  console.log("");
  console.log("Models:");
  if (models.length === 0) {
    console.log("  (none reported \u2014 runtime may not be installed, or has no static model list)");
  } else {
    for (const m of models) {
      const value = String(m.value ?? "");
      const display = String(m.displayName ?? "");
      const mark = m.isDefault ? " *" : "";
      console.log(`  ${value.padEnd(28) || "(default)"}  ${display}${mark}`);
    }
  }
  const modes = data.permissionModes ?? [];
  console.log("");
  console.log("Permission modes:");
  if (modes.length === 0) {
    console.log("  (runtime uses the built-in PermissionMode enum; set via --permissionMode)");
  } else {
    for (const mode of modes) {
      const value = String(mode.value ?? "");
      const label = String(mode.label ?? "");
      const desc = String(mode.description ?? "");
      console.log(`  ${value.padEnd(22)} ${label}${desc ? "  \u2014  " + desc : ""}`);
    }
  }
  const note = data.note;
  if (note) {
    console.log("");
    console.log(`Note: ${String(note)}`);
  }
}
function printAgentShow(data) {
  if (!data) {
    console.log("No agent data.");
    return;
  }
  console.log(`Agent:       ${String(data.name ?? "")}`);
  console.log(`  id:        ${String(data.id ?? "")}`);
  console.log(`  enabled:   ${data.enabled ? "yes" : "no"}`);
  if (data.workspacePath) console.log(`  workspace: ${String(data.workspacePath)}`);
  const channelCount = data.channelCount;
  if (typeof channelCount === "number") console.log(`  channels:  ${channelCount}`);
  console.log("");
  console.log("Effective defaults:");
  const defaults = data.effectiveDefaults ?? {};
  const fmt = (v) => {
    if (v === null || v === void 0 || v === "") return "(inherits default)";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };
  console.log(`  runtime:        ${fmt(defaults.runtime)}`);
  console.log(`  model:          ${fmt(defaults.model)}`);
  console.log(`  permissionMode: ${fmt(defaults.permissionMode)}`);
  console.log(`  providerId:     ${fmt(defaults.providerId)}`);
  if (defaults.runtimeConfig) {
    console.log(`  runtimeConfig:  ${JSON.stringify(defaults.runtimeConfig)}`);
  }
  console.log("");
  console.log("Describe this runtime:  myagents runtime describe <runtime>");
}
function printTaskDispatchResult(action, data) {
  const task = data?.task ?? data;
  const id = String(task?.id ?? "");
  const runtime = task?.runtime || "builtin";
  const model = task?.model || "(agent default)";
  console.log(`\u2713 Task ${action === "rerun" ? "redispatched" : "dispatched"}`);
  if (id) console.log(`  task_id:  ${id}`);
  console.log(`  runtime:  ${runtime}`);
  console.log(`  model:    ${model}`);
}
function printMcpList(servers) {
  if (!servers || servers.length === 0) {
    console.log("No MCP servers configured.");
    return;
  }
  const pad = (s, n) => s.padEnd(n);
  console.log(pad("ID", 24) + pad("Type", 8) + pad("Status", 10) + "Name");
  for (const s of servers) {
    const status = s.enabled ? "enabled" : "disabled";
    const builtin = s.isBuiltin ? " (built-in)" : "";
    console.log(pad(String(s.id), 24) + pad(String(s.type), 8) + pad(status, 10) + String(s.name) + builtin);
  }
  const enabled = servers.filter((s) => s.enabled).length;
  console.log(`
${servers.length} MCP servers (${enabled} enabled)`);
}
function printMcpShow(data) {
  if (!data) {
    console.log("No MCP data.");
    return;
  }
  console.log(`MCP Server:   ${String(data.name ?? "")}`);
  console.log(`  id:         ${String(data.id ?? "")}`);
  console.log(`  type:       ${String(data.type ?? "")}`);
  if (data.description) console.log(`  description:${String(data.description)}`);
  console.log(`  built-in:   ${data.isBuiltin ? "yes" : "no"}`);
  const enabled = data.enabled ?? {};
  const globalState = enabled.global ? "enabled" : "disabled";
  const projectState = enabled.project === null || enabled.project === void 0 ? "(no active workspace)" : enabled.project ? "enabled" : "disabled";
  console.log("");
  console.log("Enable state:");
  console.log(`  global:     ${globalState}`);
  console.log(`  project:    ${projectState}`);
  if (data.workspacePath) console.log(`  workspace:  ${String(data.workspacePath)}`);
  console.log("");
  console.log("Transport:");
  if (data.command) console.log(`  command:    ${String(data.command)}`);
  if (Array.isArray(data.args) && data.args.length > 0) {
    console.log(`  args:       ${data.args.map(String).join(" ")}`);
  }
  if (data.url) console.log(`  url:        ${String(data.url)}`);
  const env = data.env;
  if (env && Object.keys(env).length > 0) {
    console.log("");
    console.log("Env (values redacted):");
    for (const [k, v] of Object.entries(env)) {
      console.log(`  ${k} = ${v}`);
    }
  }
  const headers = data.headers;
  if (headers && Object.keys(headers).length > 0) {
    console.log("");
    console.log("Headers (values redacted):");
    for (const [k, v] of Object.entries(headers)) {
      console.log(`  ${k} = ${v}`);
    }
  }
  if (data.requiresConfig) {
    console.log("");
    console.log("Note: this server requires configuration before it can be enabled.");
    if (data.websiteUrl) console.log(`  See: ${String(data.websiteUrl)}`);
  }
}
function printModelList(providers) {
  if (!providers || providers.length === 0) {
    console.log("No model providers configured.");
    return;
  }
  const pad = (s, n) => s.padEnd(n);
  console.log(pad("ID", 24) + pad("Status", 12) + "Name");
  for (const p of providers) {
    console.log(pad(String(p.id), 24) + pad(String(p.status), 12) + String(p.name));
  }
}
function printAgentList(agents) {
  if (!agents || agents.length === 0) {
    console.log("No agents configured.");
    return;
  }
  const pad = (s, n) => s.padEnd(n);
  console.log(pad("ID", 38) + pad("Status", 10) + pad("Channels", 10) + "Name");
  for (const a of agents) {
    const status = a.enabled ? "enabled" : "disabled";
    console.log(pad(String(a.id).slice(0, 36), 38) + pad(status, 10) + pad(String(a.channelCount), 10) + String(a.name));
  }
}
function printStatus(data) {
  const mcp = data.mcpServers;
  console.log(`MCP Servers: ${mcp?.total ?? 0} total, ${mcp?.enabled ?? 0} enabled`);
  console.log(`Active MCP in session: ${data.activeMcpInSession}`);
  console.log(`Default provider: ${data.defaultProvider}`);
  console.log(`Agents: ${data.agents}`);
}
function printCronList(tasks) {
  if (!tasks || tasks.length === 0) {
    console.log("No cron tasks configured.");
    return;
  }
  const pad = (s, n) => s.padEnd(n);
  console.log(pad("ID", 24) + pad("Status", 10) + pad("Schedule", 20) + "Name");
  for (const t of tasks) {
    const schedule = t.schedule ? typeof t.schedule === "object" && t.schedule.kind === "cron" ? String(t.schedule.expr) : `Every ${t.intervalMinutes}m` : `Every ${t.intervalMinutes}m`;
    console.log(
      pad(String(t.id).slice(0, 22), 24) + pad(String(t.status), 10) + pad(schedule.slice(0, 18), 20) + String(t.name ?? t.prompt?.slice(0, 40) ?? "")
    );
  }
  const running = tasks.filter((t) => t.status === "Running" || t.status === "running").length;
  console.log(`
${tasks.length} cron tasks (${running} running)`);
}
function printCronRuns(runs) {
  if (!runs || runs.length === 0) {
    console.log("No execution records.");
    return;
  }
  const pad = (s, n) => s.padEnd(n);
  console.log(pad("Time", 22) + pad("Status", 8) + pad("Duration", 12) + "Output");
  for (const r of runs) {
    const time = r.ts ? new Date(Number(r.ts)).toLocaleString() : "?";
    const status = r.ok ? "\u2713" : "\u2717";
    const dur = r.durationMs ? `${(Number(r.durationMs) / 1e3).toFixed(1)}s` : "?";
    const output = r.ok ? String(r.content ?? "").slice(0, 50) : String(r.error ?? "").slice(0, 50);
    console.log(pad(time, 22) + pad(status, 8) + pad(dur, 12) + output);
  }
}
function printCronStatus(data) {
  console.log(`Total tasks: ${data.totalTasks ?? 0}`);
  console.log(`Running: ${data.runningTasks ?? 0}`);
  if (data.lastExecutedAt) console.log(`Last executed: ${data.lastExecutedAt}`);
  if (data.nextExecutionAt) console.log(`Next execution: ${data.nextExecutionAt}`);
}
function printPluginList(plugins) {
  if (!plugins || plugins.length === 0) {
    console.log("No plugins installed.");
    return;
  }
  const pad = (s, n) => s.padEnd(n);
  console.log(pad("ID", 30) + pad("Version", 12) + "Name");
  for (const p of plugins) {
    console.log(
      pad(String(p.name ?? p.id ?? "?"), 30) + pad(String(p.version ?? "?"), 12) + String(p.description ?? "")
    );
  }
  console.log(`
${plugins.length} plugins installed`);
}
function printSkillList(skills) {
  if (!skills || skills.length === 0) {
    console.log("No skills installed.");
    return;
  }
  const pad = (s, n) => s.padEnd(n);
  console.log(pad("Folder", 28) + pad("Scope", 10) + pad("Enabled", 10) + "Description");
  for (const s of skills) {
    const enabled = s.enabled === false ? "off" : "on";
    const desc = String(s.description ?? "").slice(0, 60);
    console.log(
      pad(String(s.folderName ?? s.name ?? "?").slice(0, 26), 28) + pad(String(s.scope ?? "user"), 10) + pad(enabled, 10) + desc
    );
  }
  console.log(`
${skills.length} skill(s)`);
}
function printSkillInfo(data) {
  if (!data) {
    console.log("Skill not found.");
    return;
  }
  const fm = data.frontmatter || {};
  console.log(`Name:        ${fm.name ?? data.name ?? "?"}`);
  console.log(`Folder:      ${data.folderName ?? "?"}`);
  console.log(`Scope:       ${data.scope ?? "user"}`);
  console.log(`Description: ${fm.description ?? ""}`);
  if (fm.author) console.log(`Author:      ${fm.author}`);
  if (fm["allowed-tools"]) console.log(`Allowed:     ${JSON.stringify(fm["allowed-tools"])}`);
  console.log(`Path:        ${data.path ?? ""}`);
}
function printSkillAdd(result) {
  const installed = result.installed;
  if (installed && installed.length > 0) {
    console.log(`\u2713 Installed ${installed.length} skill(s):`);
    for (const s of installed) {
      console.log(`  - ${s.folderName} \u2014 ${s.description ?? ""}`);
    }
    if (result.sourceUrl) console.log(`
Source: ${result.sourceUrl}`);
    return;
  }
  console.log(`\u2713 ${result.hint ?? "done"}`);
}
function printTaskList(tasks) {
  if (!tasks || tasks.length === 0) {
    console.log("(no tasks)");
    return;
  }
  console.log(`Tasks (${tasks.length}):`);
  for (const t of tasks) {
    const status = String(t.status ?? "?");
    const mode = String(t.executionMode ?? "once");
    const origin = String(t.dispatchOrigin ?? "direct");
    console.log(`  ${t.id}  [${status}]  ${t.name}`);
    console.log(
      `     mode=${mode}  origin=${origin}  workspace=${t.workspaceId}  sessions=${Array.isArray(t.sessionIds) ? t.sessionIds.length : 0}`
    );
  }
}
function printTaskDetail(task) {
  if (!task) {
    console.log("(task not found)");
    return;
  }
  console.log(`Task: ${task.name ?? "(unnamed)"}`);
  console.log(`  ID:             ${task.id}`);
  const statusLine = String(task.status ?? "?");
  const updatedAt = typeof task.updatedAt === "number" ? new Date(task.updatedAt).toISOString() : void 0;
  console.log(`  Status:         ${statusLine}${updatedAt ? ` (updated ${updatedAt})` : ""}`);
  console.log(`  Executor:       ${task.executor ?? "?"}`);
  console.log(`  Execution mode: ${task.executionMode ?? "?"}`);
  console.log(`  Dispatch:       ${task.dispatchOrigin ?? "?"}`);
  if (task.workspacePath || task.workspaceId) {
    console.log(`  Workspace:      ${task.workspacePath ?? task.workspaceId}`);
  }
  if (task.description) console.log(`  Description:    ${task.description}`);
  if (task.runMode) console.log(`  Run mode:       ${task.runMode}`);
  if (task.runtime) console.log(`  Runtime:        ${task.runtime}`);
  if (task.model) console.log(`  Model override: ${task.model}`);
  if (task.permissionMode) console.log(`  Permission:     ${task.permissionMode}`);
  if (Array.isArray(task.tags) && task.tags.length > 0) {
    console.log(`  Tags:           ${task.tags.join(", ")}`);
  }
  const docs = task.docs;
  if (docs) {
    console.log("\nDocs (read/edit/write these directly \u2014 they are YOUR workspace):");
    if (docs.dir) console.log(`  Dir:            ${docs.dir}`);
    if (docs.taskMd) console.log(`  task.md:        ${docs.taskMd}`);
    if (docs.verifyMd) console.log(`  verify.md:      ${docs.verifyMd}`);
    if (docs.progressMd) console.log(`  progress.md:    ${docs.progressMd}`);
    if (docs.alignmentMd) console.log(`  alignment.md:   ${docs.alignmentMd}`);
  }
  const mode = String(task.executionMode ?? "once");
  if (mode !== "once") {
    console.log("\nSchedule:");
    if (task.cronExpression) {
      console.log(
        `  Cron:           ${task.cronExpression}${task.cronTimezone ? ` (${task.cronTimezone})` : ""}`
      );
    } else if (task.intervalMinutes) {
      console.log(`  Interval:       every ${task.intervalMinutes} minute(s)`);
    } else if (task.dispatchAt) {
      const when = typeof task.dispatchAt === "number" ? new Date(task.dispatchAt).toISOString() : String(task.dispatchAt);
      console.log(`  Dispatch at:    ${when}`);
    }
    if (task.lastExecutedAt) {
      const last = typeof task.lastExecutedAt === "number" ? new Date(task.lastExecutedAt).toISOString() : String(task.lastExecutedAt);
      console.log(`  Last executed:  ${last}`);
    }
  }
  const end = task.endConditions;
  if (end && (end.deadline || end.maxExecutions || end.aiCanExit === false)) {
    console.log("\nEnd conditions:");
    if (end.deadline) {
      const dl = typeof end.deadline === "number" ? new Date(end.deadline).toISOString() : String(end.deadline);
      console.log(`  Deadline:       ${dl}`);
    }
    if (end.maxExecutions) console.log(`  Max executions: ${end.maxExecutions}`);
    if (end.aiCanExit === false) console.log(`  AI can exit:    no (must run to end conditions)`);
  }
  const notif = task.notification;
  if (notif) {
    console.log("\nNotification:");
    console.log(`  Desktop:        ${notif.desktop !== false ? "on" : "off"}`);
    if (notif.botChannelId) console.log(`  Bot channel:    ${notif.botChannelId}`);
  }
  const sessionIds = Array.isArray(task.sessionIds) ? task.sessionIds : [];
  if (sessionIds.length > 0) {
    console.log(`
Sessions:         ${sessionIds.join(", ")} (${sessionIds.length} total)`);
  }
  const hist = task.statusHistory;
  if (hist && hist.length > 0) {
    const last5 = hist.slice(-5);
    console.log(`
Recent changes (${last5.length} of ${hist.length}):`);
    for (const h of last5) {
      const at = typeof h.at === "number" ? new Date(h.at).toISOString() : String(h.at ?? "");
      const actor = String(h.actor ?? "?");
      const source = h.source ? `/${h.source}` : "";
      const from = h.from ?? "\u2014";
      const msg = h.message ? `   "${h.message}"` : "";
      console.log(`  ${at}  ${actor}${source}  ${from} \u2192 ${h.to}${msg}`);
    }
  }
  console.log("\nNext steps:");
  console.log("  myagents task update-status <id> <status> [--message ...]  # transition state machine");
  console.log("  myagents task run <id>                                     # dispatch immediately");
  console.log("  myagents task rerun <id>                                   # re-arm stopped/blocked task");
  console.log("  myagents task --help                                       # full Task CLI reference");
}
function printThoughtList(thoughts) {
  if (!thoughts || thoughts.length === 0) {
    console.log("(no thoughts)");
    return;
  }
  console.log(`Thoughts (${thoughts.length}):`);
  for (const t of thoughts) {
    const content = String(t.content ?? "");
    const preview = content.length > 80 ? content.slice(0, 77) + "..." : content;
    const tags = Array.isArray(t.tags) ? t.tags : [];
    const convCount = Array.isArray(t.convertedTaskIds) ? t.convertedTaskIds.length : 0;
    console.log(`  ${t.id}  ${preview}`);
    if (tags.length || convCount) {
      const bits = [];
      if (tags.length) bits.push(`tags=${tags.join(",")}`);
      if (convCount) bits.push(`tasks=${convCount}`);
      console.log(`     ${bits.join("  ")}`);
    }
  }
}
function printMcpOAuth(data) {
  if (!data) return;
  const id = data.id ?? "";
  if (data.required !== void 0) {
    console.log(`MCP: ${id}`);
    console.log(`OAuth required: ${data.required ? "yes" : "no"}`);
    if (data.supportsDynamicRegistration) console.log("Dynamic registration: supported (zero-config)");
    if (data.scopes) console.log(`Scopes: ${data.scopes.join(", ")}`);
    return;
  }
  if (data.status !== void 0) {
    const symbol = data.status === "connected" ? "\u2713" : data.status === "expired" ? "\u26A0" : "\u2717";
    console.log(`${symbol} ${id}: ${data.status}`);
    if (data.expiresAt) console.log(`  Expires: ${new Date(Number(data.expiresAt)).toLocaleString()}`);
    if (data.scope) console.log(`  Scope: ${data.scope}`);
    return;
  }
  if (data.authUrl) {
    console.log(`OAuth authorization URL:
  ${data.authUrl}`);
    return;
  }
  console.log(`\u2713 ${id}: done`);
}
function printAgentRuntimeStatus(data) {
  const entries = Object.values(data);
  if (entries.length === 0) {
    console.log("No agents running.");
    return;
  }
  for (const a of entries) {
    const enabled = a.enabled ? "enabled" : "disabled";
    console.log(`Agent: ${a.agentName} (${a.agentId}) [${enabled}]`);
    const channels = a.channels ?? [];
    if (channels.length === 0) {
      console.log("  No channels");
    } else {
      const pad = (s, n) => s.padEnd(n);
      for (const ch of channels) {
        const uptime = ch.uptimeSeconds ? `uptime: ${Math.round(Number(ch.uptimeSeconds) / 60)}m` : "";
        const err = ch.errorMessage ? `error: ${ch.errorMessage}` : "";
        console.log(`  ${pad(String(ch.channelId).slice(0, 16), 18)} ${pad(String(ch.channelType), 12)} ${pad(String(ch.status), 12)} ${uptime || err}`);
      }
    }
    console.log("");
  }
}
function formatObject(obj, indent = "  ") {
  if (!obj) return `${indent}(empty)`;
  return Object.entries(obj).filter(([, v]) => v !== void 0 && v !== null).map(([k, v]) => {
    if (Array.isArray(v)) return `${indent}${k}: ${v.join(" ")}`;
    if (typeof v === "object") return `${indent}${k}: ${JSON.stringify(v)}`;
    return `${indent}${k}: ${v}`;
  }).join("\n");
}
async function main() {
  const { positional, flags } = parseArgs(rawArgs);
  const jsonMode = !!flags.json;
  if (positional.length === 0) {
    console.log(TOP_HELP);
    return;
  }
  PORT = flags.port || PORT;
  if (!PORT) {
    console.error("Error: MYAGENTS_PORT not set. This CLI runs within the MyAgents app.");
    process.exit(3);
  }
  BASE = `http://127.0.0.1:${PORT}/api/admin`;
  if (flags.help) {
    const result2 = await callApi("help", { path: positional });
    printResult("help", "help", result2, jsonMode);
    return;
  }
  const group = positional[0];
  const action = positional[1] || "list";
  let result;
  if (group === "status") {
    result = await callApi("status");
    printResult("status", "status", result, jsonMode);
  } else if (group === "reload") {
    result = await callApi("reload", { workspacePath: flags.workspacePath });
    printResult("reload", "reload", result, jsonMode);
  } else if (group === "version") {
    result = await callApi("version");
    printResult("version", "version", result, jsonMode);
  } else {
    const restArgs = positional.slice(2);
    const body = buildRequestBody(group, action, restArgs, flags);
    const route = buildRoute(group, action, restArgs);
    result = await callApi(route, body);
    if (group === "task" && action === "create-from-alignment" && flags.run && result.success && result.data) {
      const data = result.data;
      const task = data.task ?? data;
      const newTaskId = task?.id;
      if (newTaskId) {
        const runResult = await callApi("task/run", { id: newTaskId });
        if (!runResult.success) {
          result.success = false;
          result.error = `created ${newTaskId} but run failed: ${String(runResult.error ?? "unknown error")}`;
        } else {
          result.data.runResult = runResult.data;
        }
      }
    }
    printResult(group, action, result, jsonMode);
  }
  if (result && !result.success) process.exit(1);
}
function buildRoute(group, action, rest) {
  if (group === "agent" && action === "channel") {
    const channelAction = rest[0] || "list";
    return `agent/channel/${channelAction}`;
  }
  if (group === "agent" && action === "runtime-status") {
    return "agent/runtime-status";
  }
  if (group === "mcp" && action === "oauth") {
    const oauthAction = rest[0] || "status";
    return `mcp/oauth/${oauthAction}`;
  }
  if (action === "readme" && (group === "cron" || group === "im" || group === "widget")) {
    return `readme/${group}`;
  }
  if (group === "widget") {
    return "readme/widget";
  }
  return `${group}/${action}`;
}
function buildRequestBody(group, action, rest, flags) {
  if (group === "mcp") {
    if (action === "add") {
      return {
        server: {
          id: flags.id,
          name: flags.name,
          type: flags.type || "stdio",
          command: flags.command,
          args: flags.args,
          url: flags.url,
          env: parseEnvFlags(flags.env),
          headers: parseEnvFlags(flags.headers),
          description: flags.description
        },
        dryRun: flags.dryRun
      };
    }
    if (action === "remove" || action === "enable" || action === "disable" || action === "test") {
      return { id: rest[0] || flags.id, scope: flags.scope };
    }
    if (action === "show") {
      return { id: rest[0] || flags.id };
    }
    if (action === "oauth") {
      const oauthAction = rest[0] || "status";
      const serverId = rest[1] || flags.id;
      if (!serverId) return { id: void 0 };
      if (oauthAction === "start") {
        return {
          id: serverId,
          clientId: flags.clientId,
          clientSecret: flags.clientSecret,
          scopes: flags.scopes,
          callbackPort: flags.callbackPort ? Number(flags.callbackPort) : void 0
        };
      }
      return { id: serverId };
    }
    if (action === "env") {
      const serverId = rest[0];
      const subAction = rest[1];
      const envPairs = rest.slice(2);
      const envInput = subAction === "delete" ? envPairs.map((k) => k.includes("=") ? k : `${k}=`) : envPairs;
      return {
        id: serverId,
        action: subAction,
        env: parseEnvFlags(envInput.length > 0 ? envInput : flags.env)
      };
    }
    return {};
  }
  if (group === "model") {
    if (action === "set-key") return { id: rest[0] || flags.id, apiKey: rest[1] || flags.apiKey };
    if (action === "verify") return { id: rest[0] || flags.id, model: flags.model };
    if (action === "set-default") return { id: rest[0] || flags.id };
    if (action === "add") {
      const provider = {
        id: flags.id,
        name: flags.name,
        baseUrl: flags.baseUrl,
        models: flags.models,
        // array (repeatable)
        modelNames: flags.modelNames,
        // array (repeatable)
        modelSeries: flags.modelSeries,
        primaryModel: flags.primaryModel,
        authType: flags.authType,
        apiProtocol: flags.protocol,
        // --protocol maps to apiProtocol
        upstreamFormat: flags.upstreamFormat,
        maxOutputTokens: flags.maxOutputTokens,
        vendor: flags.vendor,
        websiteUrl: flags.websiteUrl,
        timeout: flags.timeout,
        disableNonessential: flags.disableNonessential
      };
      if (typeof flags.aliases === "string") {
        const aliases = {};
        for (const pair of flags.aliases.split(",")) {
          const [k, v] = pair.split("=");
          if (k && v) aliases[k.trim()] = v.trim();
        }
        provider.aliases = aliases;
      }
      return { provider, dryRun: flags.dryRun };
    }
    if (action === "remove") return { id: rest[0] || flags.id };
    return {};
  }
  if (group === "agent") {
    if (action === "enable" || action === "disable") return { id: rest[0] || flags.id };
    if (action === "show") return { id: rest[0] || flags.id };
    if (action === "set") return { id: rest[0], key: rest[1], value: tryParseJson(rest[2]) };
    if (action === "channel") {
      const channelAction = rest[0] || "list";
      if (channelAction === "list") return { agentId: rest[1] || flags.agentId };
      if (channelAction === "add") return { agentId: rest[1] || flags.agentId, channel: stripGlobalFlags(flags) };
      if (channelAction === "remove") return { agentId: rest[1], channelId: rest[2] };
      return { agentId: rest[1] };
    }
    return {};
  }
  if (group === "runtime") {
    if (action === "list") return {};
    if (action === "describe") return { runtime: rest[0] || flags.runtime };
    return {};
  }
  if (group === "cron") {
    if (action === "add") {
      let promptText = flags.prompt ?? flags.message;
      if (flags.promptFile && typeof flags.promptFile === "string") {
        try {
          const fs = require("fs");
          const MAX_PROMPT_BYTES = 1024 * 1024;
          const stat = fs.statSync(flags.promptFile);
          if (stat.size > MAX_PROMPT_BYTES) {
            console.error(`Error: --prompt-file "${flags.promptFile}" is ${stat.size} bytes, exceeds ${MAX_PROMPT_BYTES} (1 MB) limit`);
            process.exit(1);
          }
          const raw = fs.readFileSync(flags.promptFile, "utf-8");
          if (raw.includes("\0")) {
            console.error(`Error: --prompt-file "${flags.promptFile}" contains NUL bytes (is this a binary file?)`);
            process.exit(1);
          }
          promptText = raw;
        } catch (err) {
          console.error(`Error: failed to read --prompt-file "${flags.promptFile}": ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      }
      return {
        name: flags.name,
        message: promptText,
        workspacePath: flags.workspace,
        schedule: normalizeScheduleFlag(flags.schedule),
        intervalMinutes: flags.every ? Number(flags.every) : void 0
      };
    }
    if (action === "exit") {
      return { reason: flags.reason || rest[0] };
    }
    if (action === "readme") {
      return {};
    }
    if (action === "start" || action === "stop" || action === "remove") {
      return { taskId: rest[0] || flags.id };
    }
    if (action === "update") {
      const patch = {};
      if (flags.name !== void 0) patch.name = flags.name;
      const updatePrompt = flags.prompt ?? flags.message;
      if (updatePrompt !== void 0) patch.prompt = updatePrompt;
      if (flags.schedule !== void 0) patch.schedule = normalizeScheduleFlag(flags.schedule);
      if (flags.every !== void 0) patch.intervalMinutes = Number(flags.every);
      if (flags.model !== void 0) patch.model = flags.model;
      if (flags.permissionMode !== void 0) patch.permissionMode = flags.permissionMode;
      return { taskId: rest[0] || flags.id, patch };
    }
    if (action === "runs") {
      return { taskId: rest[0] || flags.id, limit: flags.limit ? Number(flags.limit) : void 0 };
    }
    if (action === "list" || action === "status") {
      return { workspacePath: flags.workspace };
    }
    return {};
  }
  if (group === "im") {
    if (action === "send-media") {
      return {
        filePath: flags.file || rest[0],
        caption: flags.caption
      };
    }
    if (action === "readme") {
      return {};
    }
    return {};
  }
  if (group === "widget") {
    const candidates = [action, ...rest].filter(Boolean);
    const modules = candidates[0] === "readme" || candidates[0] === "list" ? candidates.slice(1) : candidates;
    return { modules };
  }
  if (group === "plugin") {
    if (action === "install") return { npmSpec: rest[0] || flags.npmSpec };
    if (action === "remove") return { pluginId: rest[0] || flags.pluginId };
    return {};
  }
  if (group === "skill") {
    if (action === "add") {
      return {
        url: rest[0] || flags.url,
        scope: flags.scope || "user",
        plugin: flags.plugin,
        skill: flags.skill,
        force: !!flags.force,
        dryRun: !!flags.dryRun
      };
    }
    if (action === "remove" || action === "info" || action === "enable" || action === "disable") {
      return { name: rest[0] || flags.name, scope: flags.scope || "user" };
    }
    if (action === "list" || action === "sync") {
      return {};
    }
    return {};
  }
  if (group === "config") {
    if (action === "get") return { key: rest[0] || flags.key };
    if (action === "set") return { key: rest[0] || flags.key, value: tryParseJson(rest[1] ?? String(flags.value ?? "")), dryRun: flags.dryRun };
    return {};
  }
  if (group === "task") {
    if (action === "list") {
      return {
        workspaceId: flags.workspaceId,
        status: flags.status,
        tag: flags.tag,
        includeDeleted: flags.includeDeleted
      };
    }
    if (action === "get") return { id: rest[0] || flags.id };
    if (action === "update-status") {
      return {
        id: rest[0],
        status: rest[1],
        message: flags.message
      };
    }
    if (action === "append-session") {
      return { id: rest[0], sessionId: rest[1] || flags.sessionId };
    }
    if (action === "archive") return { id: rest[0], message: flags.message };
    if (action === "delete") return { id: rest[0] };
    if (action === "create-direct") {
      assertStringFlag(flags.name, "name");
      const taskMdContent = resolveTaskMdContent(flags);
      return {
        name: rest[0] || flags.name,
        executor: flags.executor ?? "agent",
        description: flags.description,
        workspaceId: flags.workspaceId,
        workspacePath: flags.workspacePath,
        taskMdContent,
        executionMode: flags.executionMode ?? "once",
        runMode: flags.runMode,
        sourceThoughtId: flags.sourceThoughtId,
        tags: typeof flags.tags === "string" ? flags.tags.split(",").map((s) => s.trim()).filter(Boolean) : void 0,
        // Per-task runtime overrides. Admin-api validates these before
        // forwarding to Rust — if the caller mistypes a value, they get a
        // recovery hint pointing to `runtime list` / `runtime describe`.
        runtime: flags.runtime,
        model: flags.model,
        permissionMode: flags.permissionMode,
        runtimeConfig: parseRuntimeConfigFlag(flags.runtimeConfig)
      };
    }
    if (action === "create-from-alignment") {
      assertStringFlag(flags.name, "name");
      return {
        name: flags.name,
        executor: flags.executor ?? "agent",
        description: flags.description,
        workspaceId: flags.workspaceId,
        workspacePath: flags.workspacePath,
        alignmentSessionId: flags.alignmentSessionId ?? rest[0],
        executionMode: flags.executionMode ?? "once",
        runMode: flags.runMode,
        sourceThoughtId: flags.sourceThoughtId,
        tags: typeof flags.tags === "string" ? flags.tags.split(",").map((s) => s.trim()).filter(Boolean) : void 0,
        // Identical override contract to create-direct above — keep these two
        // in lockstep.
        runtime: flags.runtime,
        model: flags.model,
        permissionMode: flags.permissionMode,
        runtimeConfig: parseRuntimeConfigFlag(flags.runtimeConfig)
      };
    }
    if (action === "run" || action === "rerun") {
      return { id: rest[0] || flags.id };
    }
    return {};
  }
  if (group === "thought") {
    if (action === "list") {
      return {
        tag: flags.tag,
        query: flags.query,
        limit: flags.limit ? Number(flags.limit) : void 0
      };
    }
    if (action === "create") {
      return {
        content: rest.join(" ") || flags.content
      };
    }
    return {};
  }
  return flags;
}
function parseEnvFlags(envPairs) {
  if (!envPairs || envPairs.length === 0) return void 0;
  const result = {};
  for (const pair of envPairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return Object.keys(result).length > 0 ? result : void 0;
}
function stripGlobalFlags(flags) {
  const globalKeys = /* @__PURE__ */ new Set(["json", "dryRun", "help", "port", "workspacePath"]);
  const result = {};
  for (const [k, v] of Object.entries(flags)) {
    if (!globalKeys.has(k)) result[k] = v;
  }
  return result;
}
function tryParseJson(value) {
  if (value === void 0) return void 0;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function normalizeScheduleFlag(raw) {
  if (raw === void 0 || raw === null || raw === "") return void 0;
  if (typeof raw !== "string") {
    console.error(`Error: --schedule must be a cron expression string or a JSON object (e.g. '{"kind":"at","at":"2026-04-23T09:10:00+08:00"}')`);
    process.exit(2);
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: --schedule looks like JSON but failed to parse: ${msg}`);
      console.error('  Expected shapes: {"kind":"at","at":"<ISO>"} | {"kind":"every","minutes":<n>} | {"kind":"cron","expr":"<expr>"[,"tz":"<tz>"]} | {"kind":"loop"}');
      process.exit(2);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error('Error: --schedule JSON must be an object with a "kind" field');
      process.exit(2);
    }
    const obj = parsed;
    const kind = obj.kind;
    if (kind !== "at" && kind !== "every" && kind !== "cron" && kind !== "loop") {
      console.error(`Error: --schedule JSON has invalid "kind": ${JSON.stringify(kind)} (expected one of: at, every, cron, loop)`);
      process.exit(2);
    }
    if (kind === "at" && typeof obj.at !== "string") {
      console.error('Error: --schedule {"kind":"at"} requires string field "at" (ISO-8601, e.g. "2026-04-23T09:10:00+08:00")');
      process.exit(2);
    }
    if (kind === "every") {
      if (typeof obj.minutes !== "number" || !Number.isFinite(obj.minutes)) {
        console.error('Error: --schedule {"kind":"every"} requires numeric field "minutes" (>= 5)');
        process.exit(2);
      }
      if (!Number.isInteger(obj.minutes) || obj.minutes < 5) {
        console.error(`Error: --schedule {"kind":"every"}.minutes must be an integer >= 5 (got ${obj.minutes})`);
        process.exit(2);
      }
      if (obj.startAt !== void 0 && typeof obj.startAt !== "string") {
        console.error('Error: --schedule {"kind":"every"}.startAt must be a string (ISO-8601) when provided');
        process.exit(2);
      }
    }
    if (kind === "cron") {
      if (typeof obj.expr !== "string") {
        console.error('Error: --schedule {"kind":"cron"} requires string field "expr" (e.g. "0 9 * * *")');
        process.exit(2);
      }
      if (obj.tz !== void 0 && obj.tz !== null && typeof obj.tz !== "string") {
        console.error('Error: --schedule {"kind":"cron"}.tz must be a string (IANA tz name) when provided');
        process.exit(2);
      }
    }
    return obj;
  }
  return { kind: "cron", expr: trimmed };
}
var TASK_MD_MAX_BYTES = 1024 * 1024;
function resolveTaskMdContent(flags) {
  const filePath = flags.taskMdFile;
  if (filePath !== void 0 && filePath !== "") {
    if (typeof filePath !== "string") {
      console.error("Error: --taskMdFile must be a file path string");
      process.exit(2);
    }
    try {
      const fs = require("fs");
      const stat = fs.statSync(filePath);
      if (stat.size > TASK_MD_MAX_BYTES) {
        console.error(`Error: --taskMdFile "${filePath}" is ${stat.size} bytes, exceeds ${TASK_MD_MAX_BYTES} (1 MB) limit`);
        process.exit(1);
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      if (raw.includes("\0")) {
        console.error(`Error: --taskMdFile "${filePath}" contains NUL bytes (is this a binary file?)`);
        process.exit(1);
      }
      return raw;
    } catch (err) {
      console.error(`Error: failed to read --taskMdFile "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  const contentFlag = flags.taskMdContent;
  if (typeof contentFlag === "string" && contentFlag !== "") {
    const byteLen = Buffer.byteLength(contentFlag, "utf-8");
    if (byteLen > TASK_MD_MAX_BYTES) {
      console.error(`Error: --taskMdContent is ${byteLen} bytes, exceeds ${TASK_MD_MAX_BYTES} (1 MB) limit. Use --taskMdFile for large content.`);
      process.exit(1);
    }
    return contentFlag;
  }
  return void 0;
}
function parseRuntimeConfigFlag(raw) {
  if (raw === void 0) return void 0;
  if (typeof raw !== "string") {
    console.error(`Error: --runtimeConfig must be a JSON object string (e.g. --runtimeConfig '{"model":"o3"}')`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: --runtimeConfig is not valid JSON: ${msg}`);
    process.exit(2);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("Error: --runtimeConfig must be a JSON object (not array, null, or primitive)");
    process.exit(2);
  }
  return parsed;
}
main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
