// ConfigProvider — single source of truth for app config state
// Dual Context pattern: data (changes often) vs actions (stable references)
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    type AppConfig,
    DEFAULT_CONFIG,
    type ModelEntity,
    type Project,
    type Provider,
    type ProviderVerifyStatus,
    PRESET_PROVIDERS,
} from './types';
import {
    loadAppConfig,
    atomicModifyConfig,
    ensureBundledWorkspace,
    mergePresetCustomModels,
} from './services/appConfigService';
import {
    getAllProviders,
    loadApiKeys as loadApiKeysService,
    saveApiKey as saveApiKeyService,
    deleteApiKey as deleteApiKeyService,
    loadProviderVerifyStatus as loadProviderVerifyStatusService,
    saveProviderVerifyStatus as saveProviderVerifyStatusService,
    saveCustomProvider as saveCustomProviderService,
    deleteCustomProvider as deleteCustomProviderService,
    rebuildAndPersistAvailableProviders,
} from './services/providerService';
import {
    loadProjects,
    addProject as addProjectService,
    updateProject as updateProjectService,
    patchProject as patchProjectService,
    removeProject as removeProjectService,
    touchProject as touchProjectService,
} from './services/projectService';
import { isTauriEnvironment } from '@/utils/browserMock';

// ============= Context Types =============

export interface ConfigDataValue {
    config: AppConfig;
    projects: Project[];
    providers: Provider[];
    apiKeys: Record<string, string>;
    providerVerifyStatus: Record<string, ProviderVerifyStatus>;
    isLoading: boolean;
    error: string | null;
}

export interface ConfigActionsValue {
    updateConfig: (updates: Partial<AppConfig>) => Promise<void>;
    refreshConfig: () => Promise<void>;
    reload: () => Promise<void>;
    refreshProviderData: () => Promise<void>;
    // Projects
    addProject: (path: string) => Promise<Project>;
    updateProject: (project: Project) => Promise<void>;
    patchProject: (projectId: string, updates: Partial<Omit<Project, 'id'>>) => Promise<void>;
    removeProject: (projectId: string) => Promise<void>;
    touchProject: (projectId: string) => Promise<void>;
    // Providers
    addCustomProvider: (provider: Provider) => Promise<void>;
    updateCustomProvider: (provider: Provider) => Promise<void>;
    deleteCustomProvider: (providerId: string) => Promise<void>;
    refreshProviders: () => Promise<void>;
    // Preset custom models
    savePresetCustomModels: (providerId: string, models: ModelEntity[]) => Promise<void>;
    removePresetCustomModel: (providerId: string, modelId: string) => Promise<void>;
    // API Keys
    saveApiKey: (providerId: string, apiKey: string) => Promise<void>;
    deleteApiKey: (providerId: string) => Promise<void>;
    // Verify status
    saveProviderVerifyStatus: (providerId: string, status: 'valid' | 'invalid', accountEmail?: string) => Promise<void>;
}

// ============= Contexts =============

export const ConfigDataContext = createContext<ConfigDataValue | null>(null);
export const ConfigActionsContext = createContext<ConfigActionsValue | null>(null);

// ============= Provider Component =============

export function ConfigProvider({ children }: { children: React.ReactNode }) {
    const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
    const [projects, setProjects] = useState<Project[]>([]);
    const [rawProviders, setRawProviders] = useState<Provider[]>(PRESET_PROVIDERS);
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [providerVerifyStatus, setProviderVerifyStatus] = useState<Record<string, ProviderVerifyStatus>>({});
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Derived: merge preset custom models
    const providers = useMemo(
        () => mergePresetCustomModels(rawProviders, config.presetCustomModels),
        [rawProviders, config.presetCustomModels]
    );

    // Mount guard
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    // ============= Load All Data =============

    const load = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            await ensureBundledWorkspace();

            const [loadedConfig, loadedProjects, loadedProviders, loadedApiKeys, loadedVerifyStatus] = await Promise.all([
                loadAppConfig(),
                loadProjects(),
                getAllProviders(),
                loadApiKeysService(),
                loadProviderVerifyStatusService(),
            ]);

            await rebuildAndPersistAvailableProviders();

            if (!isMountedRef.current) return;
            setConfig(loadedConfig);
            setProjects(loadedProjects);
            setRawProviders(loadedProviders);
            setApiKeys(loadedApiKeys);
            setProviderVerifyStatus(loadedVerifyStatus);
        } catch (err) {
            console.error('Failed to load config:', err);
            if (isMountedRef.current) {
                setError(err instanceof Error ? err.message : 'Failed to load configuration');
            }
        } finally {
            if (isMountedRef.current) {
                setIsLoading(false);
            }
        }
    }, []);

    // Initial load
    useEffect(() => {
        void load();
    }, [load]);

    // ============= Listen for im:bot-config-changed =============

    useEffect(() => {
        if (!isTauriEnvironment()) return;
        let cancelled = false;
        let unlisten: (() => void) | undefined;

        import('@tauri-apps/api/event').then(({ listen }) => {
            if (cancelled) return;
            listen<{ botId: string }>('im:bot-config-changed', () => {
                if (!isMountedRef.current) return;
                // Lightweight config-only refresh
                loadAppConfig().then(latest => {
                    if (isMountedRef.current) setConfig(latest);
                }).catch(err => {
                    console.error('[ConfigProvider] Failed to refresh config after bot-config-changed:', err);
                });
            }).then(fn => {
                if (cancelled) fn();
                else unlisten = fn;
            });
        });

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);

    // ============= Actions =============

    const updateConfig = useCallback(async (updates: Partial<AppConfig>) => {
        const newConfig = await atomicModifyConfig(c => ({ ...c, ...updates }));
        setConfig(newConfig);
        // No more CONFIG_CHANGED event — all consumers share this Context
    }, []);

    const refreshConfig = useCallback(async () => {
        try {
            const latest = await loadAppConfig();
            if (isMountedRef.current) setConfig(latest);
        } catch (err) {
            console.error('[ConfigProvider] Failed to refresh config:', err);
        }
    }, []);

    const refreshProviderData = useCallback(async () => {
        try {
            const [loadedApiKeys, loadedVerifyStatus] = await Promise.all([
                loadApiKeysService(),
                loadProviderVerifyStatusService(),
            ]);
            if (isMountedRef.current) {
                setApiKeys(loadedApiKeys);
                setProviderVerifyStatus(loadedVerifyStatus);
            }
        } catch (err) {
            console.error('[ConfigProvider] Failed to refresh provider data:', err);
        }
    }, []);

    const refreshProviders = useCallback(async () => {
        try {
            const loadedProviders = await getAllProviders();
            if (isMountedRef.current) setRawProviders(loadedProviders);
        } catch (err) {
            console.error('[ConfigProvider] Failed to refresh providers:', err);
        }
    }, []);

    // --- Projects ---

    const addProject = useCallback(async (path: string) => {
        const project = await addProjectService(path);
        setProjects((prev) => {
            const filtered = prev.filter((p) => p.id !== project.id);
            return [project, ...filtered];
        });
        return project;
    }, []);

    const updateProject = useCallback(async (project: Project) => {
        await updateProjectService(project);
        setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)));
    }, []);

    const patchProject = useCallback(async (projectId: string, updates: Partial<Omit<Project, 'id'>>) => {
        const updated = await patchProjectService(projectId, updates);
        if (updated) {
            setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
        }
    }, []);

    const removeProject = useCallback(async (projectId: string) => {
        await removeProjectService(projectId);
        setProjects((prev) => prev.filter((p) => p.id !== projectId));
    }, []);

    const touchProject = useCallback(async (projectId: string) => {
        const updated = await touchProjectService(projectId);
        if (updated) {
            setProjects((prev) => {
                const filtered = prev.filter((p) => p.id !== projectId);
                return [updated, ...filtered];
            });
        }
    }, []);

    // --- API Keys ---

    const saveApiKey = useCallback(async (providerId: string, apiKey: string) => {
        await saveApiKeyService(providerId, apiKey);
        setApiKeys((prev) => ({ ...prev, [providerId]: apiKey }));
        await rebuildAndPersistAvailableProviders();
    }, []);

    const deleteApiKey = useCallback(async (providerId: string) => {
        await deleteApiKeyService(providerId);
        setApiKeys((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        setProviderVerifyStatus((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        await rebuildAndPersistAvailableProviders();
    }, []);

    // --- Verify Status ---

    const saveProviderVerifyStatus = useCallback(async (
        providerId: string,
        status: 'valid' | 'invalid',
        accountEmail?: string
    ) => {
        await saveProviderVerifyStatusService(providerId, status, accountEmail);
        setProviderVerifyStatus((prev) => ({
            ...prev,
            [providerId]: {
                status,
                verifiedAt: new Date().toISOString(),
                accountEmail,
            },
        }));
    }, []);

    // --- Custom Providers ---

    const addCustomProvider = useCallback(async (provider: Provider) => {
        await saveCustomProviderService(provider);
        await refreshProviders();
        await rebuildAndPersistAvailableProviders();
    }, [refreshProviders]);

    const updateCustomProvider = useCallback(async (provider: Provider) => {
        await saveCustomProviderService(provider);
        await refreshProviders();
    }, [refreshProviders]);

    const deleteCustomProvider = useCallback(async (providerId: string) => {
        await deleteCustomProviderService(providerId);
        await deleteApiKeyService(providerId);
        await refreshProviders();
        setApiKeys((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        setProviderVerifyStatus((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        await rebuildAndPersistAvailableProviders();
    }, [refreshProviders]);

    // --- Preset Custom Models ---

    const savePresetCustomModels = useCallback(async (providerId: string, models: ModelEntity[]) => {
        const newConfig = await atomicModifyConfig(c => {
            const newPresetCustomModels = {
                ...c.presetCustomModels,
                [providerId]: models,
            };
            if (models.length === 0) {
                delete newPresetCustomModels[providerId];
            }
            return { ...c, presetCustomModels: newPresetCustomModels };
        });
        setConfig(newConfig);
        await rebuildAndPersistAvailableProviders();
    }, []);

    const removePresetCustomModel = useCallback(async (providerId: string, modelId: string) => {
        const newConfig = await atomicModifyConfig(c => {
            const currentModels = c.presetCustomModels?.[providerId] ?? [];
            const newModels = currentModels.filter(m => m.model !== modelId);
            const newPresetCustomModels = { ...c.presetCustomModels, [providerId]: newModels };
            if (newModels.length === 0) {
                delete newPresetCustomModels[providerId];
            }
            return { ...c, presetCustomModels: newPresetCustomModels };
        });
        setConfig(newConfig);
    }, []);

    // ============= Memoized Context Values =============

    const data = useMemo<ConfigDataValue>(() => ({
        config, projects, providers, apiKeys, providerVerifyStatus, isLoading, error,
    }), [config, projects, providers, apiKeys, providerVerifyStatus, isLoading, error]);

    const actions = useMemo<ConfigActionsValue>(() => ({
        updateConfig, refreshConfig, reload: load, refreshProviderData,
        addProject, updateProject, patchProject, removeProject, touchProject,
        addCustomProvider, updateCustomProvider, deleteCustomProvider, refreshProviders,
        savePresetCustomModels, removePresetCustomModel,
        saveApiKey, deleteApiKey,
        saveProviderVerifyStatus,
    }), [
        updateConfig, refreshConfig, load, refreshProviderData,
        addProject, updateProject, patchProject, removeProject, touchProject,
        addCustomProvider, updateCustomProvider, deleteCustomProvider, refreshProviders,
        savePresetCustomModels, removePresetCustomModel,
        saveApiKey, deleteApiKey,
        saveProviderVerifyStatus,
    ]);

    return (
        <ConfigActionsContext.Provider value={actions}>
            <ConfigDataContext.Provider value={data}>
                {children}
            </ConfigDataContext.Provider>
        </ConfigActionsContext.Provider>
    );
}
