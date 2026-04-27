import { execFile } from 'child_process';
import { join } from 'path';
import { readdirSync, existsSync } from 'fs';

const isWindows = process.platform === 'win32';
const PATH_SEPARATOR = isWindows ? ';' : ':';
const PATH_KEY = isWindows ? 'Path' : 'PATH';

/**
 * Common binary paths for the current platform
 */
function getFallbackPaths(): string[] {
    if (isWindows) {
        const userProfile = process.env.USERPROFILE || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        const programFiles = process.env.PROGRAMFILES || '';

        return [
            // ~/.myagents/bin — MUST be first so external runtime shell tools can find
            // the `myagents` CLI (runtime shell subprocess inherits this PATH via
            // augmentedProcessEnv → getShellEnv). Same reason as the Unix branch below.
            userProfile ? join(userProfile, '.myagents', 'bin') : '',
            userProfile ? join(userProfile, '.bun', 'bin') : '',
            localAppData ? join(localAppData, 'bun', 'bin') : '',
            programFiles ? join(programFiles, 'nodejs') : '',
            userProfile ? join(userProfile, 'AppData', 'Roaming', 'npm') : '',
            // Git for Windows — SDK requires git; PATH may be stale after NSIS install
            programFiles ? join(programFiles, 'Git', 'cmd') : '',
            join(process.env['PROGRAMFILES(X86)'] || '', 'Git', 'cmd'),
            localAppData ? join(localAppData, 'Programs', 'Git', 'cmd') : '',
        ].filter(Boolean);
    }

    // macOS/Linux paths — cover common package managers and version managers.
    // GUI apps don't inherit shell PATH, so we enumerate known binary directories.
    const home = process.env.HOME;
    const paths = [
        // ~/.myagents/bin — MUST be first so external runtime (Gemini/CC/Codex) shell
        // tools can find the `myagents` CLI. The builtin SDK path has its own
        // explicit injection in buildClaudeSessionEnv, but external runtimes rely
        // on getFallbackPaths via augmentedProcessEnv → getShellEnv.
        home ? `${home}/.myagents/bin` : '',
        '/opt/homebrew/bin',        // macOS Apple Silicon homebrew
        '/usr/local/bin',           // macOS Intel homebrew / Linux system
        home ? `${home}/.local/bin` : '',          // Claude Code / pipx / XDG user-local
        home ? `${home}/.bun/bin` : '',            // Bun global installs
        home ? `${home}/.npm-global/bin` : '',     // npm custom global prefix
        home ? `${home}/.cargo/bin` : '',          // Rust / cargo installs
        home ? `${home}/.volta/bin` : '',          // Volta (Node version manager)
        home ? `${home}/Library/pnpm` : '',        // pnpm (macOS)
    ];

    // Attempt to resolve NVM paths manually if exists.
    // Add ALL installed versions (sorted highest-first so the newest takes PATH priority).
    // Why all versions: `zsh -l -c` doesn't source .zshrc (non-interactive), so shell PATH
    // detection misses NVM. If we only add the highest version but the user installed
    // claude/codex on a different version, detection fails.
    if (process.env.HOME) {
        const nvmDir = join(process.env.HOME, '.nvm', 'versions', 'node');
        if (existsSync(nvmDir)) {
            try {
                const versions = readdirSync(nvmDir)
                    .filter(v => v.startsWith('v'))
                    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

                for (const v of versions) {
                    paths.push(join(nvmDir, v, 'bin'));
                }
                if (versions.length > 0) {
                    console.log('[shell] Found NVM node versions:', versions.join(', '));
                }
            } catch (e) {
                console.warn('[shell] Failed to resolve NVM paths:', e);
            }
        }

        const homeDir = process.env.HOME!; // narrowed by if-guard above

        // fnm (Fast Node Manager) — ~/.local/share/fnm/aliases/default/bin
        const fnmDir = join(homeDir, '.local', 'share', 'fnm', 'aliases', 'default', 'bin');
        if (existsSync(fnmDir)) paths.push(fnmDir);

        // asdf version manager — ~/.asdf/shims
        const asdfDir = join(homeDir, '.asdf', 'shims');
        if (existsSync(asdfDir)) paths.push(asdfDir);

        // mise (formerly rtx) — ~/.local/share/mise/shims
        const miseDir = join(homeDir, '.local', 'share', 'mise', 'shims');
        if (existsSync(miseDir)) paths.push(miseDir);
    }

    return paths.filter(Boolean);
}

/**
 * Builds the "fallback PATH": platform fallback directories ∪ process.env.PATH.
 * Pure string construction, always fast. Used on first access (before the
 * async shell-interactive detection completes) and as baseline prefix even
 * after detection — detected entries are appended, not replaced.
 */
function buildFallbackPath(): string {
    const fallback = getFallbackPaths().join(PATH_SEPARATOR);
    const existing = process.env[PATH_KEY] || process.env.PATH || '';
    return existing ? `${fallback}${PATH_SEPARATOR}${existing}` : fallback;
}

// Populated lazily with the fallback PATH on first sync read.
let cachedPath: string | null = null;
// Set once the async interactive-shell detection completes. Appended to
// the fallback PATH to form the enriched cached value.
let detectedUserPath: string | null = null;
// Promise guard — ensures exactly one concurrent execFile to the shell.
let warmupInFlight: Promise<void> | null = null;

/**
 * Synchronous PATH getter. Non-blocking by design:
 *   - First call returns the fallback PATH immediately
 *   - If background warmup has completed, returns fallback + detected user PATH
 *   - Never calls execSync (which would block the Node event loop and starve
 *     TCP accept during sidecar startup — measured 4-5s hang on slow .zshrc)
 *
 * Call `warmupShellPath()` once at process startup to kick off the async
 * interactive-shell detection. Callers that need the *detected* PATH (not just
 * fallback) and can wait should use `ensureShellPath()`.
 */
export function getShellPath(): string {
    if (cachedPath && detectedUserPath === null) {
        // Fallback-only cache. Return it; warmup may still be pending.
        return cachedPath;
    }
    if (cachedPath && detectedUserPath) {
        return cachedPath;
    }
    cachedPath = buildFallbackPath();
    return cachedPath;
}

/**
 * Returns an environment object with the corrected PATH.
 * Sync — uses whatever PATH `getShellPath()` can return right now.
 */
export function getShellEnv(): Record<string, string> {
    const path = getShellPath();
    const env = { ...process.env } as Record<string, string>;
    // Ensure single PATH key — Windows env may have Path or PATH;
    // spreading process.env into a plain object loses case-insensitivity,
    // so both casings can coexist and confuse child_process.spawn().
    delete env.PATH;
    delete env.Path;
    env[PATH_KEY] = path;
    return env;
}

/**
 * Awaitable PATH getter — waits for the interactive-shell detection if it's
 * still in flight, then returns the enriched PATH. Falls back to the sync
 * PATH on Windows or if detection failed.
 *
 * Use this from async user-initiated flows (e.g. MCP verify) where we'd rather
 * wait ~1-3s for a complete PATH than miss a user-installed binary.
 */
export async function ensureShellPath(): Promise<string> {
    if (warmupInFlight) await warmupInFlight;
    return getShellPath();
}

/**
 * Kick off interactive-shell PATH detection in the background.
 *
 * Why not synchronous (the way this used to work):
 *   User shells with heavy .zshrc (oh-my-zsh, p10k, conda, etc.) can take
 *   3-5 seconds to spawn interactively. execSync would block the Node event
 *   loop for that entire duration — and since Node's HTTP accept is serviced
 *   on the event loop, TCP connections from Rust's health check were silently
 *   queued. Sidecar startup appeared frozen until the shell returned.
 *
 * Now: `execFile` is used with a Promise-wrapped callback, so detection runs
 * asynchronously without blocking. Startup is instant; detection finishes
 * whenever the shell returns (or times out).
 *
 * Safe to call multiple times — subsequent calls no-op while the first
 * detection is in flight or after it has completed.
 */
export function warmupShellPath(): Promise<void> {
    if (warmupInFlight) return warmupInFlight;
    if (detectedUserPath !== null) return Promise.resolve(); // already done

    // Windows: no interactive-shell detection, just prime the fallback cache.
    if (isWindows) {
        detectedUserPath = '';
        cachedPath = buildFallbackPath();
        console.log('[shell] Windows PATH configured (fallback only)');
        return Promise.resolve();
    }

    warmupInFlight = new Promise<void>((resolve) => {
        const shell = process.env.SHELL || '/bin/zsh';
        const marker = `__MYAGENTS_PATH_${process.pid}__`;
        const cmd = `echo "${marker}\${PATH}${marker}"`;

        // -i interactive + -l login → sources both .zprofile and .zshrc (where
        // NVM/fnm/pnpm typically live). Marker isolates $PATH from noisy output
        // (MOTD, p10k banners, conda activation msgs).
        execFile(
            shell,
            ['-i', '-l', '-c', cmd],
            {
                encoding: 'utf-8',
                timeout: 5000,
                maxBuffer: 1024 * 1024,
            },
            (error, stdout) => {
                try {
                    if (error) {
                        console.warn(
                            '[shell] Interactive PATH detection failed, staying on fallback:',
                            error.message,
                        );
                        return;
                    }
                    const match = stdout.match(new RegExp(`${marker}(.+?)${marker}`));
                    if (match && match[1].length > 10) {
                        detectedUserPath = match[1];
                        cachedPath = `${buildFallbackPath()}${PATH_SEPARATOR}${detectedUserPath}`;
                        console.log('[shell] Detected user PATH via interactive shell');
                    }
                } finally {
                    // Make sure we don't leave warmupInFlight dangling; future
                    // sync callers still work off the fallback even if detection
                    // produced nothing useful.
                    detectedUserPath = detectedUserPath ?? '';
                    warmupInFlight = null;
                    resolve();
                }
            },
        );
    });
    return warmupInFlight;
}
