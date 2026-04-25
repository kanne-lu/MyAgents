// Infrastructure layer — async locks, safe file I/O, config directory management
import {
    copyFile,
    exists,
    mkdir,
    readTextFile,
    writeTextFile,
    remove,
    rename,
} from '@tauri-apps/plugin-fs';
import { homeDir, join, dirname } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { isBrowserDevMode } from '@/utils/browserMock';
import { stripBom } from '../../../shared/utils';

// Re-export for convenience
export { isBrowserDevMode };

// ============= Async Lock =============

export function createAsyncLock() {
    let queue: Promise<void> = Promise.resolve();
    return function withLock<T>(fn: () => Promise<T>): Promise<T> {
        let release: () => void;
        const next = new Promise<void>(resolve => { release = resolve; });
        const prev = queue;
        queue = next;
        return prev.then(fn).finally(() => release!());
    };
}

export const withProjectsLock = createAsyncLock();
const withConfigProcessLock = createAsyncLock();

const CONFIG_LOCK_TIMEOUT_MS = 5000;
const CONFIG_LOCK_POLL_MS = 50;
const CONFIG_LOCK_STALE_MS = 30000;

export class ConfigBusyError extends Error {
    readonly code = 'CONFIG_BUSY';

    constructor(message = 'Config busy: could not acquire config.json.lock within 5000ms; retry') {
        super(message);
        this.name = 'ConfigBusyError';
    }
}

// ============= Constants =============

export const CONFIG_DIR_NAME = '.myagents';
export const CONFIG_FILE = 'config.json';
export const PROJECTS_FILE = 'projects.json';
export const PROVIDERS_DIR = 'providers';

export async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    return withConfigProcessLock(async () => {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const configPath = await join(dir, CONFIG_FILE);
        return withFileLock(configPath, fn);
    });
}

// ============= Safe File I/O Utilities =============

/**
 * Atomically write JSON data to a file with .bak backup.
 *
 * Steps:
 * 1. Write to .tmp (if interrupted here, original file is untouched)
 * 2. Copy current file → .bak (best-effort backup; main file stays intact)
 * 3. Rename .tmp → target (atomic overwrite — main is never absent)
 *
 * Key invariant: the main file is never removed. rename() atomically replaces
 * the destination on both POSIX (rename syscall) and Windows (MOVEFILE_REPLACE_EXISTING).
 * This eliminates the window where concurrent readers would see "file not found".
 */
export async function safeWriteJson(filePath: string, data: unknown): Promise<void> {
    const tmpPath = filePath + '.tmp';
    const bakPath = filePath + '.bak';
    const content = JSON.stringify(data, null, 2);

    // 1. Write new data to .tmp
    await writeTextFile(tmpPath, content);
    await fsyncPath(tmpPath, false);

    // 2. Backup current file → .bak (best-effort, copy preserves main)
    try {
        if (await exists(filePath)) {
            if (await exists(bakPath)) {
                await remove(bakPath);
            }
            await copyFile(filePath, bakPath);
        }
    } catch (bakErr) {
        console.warn('[configStore] Failed to create .bak backup:', bakErr);
    }

    // 3. Atomic overwrite: .tmp → target (main file is never absent)
    await rename(tmpPath, filePath);
    await fsyncPath(await dirname(filePath), true);
}

/**
 * Load and parse a JSON file with automatic recovery from .bak and .tmp.
 *
 * Read-only: this function never writes files. Recovery from .bak/.tmp is
 * transparent — the next safeWriteJson call will overwrite main with fresh data.
 * This avoids race conditions where a "recovery write" inside a read could
 * conflict with a concurrent writer holding the config lock.
 */
export async function safeLoadJson<T>(
    filePath: string,
    validate?: (data: unknown) => data is T,
): Promise<T | null> {
    const candidates = [
        { path: filePath, label: 'main' },
        { path: filePath + '.bak', label: 'bak' },
        { path: filePath + '.tmp', label: 'tmp' },
    ];

    for (const { path, label } of candidates) {
        if (!(await exists(path))) continue;
        try {
            const content = await readTextFile(path);
            const parsed = JSON.parse(stripBom(content));
            if (validate && !validate(parsed)) {
                console.error(`[configStore] ${label} file has invalid structure, skipping`);
                continue;
            }
            if (label !== 'main') {
                console.warn(`[configStore] Recovered data from .${label} file (next write will restore main)`);
            }
            return parsed as T;
        } catch (err) {
            console.error(`[configStore] ${label} file corrupted or unreadable:`, err);
        }
    }
    return null;
}

// ============= Config Directory =============

let configDirPath: string | null = null;

export async function getConfigDir(): Promise<string> {
    if (configDirPath) return configDirPath;

    const home = await homeDir();
    configDirPath = await join(home, CONFIG_DIR_NAME);
    console.log('[configStore] Config directory:', configDirPath);
    return configDirPath;
}

export async function ensureConfigDir(): Promise<void> {
    const dir = await getConfigDir();
    if (!(await exists(dir))) {
        console.log('[configStore] Creating config directory:', dir);
        await mkdir(dir, { recursive: true });
    }

    const providersDir = await join(dir, PROVIDERS_DIR);
    if (!(await exists(providersDir))) {
        await mkdir(providersDir, { recursive: true });
    }
}

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = filePath + '.lock';
    await acquireFileLock(lockDir);
    try {
        return await fn();
    } finally {
        await releaseFileLock(lockDir);
    }
}

async function acquireFileLock(lockDir: string): Promise<void> {
    const start = Date.now();
    while (true) {
        try {
            await mkdir(lockDir);
            try {
                await writeTextFile(await join(lockDir, 'owner'), `renderer:${Date.now()}\n`);
            } catch {
                // Owner file is diagnostic only.
            }
            return;
        } catch {
            // mkdir failed — lock dir already exists. Try stale-recovery before
            // sleeping. The renderer can't observe other processes' pids, so it
            // relies on the renderer-written owner timestamp (`renderer:<ts>`)
            // and falls through to age-based break for non-renderer owners (a
            // node/rust crash leaves a long-stale dir; 30s is generous).
            if (await tryBreakStaleLock(lockDir)) {
                continue;
            }

            if (Date.now() - start >= CONFIG_LOCK_TIMEOUT_MS) {
                throw new ConfigBusyError();
            }
            await delay(CONFIG_LOCK_POLL_MS);
        }
    }
}

async function tryBreakStaleLock(lockDir: string): Promise<boolean> {
    let owner = '';
    try {
        owner = (await readTextFile(await join(lockDir, 'owner'))).trim();
    } catch {
        // No owner file — fall back to "exists but no metadata" → don't break.
        return false;
    }

    // renderer:<ts> — compare the embedded ts to wall clock.
    const m = /^renderer:(\d+)$/.exec(owner);
    let ageMs: number | null = null;
    if (m) {
        const ts = Number(m[1]);
        if (Number.isFinite(ts)) ageMs = Date.now() - ts;
    } else if (/^(node|rust):\d+$/.test(owner)) {
        // We can't probe pid liveness from the renderer; assume staleness purely
        // by age. This is safe because the Node/Rust helpers also break their
        // own stale locks on the next acquire — at worst we race with their
        // recovery, and the loser just retries.
        // No reliable timestamp from the owner string alone; skip in this branch.
        return false;
    } else {
        return false;
    }

    if (ageMs === null || ageMs <= CONFIG_LOCK_STALE_MS) return false;

    console.warn(`[configStore] Breaking stale lock ${lockDir} (age=${ageMs}ms owner=${owner})`);
    try {
        await remove(lockDir, { recursive: true });
        return true;
    } catch {
        return false;
    }
}

async function releaseFileLock(lockDir: string): Promise<void> {
    try {
        await remove(lockDir, { recursive: true });
    } catch {
        // Best-effort unlock. Timeout errors on future acquisitions make this visible.
    }
}

async function fsyncPath(path: string, directory: boolean): Promise<void> {
    if (isBrowserDevMode()) return;
    await invoke('cmd_fsync_path', { path, directory });
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
