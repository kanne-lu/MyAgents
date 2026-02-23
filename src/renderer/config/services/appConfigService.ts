// AppConfig core — load, save, atomicModify, migration, availableProviders, bundledWorkspace
import { join } from '@tauri-apps/api/path';

import {
    type AppConfig,
    DEFAULT_CONFIG,
    type Provider,
} from '../types';
import {
    isBrowserDevMode,
    withConfigLock,
    ensureConfigDir,
    getConfigDir,
    CONFIG_FILE,
    safeLoadJson,
    safeWriteJson,
} from './configStore';
import {
    mockLoadConfig,
    mockSaveConfig,
} from '@/utils/browserMock';
import { type ImBotConfig, DEFAULT_IM_BOT_CONFIG } from '../../../shared/types/im';
import { isDebugMode } from '@/utils/debug';

// ============= Validation =============

function isValidAppConfig(data: unknown): data is AppConfig {
    return data !== null && typeof data === 'object' && !Array.isArray(data);
}

// ============= IM Bot Migration =============

let _imBotMigrationDone = false;

export function migrateImBotConfig(config: AppConfig): AppConfig {
    if (config.imBotConfig && !config.imBotConfigs && !_imBotMigrationDone) {
        _imBotMigrationDone = true;
        const legacy = config.imBotConfig;
        const migrated: ImBotConfig = {
            ...DEFAULT_IM_BOT_CONFIG,
            ...legacy,
            id: legacy.id || crypto.randomUUID(),
            name: legacy.name || 'Telegram Bot',
            platform: legacy.platform || 'telegram',
            setupCompleted: true,
        };
        config.imBotConfigs = [migrated];
        delete config.imBotConfig;
        saveAppConfig(config).catch(err => {
            console.error('[configService] Failed to persist imBotConfig migration:', err);
        });
    }
    return config;
}

// ============= Load / Save =============

export async function loadAppConfig(): Promise<AppConfig> {
    const dynamicDefault: AppConfig = {
        ...DEFAULT_CONFIG,
        showDevTools: isDebugMode(),
    };

    if (isBrowserDevMode()) {
        console.log('[configService] Browser mode: loading from localStorage');
        const loaded = mockLoadConfig();
        return { ...dynamicDefault, ...loaded };
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const configPath = await join(dir, CONFIG_FILE);

        const loaded = await safeLoadJson<AppConfig>(configPath, isValidAppConfig);
        if (loaded) {
            const merged = { ...dynamicDefault, ...loaded };
            return migrateImBotConfig(merged);
        }
        return dynamicDefault;
    } catch (error) {
        console.error('[configService] Failed to load app config:', error);
        return dynamicDefault;
    }
}

export async function saveAppConfig(config: AppConfig): Promise<void> {
    if (isBrowserDevMode()) {
        mockSaveConfig(config);
        return;
    }

    return withConfigLock(async () => {
        try {
            await _writeAppConfigLocked(config);
        } catch (error) {
            console.error('[configService] Failed to save app config:', error);
            throw error;
        }
    });
}

/**
 * Atomically read-modify-write the app config.
 */
export async function atomicModifyConfig(
    modifier: (config: AppConfig) => AppConfig,
): Promise<AppConfig> {
    if (isBrowserDevMode()) {
        const latest = await loadAppConfig();
        const modified = modifier(latest);
        mockSaveConfig(modified);
        return modified;
    }
    return withConfigLock(async () => {
        const latest = await loadAppConfig();
        const modified = modifier(latest);
        await _writeAppConfigLocked(modified);
        return modified;
    });
}

/**
 * Internal: write config to disk without acquiring withConfigLock.
 * MUST only be called from within a withConfigLock block.
 */
async function _writeAppConfigLocked(config: AppConfig): Promise<void> {
    if (isBrowserDevMode()) {
        mockSaveConfig(config);
        return;
    }
    await ensureConfigDir();
    const dir = await getConfigDir();
    const configPath = await join(dir, CONFIG_FILE);
    await safeWriteJson(configPath, config);
}

// ============= Available Providers Cache =============

// Forward declarations for circular-dependency-free import
// These are passed in from providerService via rebuildAndPersistAvailableProviders below
import type { ModelEntity } from '../types';

/**
 * Merge preset custom models into providers.
 * Shared utility used by both providerService and this module.
 */
export function mergePresetCustomModels(
    providers: Provider[],
    presetCustomModels: Record<string, ModelEntity[]> | undefined,
): Provider[] {
    if (!presetCustomModels || Object.keys(presetCustomModels).length === 0) {
        return providers;
    }
    return providers.map(provider => {
        if (!provider.isBuiltin) return provider;
        const customModels = presetCustomModels[provider.id];
        if (!customModels || customModels.length === 0) return provider;
        return {
            ...provider,
            models: [...provider.models, ...customModels],
        };
    });
}

// ============= Bundled Workspace =============

let _bundledWorkspaceChecked = false;

export async function ensureBundledWorkspace(): Promise<boolean> {
    if (_bundledWorkspaceChecked) return false;
    _bundledWorkspaceChecked = true;

    if (isBrowserDevMode()) return false;

    try {
        // Lazy import to break circular dep (addProject is in projectService)
        const { addProject } = await import('./projectService');
        const { loadProjects } = await import('./projectService');

        const { invoke } = await import('@tauri-apps/api/core');
        const result = await invoke<{ path: string; is_new: boolean }>('cmd_initialize_bundled_workspace');

        if (result.is_new) {
            await addProject(result.path);
            await withConfigLock(async () => {
                const config = await loadAppConfig();
                if (!config.defaultWorkspacePath) {
                    await _writeAppConfigLocked({ ...config, defaultWorkspacePath: result.path });
                }
            });
            console.log('[configService] Bundled workspace initialized:', result.path);
            return true;
        }

        const projects = await loadProjects();
        const normalizedResult = result.path.replace(/\\/g, '/');
        const found = projects.some(p => p.path.replace(/\\/g, '/') === normalizedResult);
        if (!found) {
            await addProject(result.path);
            console.log('[configService] Bundled workspace recovered into projects:', result.path);
            return true;
        }

        return false;
    } catch (err) {
        console.warn('[configService] ensureBundledWorkspace failed:', err);
        return false;
    }
}
