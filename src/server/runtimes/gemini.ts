// GeminiRuntime — drives Google Gemini CLI in ACP mode (v0.1.66)
//
// Communication: JSON-RPC 2.0 over stdio (gemini --acp)
// Process lifecycle: persistent across turns, single process per session (like Codex app-server)
// Protocol: Agent Client Protocol (ACP) — same wire format as Codex but with session/* methods
// System prompt: merged "MyAgents 3-layer + Gemini official prompt" written to a tmp file,
//                injected via GEMINI_SYSTEM_MD environment variable at spawn time
// Session: session/new (fresh) / session/load (resume by sessionId)
// Authentication: entirely delegated to the user's local gemini CLI state (we do NOT manage API keys)

import { spawn, type Subprocess } from 'bun';
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import type {
  RuntimeDetection,
  RuntimeModelInfo,
  RuntimePermissionMode,
  RuntimeType,
} from '../../shared/types/runtime';
import { GEMINI_PERMISSION_MODES } from '../../shared/types/runtime';
import type {
  AgentRuntime,
  RuntimeProcess,
  SessionStartOptions,
  UnifiedEvent,
  UnifiedEventCallback,
  ImagePayload,
} from './types';
import { augmentedProcessEnv, resolveCommand, stripAnsi } from './env-utils';

// ─── Tmp directory layout for system prompt files ───

const TMP_ROOT = join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.myagents', 'tmp', 'gemini-prompts',
);

/** Cached Gemini official system prompt path, keyed by CLI version. */
function baseSystemPromptPath(version: string): string {
  const safe = version.replace(/[^a-zA-Z0-9.\-_]/g, '_') || 'unknown';
  return join(TMP_ROOT, `base-${safe}.md`);
}

/** Per-session merged system prompt path. */
function sessionSystemPromptPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9\-_]/g, '_');
  return join(TMP_ROOT, `session-${safe}.md`);
}

/**
 * Ensure TMP_ROOT exists and delete session prompt files older than 1 hour.
 * Base cache files (base-<version>.md) are preserved between sessions.
 */
function cleanupStaleSessionPrompts(): void {
  try {
    if (!existsSync(TMP_ROOT)) {
      mkdirSync(TMP_ROOT, { recursive: true });
      return;
    }
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const file of readdirSync(TMP_ROOT)) {
      if (!file.startsWith('session-')) continue;
      const path = join(TMP_ROOT, file);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        /* ignore individual file errors */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Extract Gemini CLI's official system prompt to a version-keyed cache.
 *
 * Strategy: spawn `gemini -p "."` with GEMINI_WRITE_SYSTEM_MD pointing at the cache file.
 * Gemini writes the file during startup (before the API call), so we can poll for it and
 * kill the process as soon as it appears — no token cost.
 *
 * Returns the file contents, or null on failure.
 */
async function extractGeminiBasePrompt(version: string): Promise<string | null> {
  const cachePath = baseSystemPromptPath(version);

  if (existsSync(cachePath)) {
    try {
      const content = readFileSync(cachePath, 'utf8');
      if (content.trim().length > 0) return content;
    } catch {
      /* fall through to extraction */
    }
  }

  mkdirSync(TMP_ROOT, { recursive: true });

  let proc: Subprocess | null = null;
  try {
    proc = spawn([resolveCommand('gemini'), '-p', '.'], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
      env: {
        ...augmentedProcessEnv(),
        GEMINI_WRITE_SYSTEM_MD: cachePath,
      },
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (existsSync(cachePath)) {
        try {
          if (statSync(cachePath).size > 0) break;
        } catch {
          /* retry */
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (err) {
    console.warn('[gemini] extract spawn error:', err);
  } finally {
    try {
      proc?.kill(9);
    } catch {
      /* ignore */
    }
  }

  if (existsSync(cachePath)) {
    try {
      const content = readFileSync(cachePath, 'utf8');
      if (content.trim().length > 0) {
        console.log(`[gemini] Extracted base system prompt (${content.length} bytes) for v${version}`);
        return content;
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Build and write the per-session merged system prompt file.
 *
 * Layout:
 *   <header comment with session id + timestamp>
 *   <MyAgents three-layer prompt (verbatim from options.systemPromptAppend)>
 *   ---
 *   # Built-in Gemini CLI Guidelines
 *   <Gemini official system prompt verbatim, if extraction succeeded>
 *
 * Returns the path, or null if no MyAgents prompt was supplied (in which case we let
 * Gemini use its built-in default without GEMINI_SYSTEM_MD injection).
 */
async function writeSessionSystemPrompt(
  sessionId: string,
  myAgentsPrompt: string | undefined,
  geminiVersion: string,
): Promise<string | null> {
  if (!myAgentsPrompt || myAgentsPrompt.trim().length === 0) return null;

  mkdirSync(TMP_ROOT, { recursive: true });
  const path = sessionSystemPromptPath(sessionId);

  const basePrompt = await extractGeminiBasePrompt(geminiVersion);
  const timestamp = new Date().toISOString();

  let content = `<!-- MyAgents Gemini runtime session prompt, generated at ${timestamp} -->\n`;
  content += `<!-- Session: ${sessionId} -->\n\n`;
  content += myAgentsPrompt.trim() + '\n\n';

  if (basePrompt && basePrompt.trim().length > 0) {
    content += '---\n\n';
    content += '# Built-in Gemini CLI Guidelines\n\n';
    content +=
      'The sections below are the default Gemini CLI operational guidelines. Follow them for ' +
      'tool usage, safety, and tone unless they conflict with the MyAgents instructions above, ' +
      'in which case the MyAgents instructions take precedence.\n\n';
    content += basePrompt.trim() + '\n';
  }

  writeFileSync(path, content, 'utf8');
  return path;
}

/**
 * Build Gemini ACP prompt ContentBlock array with optional images.
 * ACP accepts `{ type: 'image', mimeType, data }` with base64 data natively —
 * simpler than Codex's localImage temp-file dance.
 */
function buildGeminiPrompt(text: string, images?: ImagePayload[]): unknown[] {
  const blocks: unknown[] = [];
  if (images && images.length > 0) {
    for (const img of images) {
      blocks.push({ type: 'image', mimeType: img.mimeType, data: img.data });
    }
  }
  if (text) {
    blocks.push({ type: 'text', text });
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }
  return blocks;
}

// ─── JSON-RPC 2.0 client ───

class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private onNotification: ((method: string, params: unknown) => void) | null = null;
  private onServerRequest: ((id: number, method: string, params: unknown) => void) | null = null;
  private encoder = new TextEncoder();
  private sink: { write(data: Uint8Array): number; flush(): void };
  private reading = false;

  constructor(private proc: Subprocess) {
    const stdin = proc.stdin;
    if (!stdin || typeof stdin === 'number') throw new Error('stdin not available');
    this.sink = stdin as { write(data: Uint8Array): number; flush(): void };
  }

  setNotificationHandler(h: (method: string, params: unknown) => void): void {
    this.onNotification = h;
  }

  setServerRequestHandler(h: (id: number, method: string, params: unknown) => void): void {
    this.onServerRequest = h;
  }

  async call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`JSON-RPC call "${method}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async startReading(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    const stdout = this.proc.stdout;
    if (!stdout) return;

    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          this.handleLine(line);
        }
      }
    } catch (err) {
      if (String(err).includes('cancel') || String(err).includes('closed')) return;
      console.error('[gemini-rpc] Reader error:', err);
    } finally {
      reader.releaseLock();
      for (const [, { reject }] of this.pending) {
        reject(new Error('gemini --acp process exited'));
      }
      this.pending.clear();
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if ('id' in msg && !('method' in msg)) {
      const id = msg.id as number;
      const handler = this.pending.get(id);
      if (handler) {
        this.pending.delete(id);
        if (msg.error) {
          const err = msg.error as { code: number; message: string };
          handler.reject(new Error(`RPC error ${err.code}: ${err.message}`));
        } else {
          handler.resolve(msg.result);
        }
      }
      return;
    }

    if ('method' in msg && !('id' in msg)) {
      this.onNotification?.(msg.method as string, msg.params);
      return;
    }

    if ('method' in msg && 'id' in msg) {
      this.onServerRequest?.(msg.id as number, msg.method as string, msg.params);
      return;
    }
  }

  private write(msg: unknown): void {
    try {
      this.sink.write(this.encoder.encode(JSON.stringify(msg) + '\n'));
      this.sink.flush();
    } catch {
      /* stdin may be closed */
    }
  }

  destroy(): void {
    for (const [, { reject }] of this.pending) {
      reject(new Error('Client destroyed'));
    }
    this.pending.clear();
  }
}

// ─── Per-session state ───

interface PendingToolCall {
  toolName: string;
  emittedStart: boolean;
  emittedStop: boolean;
}

interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

class GeminiProcess implements RuntimeProcess {
  readonly pid: number;
  exited = false;
  rpc: JsonRpcClient;
  sessionId = '';
  systemPromptPath: string | null = null;

  /** Callback registered by startSession() — sendMessage() routes async events through this. */
  wrappedOnEvent: UnifiedEventCallback | null = null;

  /** Dedup tool_use_start/stop across ACP's tool_call + tool_call_update + request_permission paths. */
  toolState = new Map<string, PendingToolCall>();

  /** Options snapshot for each in-flight permission request, keyed by JSON-RPC id. */
  pendingPermissionOptions = new Map<number, PermissionOption[]>();

  /** Thinking block tracking — agent_thought_chunk doesn't carry an index from Gemini. */
  thinkingIndex = 0;
  thinkingActive = false;

  private proc: Subprocess;

  constructor(proc: Subprocess) {
    this.proc = proc;
    this.pid = proc.pid;
    this.rpc = new JsonRpcClient(proc);
  }

  async writeLine(_line: string): Promise<void> {
    throw new Error('Gemini uses JSON-RPC, not raw stdin. Use rpc.call() instead.');
  }

  kill(signal?: number): void {
    if (this.exited) return;
    try {
      this.proc.kill(signal ?? 15);
    } catch {
      /* already dead */
    }
  }

  async waitForExit(): Promise<number> {
    const code = await this.proc.exited;
    this.exited = true;
    return code;
  }

  closeStdin(): void {
    const stdin = this.proc.stdin;
    if (!stdin || typeof stdin === 'number') return;
    try {
      const sink = stdin as { end(): void };
      sink.end();
    } catch {
      /* ignore */
    }
  }
}

// ─── Module-level model cache ───

let modelCache: { models: RuntimeModelInfo[]; timestamp: number } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Permission mode helpers ───

function mapPermissionMode(mode: string): string {
  switch (mode) {
    case 'auto':
      return 'autoEdit';
    case 'plan':
      return 'plan';
    case 'fullAgency':
      return 'yolo';
    case 'default':
    case 'autoEdit':
    case 'yolo':
      return mode;
    default:
      return 'autoEdit';
  }
}

/** Default mode by scenario: IM/Cron → YOLO (D6), desktop → Auto Edit (D5). */
function pickDefaultMode(scenarioType: string): string {
  const isImOrCron =
    scenarioType === 'im' || scenarioType === 'agent-channel' || scenarioType === 'cron';
  return isImOrCron ? 'yolo' : 'autoEdit';
}

// ─── GeminiRuntime ───

export class GeminiRuntime implements AgentRuntime {
  readonly type: RuntimeType = 'gemini';

  async detect(): Promise<RuntimeDetection> {
    try {
      const proc = spawn([resolveCommand('gemini'), '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: augmentedProcessEnv(),
      });
      const text = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code === 0) {
        return { installed: true, version: text.trim(), path: 'gemini' };
      }
    } catch {
      /* not installed */
    }
    return { installed: false };
  }

  async queryModels(): Promise<RuntimeModelInfo[]> {
    if (modelCache && Date.now() - modelCache.timestamp < MODEL_CACHE_TTL_MS) {
      return modelCache.models;
    }
    try {
      const models = await this.queryModelsViaAcp();
      modelCache = { models, timestamp: Date.now() };
      return models;
    } catch (err) {
      console.error('[gemini] Failed to query models:', err);
      return modelCache?.models ?? [];
    }
  }

  /**
   * Spawn a short-lived `gemini --acp`, handshake via initialize + session/new,
   * read available models from the response, then kill.
   */
  private async queryModelsViaAcp(): Promise<RuntimeModelInfo[]> {
    // Use HOME as cwd — queryModels runs outside any workspace context and gemini can
    // otherwise get confused trying to load project-level config.
    const cwd = process.env.HOME || process.cwd();
    const proc = spawn([resolveCommand('gemini'), '--acp'], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      cwd,
      env: augmentedProcessEnv(),
    });

    const rpc = new JsonRpcClient(proc);
    const readerDone = rpc.startReading();

    // Yield to the microtask queue so the reader loop enters its first `await read()`
    // before we start writing. Without this, the first write may race with subprocess
    // startup and the response can arrive before we've registered the pending handler.
    await new Promise((r) => setTimeout(r, 50));

    try {
      // Bump timeouts here because Gemini CLI cold-start (Node.js + auth refresh) can
      // take 3-8s on first run; 30s gives enough headroom while still catching real hangs.
      await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30_000);

      const result = (await rpc.call(
        'session/new',
        { cwd, mcpServers: [] },
        30_000,
      )) as {
        models?: {
          availableModels?: Array<{ modelId: string; name: string; description?: string }>;
          currentModelId?: string;
        };
      };

      const available = result.models?.availableModels ?? [];
      const currentId = result.models?.currentModelId;
      const defaultEntry: RuntimeModelInfo = { value: '', displayName: '默认', isDefault: true };
      const discovered: RuntimeModelInfo[] = available.map((m) => ({
        value: m.modelId,
        displayName: m.name || m.modelId,
        description: m.description,
        isDefault: m.modelId === currentId,
      }));
      return [defaultEntry, ...discovered];
    } finally {
      rpc.destroy();
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      await readerDone.catch(() => {});
    }
  }

  getPermissionModes(): RuntimePermissionMode[] {
    return GEMINI_PERMISSION_MODES;
  }

  async startSession(
    options: SessionStartOptions,
    onEvent: UnifiedEventCallback,
  ): Promise<RuntimeProcess> {
    cleanupStaleSessionPrompts();

    // 1. Extract Gemini CLI version to key the base prompt cache.
    const detection = await this.detect();
    const geminiVersion = detection.version || 'unknown';

    // 2. Write the per-session merged system prompt file BEFORE spawn.
    //    This is critical: GEMINI_SYSTEM_MD is read at spawn time, so we must have the
    //    path ready before calling spawn().
    const promptFile = await writeSessionSystemPrompt(
      options.sessionId,
      options.systemPromptAppend,
      geminiVersion,
    );

    // 3. Spawn gemini --acp with the system prompt env var (if we have a file).
    const spawnEnv: Record<string, string | undefined> = { ...augmentedProcessEnv() };
    if (promptFile) {
      spawnEnv.GEMINI_SYSTEM_MD = promptFile;
    }

    const proc = spawn([resolveCommand('gemini'), '--acp'], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      cwd: options.workspacePath,
      env: spawnEnv,
    });

    const geminiProc = new GeminiProcess(proc);
    geminiProc.systemPromptPath = promptFile;

    // 4. Wire up the event callback closure. sendMessage() reads this back through the
    //    process instance so it can emit turn_complete / usage from the RPC response.
    let sessionCompleteEmitted = false;
    const wrappedOnEvent: UnifiedEventCallback = (event) => {
      if (event.kind === 'session_complete') {
        if (sessionCompleteEmitted) return;
        sessionCompleteEmitted = true;
      }
      onEvent(event);
    };
    geminiProc.wrappedOnEvent = wrappedOnEvent;

    // 5. Wire notification + server-request handlers.
    geminiProc.rpc.setNotificationHandler((method, params) => {
      this.logNotification(method, params);
      const result = this.parseNotification(geminiProc, method, params);
      if (!result) return;
      const events = Array.isArray(result) ? result : [result];
      for (const event of events) wrappedOnEvent(event);
    });

    geminiProc.rpc.setServerRequestHandler((id, method, params) => {
      this.handleServerRequest(geminiProc, id, method, params, wrappedOnEvent);
    });

    geminiProc.rpc.startReading();

    // 6. Lifecycle: emit session_complete on process exit + clean up prompt file.
    proc.exited.then((code) => {
      geminiProc.exited = true;
      if (geminiProc.systemPromptPath && existsSync(geminiProc.systemPromptPath)) {
        try {
          unlinkSync(geminiProc.systemPromptPath);
        } catch {
          /* ignore */
        }
      }
      wrappedOnEvent({
        kind: 'session_complete',
        result: code === 0 ? '' : `Gemini process exited with code ${code}`,
        subtype: code === 0 ? 'success' : 'error',
      });
    });

    // 7. Drain stderr for diagnostic logging.
    if (proc.stderr) {
      (async () => {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true }).trim();
            if (text) console.error(`[gemini-stderr] ${stripAnsi(text)}`);
          }
        } catch {
          /* ignore */
        } finally {
          reader.releaseLock();
        }
      })();
    }

    try {
      // 8. ACP initialize handshake.
      await geminiProc.rpc.call(
        'initialize',
        { protocolVersion: 1, clientCapabilities: {} },
        15_000,
      );

      // 9. Determine mode + create/load session.
      const desiredMode = options.permissionMode
        ? mapPermissionMode(options.permissionMode)
        : pickDefaultMode(options.scenario.type);

      if (options.resumeSessionId) {
        const loadParams = {
          sessionId: options.resumeSessionId,
          cwd: options.workspacePath,
          mcpServers: [],
        };
        console.log(`[gemini] RPC session/load: ${JSON.stringify(loadParams)}`);
        await geminiProc.rpc.call('session/load', loadParams, 30_000);
        geminiProc.sessionId = options.resumeSessionId;

        onEvent({
          kind: 'session_init',
          sessionId: geminiProc.sessionId,
          model: options.model || '',
          tools: [],
        });
      } else {
        const newParams = { cwd: options.workspacePath, mcpServers: [] };
        console.log(`[gemini] RPC session/new: ${JSON.stringify(newParams)}`);
        const result = (await geminiProc.rpc.call('session/new', newParams, 30_000)) as {
          sessionId: string;
          modes?: { currentModeId?: string };
          models?: { currentModelId?: string };
        };
        geminiProc.sessionId = result.sessionId;

        onEvent({
          kind: 'session_init',
          sessionId: result.sessionId,
          model: result.models?.currentModelId || options.model || '',
          tools: [],
        });
      }

      // 10. Apply desired mode if not default.
      if (desiredMode !== 'default') {
        try {
          await geminiProc.rpc.call(
            'session/set_mode',
            { sessionId: geminiProc.sessionId, modeId: desiredMode },
            5_000,
          );
          console.log(`[gemini] set_mode → ${desiredMode}`);
        } catch (err) {
          console.warn(`[gemini] set_mode failed (non-fatal):`, err);
        }
      }

      // 11. Apply model override (if non-empty).
      if (options.model && options.model.length > 0) {
        try {
          await geminiProc.rpc.call(
            'session/set_model',
            { sessionId: geminiProc.sessionId, modelId: options.model },
            5_000,
          );
          console.log(`[gemini] set_model → ${options.model}`);
        } catch (err) {
          console.warn(`[gemini] set_model failed (non-fatal):`, err);
        }
      }

      // 12. Send initial message if provided. This runs async — session/update
      //     notifications stream the response, and session/prompt resolves with
      //     { stopReason, _meta.quota } when done.
      if (options.initialMessage) {
        this.dispatchPrompt(
          geminiProc,
          options.initialMessage,
          options.initialImages,
          wrappedOnEvent,
        );
      }
    } catch (err) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      geminiProc.exited = true;
      throw err;
    }

    return geminiProc;
  }

  async sendMessage(
    process: RuntimeProcess,
    message: string,
    images?: ImagePayload[],
  ): Promise<void> {
    const geminiProc = process as GeminiProcess;
    if (geminiProc.exited) throw new Error('Gemini process has exited');

    // Reset per-turn thinking state; tool state is toolCallId-scoped and cleans itself up.
    geminiProc.thinkingActive = false;

    const cb = geminiProc.wrappedOnEvent;
    if (!cb) throw new Error('Gemini session has no event callback');
    this.dispatchPrompt(geminiProc, message, images, cb);
  }

  /**
   * Fire a session/prompt RPC and emit UnifiedEvents for its response + usage.
   * Notification events are emitted on their own track via the notification handler
   * registered in startSession. The RPC resolution only produces turn_complete + usage.
   */
  private dispatchPrompt(
    geminiProc: GeminiProcess,
    message: string,
    images: ImagePayload[] | undefined,
    emit: UnifiedEventCallback,
  ): void {
    const prompt = buildGeminiPrompt(message, images);
    geminiProc.rpc
      .call(
        'session/prompt',
        { sessionId: geminiProc.sessionId, prompt },
        10 * 60_000,
      )
      .then((result) => {
        const usage = extractUsage(result as PromptResponse);
        if (usage) emit(usage);
        const stopReason = (result as PromptResponse)?.stopReason || '';
        // Close any lingering thinking block
        if (geminiProc.thinkingActive) {
          emit({ kind: 'thinking_stop', index: geminiProc.thinkingIndex });
          geminiProc.thinkingActive = false;
        }
        emit({ kind: 'turn_complete', result: stopReason });
      })
      .catch((err) => {
        console.error('[gemini] session/prompt error:', err);
        emit({
          kind: 'session_complete',
          result: err instanceof Error ? err.message : String(err),
          subtype: 'error',
        });
      });
  }

  async respondPermission(
    process: RuntimeProcess,
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
  ): Promise<void> {
    const geminiProc = process as GeminiProcess;
    if (geminiProc.exited) return;

    const rpcId = parseInt(requestId, 10);
    if (isNaN(rpcId)) {
      console.error('[gemini] Invalid approval requestId:', requestId);
      return;
    }

    const options = geminiProc.pendingPermissionOptions.get(rpcId);
    geminiProc.pendingPermissionOptions.delete(rpcId);

    const wantKind =
      decision === 'deny'
        ? 'reject_once'
        : decision === 'always_allow'
          ? 'allow_always'
          : 'allow_once';

    let optionId: string | undefined;
    if (options && options.length > 0) {
      optionId = options.find((o) => o.kind === wantKind)?.optionId;
      if (!optionId) {
        // Fallback to broader kind categories
        if (decision === 'deny') {
          optionId = options.find((o) => /reject|deny|cancel/i.test(o.kind || ''))?.optionId;
        } else {
          optionId = options.find((o) => /allow|proceed/i.test(o.kind || ''))?.optionId;
        }
      }
    }

    if (!optionId) {
      console.warn(
        `[gemini] No matching option for decision=${decision}, responding with cancelled outcome`,
      );
      geminiProc.rpc.respond(rpcId, { outcome: { outcome: 'cancelled' } });
      return;
    }

    geminiProc.rpc.respond(rpcId, { outcome: { outcome: 'selected', optionId } });
  }

  async stopSession(process: RuntimeProcess): Promise<void> {
    const geminiProc = process as GeminiProcess;
    if (geminiProc.exited) return;

    try {
      if (geminiProc.sessionId) {
        geminiProc.rpc.notify('session/cancel', { sessionId: geminiProc.sessionId });
      }
      geminiProc.closeStdin();
    } catch {
      /* ignore */
    }

    const killTimer = setTimeout(() => geminiProc.kill(), 3_000);
    try {
      await geminiProc.waitForExit();
    } catch {
      /* ignore */
    } finally {
      clearTimeout(killTimer);
      geminiProc.rpc.destroy();
    }
  }

  // ─── Logging ───

  private logNotification(method: string, params: unknown): void {
    const upd = (params as { update?: { sessionUpdate?: string } } | undefined)?.update;
    const su = upd?.sessionUpdate;
    const isNoisy =
      su === 'agent_message_chunk' ||
      su === 'agent_thought_chunk' ||
      su === 'available_commands_update';
    if (isNoisy) return;

    let detail = '';
    if (su) detail += ` kind=${su}`;
    if (su === 'tool_call') {
      const u = upd as Record<string, unknown>;
      detail += ` id=${String(u.toolCallId || '').slice(0, 16)} title=${String(u.title || '').slice(0, 40)}`;
    } else if (su === 'tool_call_update') {
      const u = upd as Record<string, unknown>;
      detail += ` id=${String(u.toolCallId || '').slice(0, 16)} status=${u.status}`;
    }
    console.log(`[gemini] ${method}${detail}`);
  }

  // ─── Notification parsing ───

  private parseNotification(
    geminiProc: GeminiProcess,
    method: string,
    params: unknown,
  ): UnifiedEvent | UnifiedEvent[] | null {
    if (method !== 'session/update') return null;

    const p = params as { update?: Record<string, unknown> };
    const update = p.update;
    if (!update) return null;

    const su = update.sessionUpdate as string;

    switch (su) {
      // ── Text streaming ──
      case 'agent_message_chunk': {
        const content = update.content as { text?: string } | undefined;
        const text = content?.text ?? '';
        if (!text) return null;
        const events: UnifiedEvent[] = [];
        if (geminiProc.thinkingActive) {
          events.push({ kind: 'thinking_stop', index: geminiProc.thinkingIndex });
          geminiProc.thinkingActive = false;
        }
        events.push({ kind: 'text_delta', text });
        return events;
      }

      // ── Thinking streaming ──
      case 'agent_thought_chunk': {
        const content = update.content as { text?: string } | undefined;
        const text = content?.text ?? '';
        if (!text) return null;
        const events: UnifiedEvent[] = [];
        if (!geminiProc.thinkingActive) {
          geminiProc.thinkingIndex += 1;
          geminiProc.thinkingActive = true;
          events.push({ kind: 'thinking_start', index: geminiProc.thinkingIndex });
        }
        events.push({ kind: 'thinking_delta', text, index: geminiProc.thinkingIndex });
        return events;
      }

      // ── Tool call notification (pre-approval in autoEdit/yolo modes) ──
      case 'tool_call': {
        const toolCallId = String(update.toolCallId || '');
        if (!toolCallId) return null;
        const title = String(update.title || 'Tool');
        const kind = String(update.kind || '');
        const toolName = mapToolKindToName(kind, title);

        const existing = geminiProc.toolState.get(toolCallId);
        if (existing?.emittedStart) return null;
        geminiProc.toolState.set(toolCallId, {
          toolName,
          emittedStart: true,
          emittedStop: false,
        });

        return {
          kind: 'tool_use_start',
          toolUseId: toolCallId,
          toolName,
          input: {
            title,
            kind,
            ...(Array.isArray(update.content) ? { content: update.content } : {}),
          },
        };
      }

      // ── Tool completion ──
      case 'tool_call_update': {
        const toolCallId = String(update.toolCallId || '');
        if (!toolCallId) return null;
        const status = String(update.status || '');
        const state = geminiProc.toolState.get(toolCallId);

        if (status === 'completed' || status === 'failed') {
          if (state?.emittedStop) return null;
          const resultText = extractToolResultText(update);
          const isError = status === 'failed';
          const events: UnifiedEvent[] = [];

          // Late-bind tool_use_start if we never saw one
          if (!state?.emittedStart) {
            const title = String(update.title || 'Tool');
            const kind = String(update.kind || '');
            const toolName = mapToolKindToName(kind, title);
            events.push({
              kind: 'tool_use_start',
              toolUseId: toolCallId,
              toolName,
              input: { title, kind },
            });
          }

          geminiProc.toolState.set(toolCallId, {
            toolName: state?.toolName || 'Tool',
            emittedStart: true,
            emittedStop: true,
          });

          events.push({ kind: 'tool_use_stop', toolUseId: toolCallId });
          events.push({
            kind: 'tool_result',
            toolUseId: toolCallId,
            content: resultText || (isError ? 'Tool execution failed' : 'Tool executed'),
            isError,
          });
          return events;
        }
        // Other statuses (pending / in_progress) — ignore (no delta text to emit)
        return null;
      }

      // ── Plan updates — transparent raw passthrough until UI is built ──
      case 'plan':
        return { kind: 'raw', data: update };

      // ── IDE command menus — ignored ──
      case 'available_commands_update':
      case 'user_message_chunk':
        return null;

      default:
        console.log(`[gemini] Unhandled session/update kind: ${su}`);
        return null;
    }
  }

  // ─── Server-initiated requests ───

  private handleServerRequest(
    geminiProc: GeminiProcess,
    rpcId: number,
    method: string,
    params: unknown,
    onEvent: UnifiedEventCallback,
  ): void {
    switch (method) {
      case 'session/request_permission': {
        const p = params as {
          sessionId?: string;
          options?: PermissionOption[];
          toolCall?: {
            toolCallId?: string;
            title?: string;
            kind?: string;
            content?: unknown;
            status?: string;
          };
        };

        const toolCall = p.toolCall || {};
        const toolCallId = String(toolCall.toolCallId || '');
        const title = String(toolCall.title || 'Tool');
        const kind = String(toolCall.kind || '');
        const toolName = mapToolKindToName(kind, title);

        if (p.options && p.options.length > 0) {
          geminiProc.pendingPermissionOptions.set(rpcId, p.options);
        }

        // Emit tool_use_start if we haven't already (default mode goes straight here)
        if (toolCallId) {
          const state = geminiProc.toolState.get(toolCallId);
          if (!state?.emittedStart) {
            geminiProc.toolState.set(toolCallId, {
              toolName,
              emittedStart: true,
              emittedStop: false,
            });
            onEvent({
              kind: 'tool_use_start',
              toolUseId: toolCallId,
              toolName,
              input: { title, kind },
            });
          }
        }

        onEvent({
          kind: 'permission_request',
          requestId: String(rpcId),
          toolName,
          toolUseId: toolCallId,
          input: { title, kind },
        });
        break;
      }

      // fs/* and terminal/* — we do NOT declare these capabilities in `initialize`,
      // so Gemini CLI uses its own internal implementations. If it still asks, decline.
      default: {
        console.warn(`[gemini] Unhandled server request: ${method}`);
        geminiProc.rpc.respondError(rpcId, -32601, `Method not supported: ${method}`);
        break;
      }
    }
  }
}

// ─── Helpers ───

interface PromptResponse {
  stopReason?: string;
  _meta?: {
    quota?: {
      token_count?: { input_tokens?: number; output_tokens?: number };
      model_usage?: Array<{
        model: string;
        token_count: { input_tokens: number; output_tokens: number };
      }>;
    };
  };
}

/**
 * Map Gemini ACP `toolCall.kind` into a MyAgents toolName for frontend badge rendering.
 * ACP kinds observed in Gemini CLI v0.37.2:
 *   "execute"  → shell command  → Bash
 *   "edit"     → file edit      → Edit
 *   "read"     → file read      → Read
 *   "search"   → grep / find    → Grep
 *   "fetch"    → web fetch      → WebFetch
 *   other      → fallback to title string
 */
function mapToolKindToName(kind: string, title: string): string {
  switch (kind) {
    case 'execute':
      return 'Bash';
    case 'edit':
      return 'Edit';
    case 'read':
      return 'Read';
    case 'search':
      return 'Grep';
    case 'fetch':
      return 'WebFetch';
    default:
      return title || 'Tool';
  }
}

/** Extract text content from a tool_call_update's `content[]` array. */
function extractToolResultText(update: Record<string, unknown>): string {
  const content = update.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const inner = item.content as Record<string, unknown> | undefined;
    if (inner && typeof inner.text === 'string') {
      parts.push(inner.text);
    } else if (typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join('\n');
}

/** Extract usage from a session/prompt RPC response's `_meta.quota`. */
function extractUsage(response: PromptResponse): UnifiedEvent | null {
  const quota = response._meta?.quota;
  if (!quota) return null;
  const total = quota.token_count;
  if (!total) return null;

  const modelUsage: Record<string, { inputTokens: number; outputTokens: number }> = {};
  if (Array.isArray(quota.model_usage)) {
    for (const m of quota.model_usage) {
      if (!m?.model) continue;
      modelUsage[m.model] = {
        inputTokens: m.token_count?.input_tokens ?? 0,
        outputTokens: m.token_count?.output_tokens ?? 0,
      };
    }
  }

  return {
    kind: 'usage',
    inputTokens: total.input_tokens ?? 0,
    outputTokens: total.output_tokens ?? 0,
    model: Object.keys(modelUsage)[0],
    modelUsage: Object.keys(modelUsage).length > 0 ? modelUsage : undefined,
    semantics: 'delta',
  };
}
