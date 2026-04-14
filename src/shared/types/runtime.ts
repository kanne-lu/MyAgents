// Multi-Agent Runtime types (v0.1.59)
// Defines runtime types and metadata for external CLI agent integration

/**
 * Available Agent Runtime types
 * - builtin: Built-in Claude Agent SDK (current default)
 * - claude-code: Claude Code CLI (user-installed `claude`)
 * - codex: OpenAI Codex CLI (user-installed `codex`)
 * - gemini: Google Gemini CLI in ACP mode (user-installed `gemini`, v0.1.66+)
 */
export type RuntimeType = 'builtin' | 'claude-code' | 'codex' | 'gemini';

/**
 * Runtime detection result
 */
export interface RuntimeDetection {
  installed: boolean;
  version?: string;
  path?: string;
}

/**
 * All runtime detections keyed by type
 */
export type RuntimeDetections = Record<RuntimeType, RuntimeDetection>;

/**
 * Model info from an external runtime CLI
 */
export interface RuntimeModelInfo {
  value: string;        // Value passed to CLI (e.g., "sonnet", "o3")
  displayName: string;  // UI display name (e.g., "Sonnet 4.6")
  description?: string; // Optional description
  isDefault?: boolean;  // Mark as default selection
}

/**
 * Permission mode for an external runtime
 */
export interface RuntimePermissionMode {
  value: string;        // Value passed to CLI
  label: string;        // UI display label
  icon: string;         // Emoji icon
  description: string;  // Description text
}

/**
 * Runtime-specific configuration stored in AgentConfig
 */
export interface RuntimeConfig {
  model?: string;            // Runtime-specific model selection
  permissionMode?: string;   // Runtime-specific permission mode
  additionalArgs?: string[]; // Extra CLI arguments
}

/**
 * Runtime metadata for UI display
 */
export interface RuntimeInfo {
  type: RuntimeType;
  name: string;
  icon: string;           // Path to icon or built-in identifier
  detection: RuntimeDetection;
}

// ─── Claude Code permission modes ───

export const CC_PERMISSION_MODES: RuntimePermissionMode[] = [
  {
    value: 'default',
    label: 'Default',
    icon: '\u{1F6E1}',  // 🛡
    description: '每次工具调用都需要确认',
  },
  {
    value: 'plan',
    label: 'Plan',
    icon: '\u{1F4CB}',  // 📋
    description: '规划模式，只读不执行',
  },
  {
    value: 'acceptEdits',
    label: 'Accept Edits',
    icon: '\u{1F4DD}',  // 📝
    description: '自动接受文件编辑，其他需确认',
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass Permissions',
    icon: '\u26A1',      // ⚡
    description: '跳过所有权限确认',
  },
];

// ─── Gemini CLI permission modes (ACP session modes, v0.1.66) ───
//
// These map 1:1 to Gemini CLI's ACP session/new response `modes.availableModes[]`:
//   default  → "Prompts for approval"
//   autoEdit → "Auto-approves edit tools"
//   yolo     → "Auto-approves all tools"
//   plan     → "Read-only mode"
// We keep the internal value equal to Gemini's modeId to avoid a mapping table.

export const GEMINI_PERMISSION_MODES: RuntimePermissionMode[] = [
  {
    value: 'default',
    label: 'Default',
    icon: '\u{1F6E1}',  // 🛡
    description: '每次工具调用都需要确认',
  },
  {
    value: 'autoEdit',
    label: 'Auto Edit',
    icon: '\u{1F4DD}',  // 📝
    description: '自动接受文件编辑,其他需确认',
  },
  {
    value: 'yolo',
    label: 'YOLO',
    icon: '\u26A1',      // ⚡
    description: '跳过所有工具确认',
  },
  {
    value: 'plan',
    label: 'Plan',
    icon: '\u{1F4CB}',  // 📋
    description: '规划模式,只读不执行',
  },
];

// ─── Codex permission modes (pre-defined for v2) ───

export const CODEX_PERMISSION_MODES: RuntimePermissionMode[] = [
  {
    value: 'suggest',
    label: 'Suggest',
    icon: '\u{1F50D}',  // 🔍
    description: '仅信任的命令自动执行，其他需确认',
  },
  {
    value: 'auto-edit',
    label: 'Auto-Edit',
    icon: '\u{1F4DD}',  // 📝
    description: '自动编辑文件，沙箱内执行命令',
  },
  {
    value: 'full-auto',
    label: 'Full Auto',
    icon: '\u26A1',      // ⚡
    description: '沙箱内自主执行，按需询问',
  },
  {
    value: 'no-restrictions',
    label: 'No Restrictions',
    icon: '\u{1F513}',  // 🔓
    description: '跳过所有审批和沙箱限制',
  },
];

/**
 * Get permission modes for a given runtime type
 */
export function getRuntimePermissionModes(runtime: RuntimeType): RuntimePermissionMode[] {
  switch (runtime) {
    case 'claude-code': return CC_PERMISSION_MODES;
    case 'codex': return CODEX_PERMISSION_MODES;
    case 'gemini': return GEMINI_PERMISSION_MODES;
    default: return [];
  }
}

// ─── Claude Code model list (canonical, shared) ───

export const CC_MODELS: RuntimeModelInfo[] = [
  { value: '', displayName: '默认', isDefault: true },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'haiku', displayName: 'Haiku' },
];

// Note: no static GEMINI_MODELS export (unlike CC_MODELS). Gemini's model
// list is fetched dynamically via /api/runtime/models?type=gemini →
// GeminiRuntime.queryModels() → short-lived `gemini --acp` handshake that
// reads `result.models.availableModels` from the session/new response.
// Launcher.tsx and Chat.tsx hold their own `geminiModels` useState seeded
// to [] and populated on the first mount.

/**
 * Get default permission mode for a given runtime type
 */
export function getDefaultRuntimePermissionMode(runtime: RuntimeType): string {
  switch (runtime) {
    case 'claude-code': return 'default';
    case 'codex': return 'full-auto';
    case 'gemini': return 'autoEdit';  // D5: desktop default = Auto Edit
    default: return '';
  }
}
