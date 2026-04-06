// External Runtime Session Handler (v0.1.59)
//
// Manages the lifecycle of an external CLI runtime session (Claude Code, Codex).
// This module parallels agent-session.ts but is drastically simpler because
// the external CLI handles all SDK interaction, tool execution, and session persistence.
// We only need to: spawn process, relay events, and handle permission delegation.

import { broadcast } from '../sse';
import { buildSystemPromptAppend } from '../system-prompt';
import type { InteractionScenario } from '../system-prompt';
import type { AgentRuntime, RuntimeProcess, UnifiedEvent } from './types';
import { getExternalRuntime, getCurrentRuntimeType, isExternalRuntime } from './factory';
import type { RuntimeType } from '../../shared/types/runtime';
import { saveSessionMetadata, saveSessionMessages, updateSessionMetadata, getSessionMetadata, getSessionData } from '../SessionStore';
import { createSessionMetadata } from '../types/session';
import type { SessionMessage } from '../types/session';

// ─── Module state ───

let activeProcess: RuntimeProcess | null = null;
let activeRuntime: AgentRuntime | null = null;
let isRunning = false;
let turnCompleted = false;

// Track session context for multi-turn resume (CC -p mode exits after each turn)
let lastSessionId = '';
let lastWorkspacePath = '';
let lastScenario: InteractionScenario = { type: 'desktop' };
let lastRuntimeSessionId = '';  // Runtime's session ID (CC: from hook/init; Codex: threadId)

// Message accumulation for SessionStore persistence
// allSessionMessages grows across turns — saveSessionMessages expects the FULL cumulative array
// (it uses messages.slice(existingCount) internally to find new messages to append)
let allSessionMessages: SessionMessage[] = [];
let currentAssistantText = '';  // Accumulate streaming text for the current assistant message
let currentTurnStartTime = 0;

// IM stream callback — mirrors agent-session.ts pattern for IM Bot relay
type ImStreamCallback = (
  event: 'delta' | 'block-end' | 'complete' | 'error' | 'permission-request' | 'activity',
  data: string,
) => void;
let imStreamCallback: ImStreamCallback | null = null;
let imCallbackNulledDuringTurn = false; // Prevents stale turn events leaking to new callback

/** Fire IM callback only if not stale (guard mirrors agent-session.ts pattern) */
function fireImCallback(event: 'delta' | 'block-end' | 'complete' | 'error' | 'permission-request' | 'activity', data: string): void {
  if (imStreamCallback && !imCallbackNulledDuringTurn) {
    imStreamCallback(event, data);
  }
}

/**
 * Set the runtime's session ID (CC: from hook/system.init; Codex: from thread/start).
 * Used for session resume in multi-turn conversations.
 */
export function setRuntimeSessionId(id: string): void {
  lastRuntimeSessionId = id;
  console.log(`[external-session] Runtime session ID set: ${id}`);
}

/**
 * Restore module-level state after Sidecar restart (session resume).
 * Called from index.ts when an external runtime session is reopened from history.
 * Sets lastRuntimeSessionId so sendExternalMessage uses resume instead of new session.
 */
export function restoreExternalSessionState(
  sessionId: string,
  workspacePath: string,
  scenario: InteractionScenario,
): void {
  lastSessionId = sessionId;
  lastWorkspacePath = workspacePath;
  lastScenario = scenario;
  lastRuntimeSessionId = sessionId; // Runtime session ID === our session ID

  // Load existing messages for correct incremental save
  const data = getSessionData(sessionId);
  if (data?.messages?.length) {
    allSessionMessages = data.messages;
  }
  console.log(`[external-session] Restored state for session ${sessionId} (${allSessionMessages.length} messages)`);
}

/**
 * Set IM stream callback for relaying CC events to Rust IM.
 * Mirrors agent-session.ts setImStreamCallback pattern.
 */
export function setExternalImStreamCallback(cb: ImStreamCallback | null): void {
  if (cb !== null && imStreamCallback !== null) {
    imCallbackNulledDuringTurn = true;
    try { imStreamCallback('error', '消息处理被新请求取代'); } catch { /* old stream may already be closed */ }
  }
  if (cb === null) {
    imCallbackNulledDuringTurn = true;
  } else {
    imCallbackNulledDuringTurn = false;
  }
  imStreamCallback = cb;
}

// ─── Public API ───

/**
 * Check if we should use an external runtime for this sidecar
 */
export function shouldUseExternalRuntime(): boolean {
  return isExternalRuntime(getCurrentRuntimeType());
}

/**
 * Get the current external runtime type, or null if builtin
 */
export function getActiveRuntimeType(): RuntimeType {
  return getCurrentRuntimeType();
}

/**
 * Wait for external session to become idle.
 * Detects two idle patterns:
 * - CC -p mode: process exits after each turn → !isRunning && !activeProcess
 * - Codex app-server: process stays alive, turn completes → turnCompleted flag
 * Returns true if completed within timeout, false otherwise.
 */
export async function waitForExternalSessionIdle(timeoutMs: number, pollMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Brief initial delay to let sendExternalMessage → startExternalSession set isRunning.
  // Without this, polling could see the pre-start state (!isRunning && !activeProcess) and
  // return true immediately before the CC process has even started.
  if (!isRunning && !activeProcess) {
    await new Promise(r => setTimeout(r, 200));
    if (!isRunning && !activeProcess) return true; // genuinely idle
  }
  while (Date.now() < deadline) {
    if (!isRunning && !activeProcess) return true;  // CC: process exited
    if (activeProcess?.exited) return true;          // CC: process exited (alt check)
    if (turnCompleted) return true;                  // Codex: turn done, process alive
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Get the last assistant message text from the current session.
 * Used by Cron handler to extract CC response after completion.
 */
export function getLastExternalAssistantText(): string {
  for (let i = allSessionMessages.length - 1; i >= 0; i--) {
    if (allSessionMessages[i].role === 'assistant') {
      return allSessionMessages[i].content ?? '';
    }
  }
  return '';
}

/**
 * Start an external runtime session.
 * Called instead of the builtin startStreamingSession() when runtime is external.
 */
export async function startExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  initialMessage?: string;
  model?: string;
  permissionMode?: string;
  scenario: InteractionScenario;
  resumeSessionId?: string;
}): Promise<void> {
  if (isRunning) {
    console.warn('[external-session] Session already running, ignoring start request');
    return;
  }

  const runtimeType = getCurrentRuntimeType();
  const runtime = getExternalRuntime(runtimeType);
  activeRuntime = runtime;

  // Build system prompt using MyAgents' three-layer architecture
  const systemPromptAppend = buildSystemPromptAppend(options.scenario);

  console.log(`[external-session] Starting ${runtimeType} session for ${options.sessionId}`);
  turnCompleted = false;
  currentAssistantText = '';
  currentTurnStartTime = 0;
  // Only clear message history for new sessions, not resumes
  if (!options.resumeSessionId) {
    allSessionMessages = [];
  }

  // Broadcast user message so frontend displays it in the chat
  // Also record it for SessionStore persistence
  if (options.initialMessage) {
    const userMsg: SessionMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: options.initialMessage,
      timestamp: new Date().toISOString(),
    };
    broadcast('chat:message-replay', { message: userMsg });
    allSessionMessages.push(userMsg);
    currentAssistantText = '';
    currentTurnStartTime = Date.now();

    // Register session in history index (mirrors agent-session.ts enqueueUserMessage logic)
    if (!options.resumeSessionId && !getSessionMetadata(options.sessionId)) {
      const meta = createSessionMetadata(options.workspacePath);
      meta.id = options.sessionId;
      meta.runtime = getCurrentRuntimeType();
      const trimmed = options.initialMessage.trim();
      meta.title = trimmed.slice(0, 40);
      if (meta.title.length < trimmed.length) meta.title += '...';
      saveSessionMetadata(meta);
      console.log(`[external-session] session ${options.sessionId} persisted to SessionStore`);
    }
  }

  broadcast('chat:status', { sessionState: 'running' });

  try {
    const process = await runtime.startSession(
      {
        sessionId: options.sessionId,
        workspacePath: options.workspacePath,
        initialMessage: options.initialMessage,
        systemPromptAppend,
        model: options.model,
        permissionMode: options.permissionMode,
        scenario: options.scenario,
        resumeSessionId: options.resumeSessionId,
      },
      handleUnifiedEvent,
    );

    // Atomically set both process and running flag
    activeProcess = process;
    isRunning = true;
    // Track for multi-turn resume
    lastSessionId = options.sessionId;
    lastWorkspacePath = options.workspacePath;
    lastScenario = options.scenario;
    console.log(`[external-session] ${runtimeType} process started, pid=${activeProcess.pid}`);
  } catch (err) {
    isRunning = false;
    activeProcess = null;
    activeRuntime = null;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[external-session] Failed to start ${runtimeType}:`, message);
    broadcast('chat:status', { sessionState: 'error' });
    broadcast('chat:agent-error', { message: `Failed to start ${runtimeType}: ${message}` });
    // Re-throw so the HTTP handler returns an error response
    throw err;
  }
}

/**
 * Session context for first-time initialization (passed from index.ts)
 */
export interface ExternalSendContext {
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  permissionMode?: string;
  model?: string;  // Runtime-specific model (e.g., "sonnet", "opus")
}

/**
 * Send a user message via external runtime.
 * Handles three cases:
 * 1. No previous session → start a new one (first message)
 * 2. Previous process exited → resume with --resume (CC -p mode multi-turn)
 * 3. Process still running → send via stdin (shouldn't happen in -p mode)
 */
export async function sendExternalMessage(
  text: string,
  _images?: unknown[],
  _permissionMode?: string,
  _model?: string,
  context?: ExternalSendContext,
): Promise<{ queued: boolean; error?: string }> {
  // Case 1: No previous session — start fresh
  if (!lastRuntimeSessionId && !isRunning) {
    if (!context) {
      return { queued: false, error: 'No session context for first message' };
    }
    try {
      await startExternalSession({
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        initialMessage: text,
        model: context.model,
        permissionMode: context.permissionMode,
        scenario: context.scenario,
      });
      return { queued: true };
    } catch (err) {
      return { queued: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Case 2: Previous process exited — resume (CC -p mode multi-turn)
  if (!activeProcess || activeProcess.exited) {
    console.log(`[external-session] Previous process exited, resuming session ${lastRuntimeSessionId}`);
    try {
      await startExternalSession({
        sessionId: lastSessionId,
        workspacePath: lastWorkspacePath,
        initialMessage: text,
        permissionMode: context?.permissionMode,
        scenario: lastScenario,
        resumeSessionId: lastRuntimeSessionId, // --resume to continue conversation
      });
      return { queued: true };
    } catch (err) {
      return { queued: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Case 3: Process still running — send via runtime.sendMessage
  // This is the normal path for persistent-process runtimes like Codex app-server.
  if (!activeRuntime) {
    return { queued: false, error: 'No active runtime' };
  }
  try {
    // Broadcast user message + record for persistence (same as startExternalSession)
    const userMsg: SessionMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    broadcast('chat:message-replay', { message: userMsg });
    allSessionMessages.push(userMsg);
    turnCompleted = false;
    currentAssistantText = '';
    currentTurnStartTime = Date.now();

    broadcast('chat:status', { sessionState: 'running' });
    await activeRuntime.sendMessage(activeProcess, text);
    return { queued: true };
  } catch (err) {
    return { queued: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Respond to a permission request from the external runtime
 */
export async function respondExternalPermission(
  requestId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  if (!activeProcess || !activeRuntime) {
    console.warn('[external-session] No active process for permission response');
    return;
  }
  await activeRuntime.respondPermission(activeProcess, requestId, approved, reason);
}

/**
 * Stop the active external session
 */
export async function stopExternalSession(): Promise<boolean> {
  if (!activeProcess || !activeRuntime) return false;
  try {
    await activeRuntime.stopSession(activeProcess);
    return true;
  } catch (err) {
    console.error('[external-session] Error stopping session:', err);
    activeProcess.kill();
    return true;
  } finally {
    activeProcess = null;
    activeRuntime = null;
    isRunning = false;
    // Notify IM stream callback if active (prevents orphaned SSE streams on user-stop)
    fireImCallback('error', 'Session stopped');
    broadcast('chat:status', { sessionState: 'idle' });
  }
}

/**
 * Check if an external session is active
 */
export function isExternalSessionActive(): boolean {
  return isRunning && activeProcess !== null && !activeProcess.exited;
}

/**
 * Query models for a given runtime type
 */
export async function queryRuntimeModels(runtimeType: RuntimeType): Promise<unknown[]> {
  if (runtimeType === 'builtin') return [];
  try {
    const runtime = getExternalRuntime(runtimeType);
    return await runtime.queryModels();
  } catch (err) {
    console.error(`[external-session] Failed to query models for ${runtimeType}:`, err);
    return [];
  }
}

/**
 * Get permission modes for a given runtime type
 */
export function getRuntimePermissionModes(runtimeType: RuntimeType): unknown[] {
  if (runtimeType === 'builtin') return [];
  try {
    const runtime = getExternalRuntime(runtimeType);
    return runtime.getPermissionModes();
  } catch {
    return [];
  }
}

// ─── Private: UnifiedEvent → SSE broadcast ───

function handleUnifiedEvent(event: UnifiedEvent): void {
  switch (event.kind) {
    case 'text_delta':
      broadcast('chat:message-chunk', event.text);
      currentAssistantText += event.text;
      fireImCallback('delta', event.text);
      break;

    case 'text_stop':
      // Text block ended
      fireImCallback('block-end', '');
      break;

    case 'thinking_start':
      broadcast('chat:thinking-start', { index: event.index });
      fireImCallback('activity', '');
      break;

    case 'thinking_delta':
      // Frontend expects { index, delta } — match builtin SSE shape
      broadcast('chat:thinking-chunk', { index: event.index, delta: event.text });
      break;

    case 'thinking_stop':
      // Emit content-block-stop so frontend closes the thinking block
      broadcast('chat:content-block-stop', { index: event.index, type: 'thinking' });
      break;

    case 'tool_use_start':
      broadcast('chat:tool-use-start', {
        id: event.toolUseId,
        name: event.toolName,
        input: {},
      });
      fireImCallback('activity', '');
      break;

    case 'tool_input_delta':
      broadcast('chat:tool-input-delta', {
        toolId: event.toolUseId,
        delta: event.delta,
      });
      break;

    case 'tool_use_stop':
      broadcast('chat:content-block-stop', {
        type: 'tool_use',
        toolId: event.toolUseId,
      });
      break;

    case 'tool_result':
      broadcast('chat:tool-result-start', {
        toolUseId: event.toolUseId,
        content: event.content,
        isError: event.isError ?? false,
      });
      break;

    case 'permission_request':
      broadcast('permission:request', {
        requestId: event.requestId,
        toolName: event.toolName,
        toolUseId: event.toolUseId,
        input: event.input,
      });
      fireImCallback('permission-request', JSON.stringify({
        requestId: event.requestId,
        toolName: event.toolName,
        input: event.input,
      }));
      break;

    case 'session_init':
      // Capture CC's session ID for multi-turn resume
      if (event.sessionId) lastRuntimeSessionId = event.sessionId;
      broadcast('chat:system-init', {
        info: {
          sessionId: event.sessionId,
          model: event.model,
          tools: event.tools,
        },
      });
      break;

    case 'status_change':
      broadcast('chat:status', { sessionState: event.state === 'running' ? 'running' : 'idle' });
      break;

    case 'turn_complete': {
      // Mark turn complete — session_complete will follow for -p mode
      turnCompleted = true;
      broadcast('chat:message-complete', {});
      broadcast('chat:status', { sessionState: 'idle' });
      fireImCallback('complete', '');

      // Persist assistant message to SessionStore
      if (currentAssistantText.trim()) {
        const assistantMsg: SessionMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: currentAssistantText,
          timestamp: new Date().toISOString(),
          durationMs: currentTurnStartTime ? Date.now() - currentTurnStartTime : undefined,
        };
        allSessionMessages.push(assistantMsg);
        currentAssistantText = '';
      }

      // Save cumulative messages to disk (saveSessionMessages uses .slice(existingCount) to append)
      // Do NOT clear allSessionMessages — it must grow across turns for the contract to work
      if (allSessionMessages.length > 0 && lastSessionId) {
        try {
          saveSessionMessages(lastSessionId, allSessionMessages);
          updateSessionMetadata(lastSessionId, {
            lastActiveAt: new Date().toISOString(),
            lastMessagePreview: allSessionMessages[allSessionMessages.length - 1]?.content?.slice(0, 100),
          });
        } catch (err) {
          console.error('[external-session] Failed to save session messages:', err);
        }
      }
      break;
    }

    case 'session_complete':
      if (event.subtype === 'success') {
        // CC slash commands (e.g. /context, /cost) return output directly in `result`
        // without streaming text_delta events. Only broadcast if NO turn completed
        // (turnCompleted means text was already streamed + persisted normally).
        if (event.result && !turnCompleted && !currentAssistantText.trim()) {
          broadcast('chat:message-chunk', event.result);
          currentAssistantText += event.result;
        }
        // Only broadcast if turn_complete didn't already
        if (!turnCompleted) {
          // Persist the result text as an assistant message
          if (currentAssistantText.trim()) {
            const assistantMsg: SessionMessage = {
              id: `assistant-${Date.now()}`,
              role: 'assistant',
              content: currentAssistantText,
              timestamp: new Date().toISOString(),
              durationMs: currentTurnStartTime ? Date.now() - currentTurnStartTime : undefined,
            };
            allSessionMessages.push(assistantMsg);
            currentAssistantText = '';

            if (allSessionMessages.length > 0 && lastSessionId) {
              try {
                saveSessionMessages(lastSessionId, allSessionMessages);
                updateSessionMetadata(lastSessionId, {
                  lastActiveAt: new Date().toISOString(),
                  lastMessagePreview: allSessionMessages[allSessionMessages.length - 1]?.content?.slice(0, 100),
                });
              } catch (err) {
                console.error('[external-session] Failed to save session messages:', err);
              }
            }
          }
          broadcast('chat:message-complete', {});
          fireImCallback('complete', '');
        }
      } else {
        broadcast('chat:message-error', event.result || 'Session ended with error');
        fireImCallback('error', event.result || 'Session ended with error');
      }
      broadcast('chat:status', { sessionState: 'idle' });
      // Clean up module state — prevents stuck sessions on CC crash
      isRunning = false;
      activeProcess = null;
      activeRuntime = null;
      break;

    case 'usage':
      // Token usage — could broadcast if needed
      break;

    case 'log':
      if (event.level === 'error') {
        console.error(`[external-runtime] ${event.message}`);
      } else {
        console.log(`[external-runtime] ${event.message}`);
      }
      break;

    case 'message_replay':
      // Skip assistant message replays during active streaming — CC sends both
      // stream_event deltas AND a complete assistant message, causing duplication.
      // Only replay user messages (for session resume scenarios).
      if (event.message.role === 'user') {
        broadcast('chat:message-replay', { message: event.message });
      }
      // Assistant replays are intentionally dropped — the stream_event deltas
      // already delivered the content to the frontend incrementally.
      break;

    case 'raw':
      // Unrecognized event — ignore
      break;
  }
}
