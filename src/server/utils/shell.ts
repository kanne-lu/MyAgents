import { execSync } from 'child_process';
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

let cachedPath: string | null = null;

/**
 * Detects the user's full shell PATH.
 * Essential for GUI apps (like Tauri) on macOS which don't inherit the user's shell environment.
 */
export function getShellPath(): string {
    if (cachedPath) return cachedPath;

    const fallback = getFallbackPaths().join(PATH_SEPARATOR);

    // On Windows, just use existing PATH with fallback paths prepended
    if (isWindows) {
        const existing = process.env[PATH_KEY] || process.env.PATH || '';
        cachedPath = existing ? `${fallback}${PATH_SEPARATOR}${existing}` : fallback;
        console.log('[shell] Windows PATH configured');
        return cachedPath;
    }

    // macOS/Linux: Detect shell PATH by spawning an interactive login shell.
    //
    // Why `-i` (interactive) is required:
    //   zsh -l -c  → non-interactive login → sources .zprofile but NOT .zshrc
    //   zsh -i -l -c → interactive login  → sources .zprofile AND .zshrc
    // NVM/fnm/pnpm etc. are almost always loaded in .zshrc, so without `-i` their
    // paths are missing — exactly the user's bug report (claude/codex "not installed").
    //
    // Marker extraction: `-i` can produce extra output (MOTD, prompt frameworks like
    // p10k/oh-my-zsh, conda banners). We wrap $PATH in unique markers and extract
    // only the content between them, making us immune to noisy .zshrc output.
    //
    // Safety: stdin is /dev/null (interactive shell gets EOF → exits), timeout guards
    // against .zshrc that launches tmux/screen. Fallback paths provide a safety net.
    try {
        const shell = process.env.SHELL || '/bin/zsh';
        const marker = `__MYAGENTS_PATH_${process.pid}__`;
        // NOTE: Must use ${PATH} (braced) — unbraced $PATH__MARKER__ is parsed as one
        // variable name by the shell because underscores are valid in identifiers.
        const raw = execSync(`${shell} -i -l -c 'echo "${marker}\${PATH}${marker}"'`, {
            encoding: 'utf-8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore']
        });

        const match = raw.match(new RegExp(`${marker}(.+?)${marker}`));
        if (match && match[1].length > 10) {
            const detectedPath = match[1];
            console.log('[shell] Detected user PATH via interactive shell');
            cachedPath = `${fallback}${PATH_SEPARATOR}${detectedPath}`;
            return cachedPath;
        }
    } catch (error) {
        console.warn('[shell] Failed to detect shell PATH via interactive shell:', error);
    }

    // Fallback
    console.log('[shell] Using fallback PATH construction ONLY');
    const existing = process.env[PATH_KEY] || process.env.PATH || '';
    cachedPath = existing ? `${fallback}${PATH_SEPARATOR}${existing}` : fallback;
    console.log('[shell] Fallback PATH:', cachedPath);
    return cachedPath!;
}

/**
 * Returns an environment object with the corrected PATH
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
