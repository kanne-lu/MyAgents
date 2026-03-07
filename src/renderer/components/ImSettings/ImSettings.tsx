import React, { useCallback, useState } from 'react';
import { useConfig } from '@/hooks/useConfig';
import { isOpenClawPlatform } from '../../../shared/types/im';
import ImBotList from './ImBotList';
import ImBotDetail from './ImBotDetail';
import ImBotWizard from './ImBotWizard';
import OpenClawWizard from './OpenClawWizard';
import PlatformSelect from './PlatformSelect';
import type { ImPlatform } from '../../../shared/types/im';

type View =
    | { type: 'list' }
    | { type: 'detail'; botId: string }
    | { type: 'platform-select' }
    | { type: 'wizard'; platform: ImPlatform }
    | { type: 'openclaw-wizard' };

export default function ImSettings() {
    const { config, isLoading, refreshConfig } = useConfig();
    const [view, setView] = useState<View>({ type: 'list' });

    // Navigate to list view, refreshing config from disk first to ensure
    // any writes by child components (delete, wizard cancel) are picked up.
    const goToList = useCallback(async () => {
        await refreshConfig();
        setView({ type: 'list' });
    }, [refreshConfig]);

    const botConfigs = config.imBotConfigs ?? [];

    // Don't render until config is loaded from disk to avoid empty-state flash
    if (isLoading) return null;

    switch (view.type) {
        case 'list':
            return (
                <ImBotList
                    configs={botConfigs}
                    onAdd={() => setView({ type: 'platform-select' })}
                    onSelect={(id) => setView({ type: 'detail', botId: id })}
                />
            );
        case 'detail':
            return (
                <ImBotDetail
                    botId={view.botId}
                    onBack={goToList}
                />
            );
        case 'platform-select':
            return (
                <PlatformSelect
                    onSelect={(platform) => {
                        if (isOpenClawPlatform(platform)) {
                            setView({ type: 'openclaw-wizard' });
                        } else {
                            setView({ type: 'wizard', platform });
                        }
                    }}
                    onCancel={goToList}
                />
            );
        case 'wizard':
            return (
                <ImBotWizard
                    platform={view.platform}
                    onComplete={(id) => setView({ type: 'detail', botId: id })}
                    onCancel={() => setView({ type: 'platform-select' })}
                />
            );
        case 'openclaw-wizard':
            return (
                <OpenClawWizard
                    onComplete={(id) => setView({ type: 'detail', botId: id })}
                    onCancel={() => setView({ type: 'platform-select' })}
                />
            );
    }
}
