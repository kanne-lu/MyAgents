/**
 * Promoted Plugins — community plugins that get first-class UI treatment.
 *
 * These are technically OpenClaw Channel Plugins (running via Plugin Bridge),
 * but displayed as built-in platforms with custom icons, branding, and setup guidance.
 */

import qqbotIcon from './assets/qqbot.png';
import qqbotStep1Img from './assets/qqbot_step1_index.png';
import qqbotStep2Img from './assets/qqbot_step2_credentials.png';
import feishuIcon from './assets/feishu.jpeg';
import feishuStep1Img from './assets/feishu_step1.png';
import feishuStep2EventsImg from './assets/feishu_step2_events.png';
import feishuStep2PermissionsImg from './assets/feishu_step2_permissions.png';
import feishuStep2AddBotImg from './assets/feishu_step2_5_add_bot.png';
import weixinIcon from './assets/weixin.svg';

export interface PromotedPlugin {
    /** Plugin ID — must match InstalledPlugin.pluginId after installation */
    pluginId: string;
    /** npm package spec for auto-install */
    npmSpec: string;
    /** Display name */
    name: string;
    /** Short description shown on platform card */
    description: string;
    /** Icon asset (imported image path) */
    icon: string;
    /** Brand color for badges and accents */
    platformColor: string;
    /** Optional badge type for promoted plugins */
    badge?: 'official' | 'community';
    /** Required config field keys (pre-populate in wizard if plugin's isConfigured pattern is non-standard) */
    requiredFields?: string[];
    /** Default config values merged into pluginConfig when creating a new channel */
    defaultConfig?: Record<string, string>;
    /**
     * Authentication type:
     * - 'config' (default): user fills config fields (appId, appSecret, etc.)
     * - 'qrLogin': user scans QR code to login (e.g. WeChat)
     * Auto-detected for custom plugins via Bridge /capabilities supportsQrLogin.
     */
    authType?: 'config' | 'qrLogin';
    /** Custom setup guidance for the wizard config step */
    setupGuide?: {
        /** Section title in config panel (e.g. "QQ Bot 应用凭证") */
        credentialTitle: string;
        /** Helper text above config inputs */
        credentialHint: string;
        /** Link URL for the credential hint text */
        credentialHintLink?: string;
        /** Step-by-step image guide shown below config inputs */
        steps?: Array<{
            /** Step image asset */
            image: string;
            /** Alt text for the image */
            alt: string;
            /** Caption / description shown above the image */
            caption: string;
            /** Optional: text within caption to make a link */
            captionLinkText?: string;
            /** Optional: URL for the caption link */
            captionLinkUrl?: string;
        }>;
    };
}

export const PROMOTED_PLUGINS: PromotedPlugin[] = [
    {
        pluginId: 'openclaw-lark',
        npmSpec: '@larksuite/openclaw-lark',
        name: '飞书 Bot（官方插件）',
        description: '飞书开放平台官方 OpenClaw 插件，支持文档/表格/日历等深度集成',
        icon: feishuIcon,
        platformColor: '#3370FF',
        badge: 'official',
        requiredFields: ['appId', 'appSecret'],
        defaultConfig: {
            streaming: 'true',
        },
        setupGuide: {
            credentialTitle: '飞书应用凭证',
            credentialHint: '前往飞书开放平台创建自建应用，获取 App ID 和 App Secret',
            credentialHintLink: 'https://open.feishu.cn/app',
            steps: [
                {
                    image: feishuStep1Img,
                    alt: '飞书开放平台 — 创建自建应用',
                    caption: '1. 前往飞书开放平台，创建企业自建应用',
                    captionLinkText: '飞书开放平台',
                    captionLinkUrl: 'https://open.feishu.cn/app',
                },
                {
                    image: feishuStep2EventsImg,
                    alt: '飞书应用 — 配置事件订阅',
                    caption: '2. 在「事件订阅」中启用所需事件',
                },
                {
                    image: feishuStep2PermissionsImg,
                    alt: '飞书应用 — 配置权限',
                    caption: '3. 在「权限管理」中开通所需权限',
                },
                {
                    image: feishuStep2AddBotImg,
                    alt: '飞书应用 — 添加机器人能力',
                    caption: '4. 在「应用能力」中添加「机器人」能力',
                },
            ],
        },
    },
    {
        pluginId: 'qqbot',
        npmSpec: '@sliverp/qqbot',
        name: 'QQ Bot',
        description: '通过 QQ Bot 远程使用 AI Agent',
        icon: qqbotIcon,
        platformColor: '#12B7F5',
        setupGuide: {
            credentialTitle: 'QQ Bot 应用凭证',
            credentialHint: '前往 QQ 开放平台创建应用，获取 AppID 和 AppSecret',
            credentialHintLink: 'https://q.qq.com/qqbot/openclaw/',
            steps: [
                {
                    image: qqbotStep1Img,
                    alt: 'QQ Bot 快速开始 — 扫码注册登录、创建机器人',
                    caption: '1. 扫码注册登录 QQ Bot 开放平台，创建机器人',
                    captionLinkText: 'QQ Bot 开放平台',
                    captionLinkUrl: 'https://q.qq.com/qqbot/openclaw/',
                },
                {
                    image: qqbotStep2Img,
                    alt: 'QQ Bot 凭证 — 获取 AppID 和 AppSecret',
                    caption: '2. 在机器人管理页获取 AppID 和 AppSecret，填入上方',
                },
            ],
        },
    },
    {
        pluginId: 'openclaw-weixin',
        npmSpec: '@tencent-weixin/openclaw-weixin',
        name: '微信',
        description: '通过微信聊天使用 AI Agent，扫码即可连接',
        icon: weixinIcon,
        platformColor: '#07C160',
        badge: 'official',
        authType: 'qrLogin',
    },
];

/** Find a promoted plugin definition by pluginId */
export function findPromotedPlugin(pluginId: string | undefined): PromotedPlugin | undefined {
    if (!pluginId) return undefined;
    return PROMOTED_PLUGINS.find(p => p.pluginId === pluginId);
}

/** Find a promoted plugin by platform string (e.g. "openclaw:qqbot") */
export function findPromotedByPlatform(platform: string): PromotedPlugin | undefined {
    if (!platform.startsWith('openclaw:')) return undefined;
    const channelId = platform.slice('openclaw:'.length);
    return PROMOTED_PLUGINS.find(p => p.pluginId === channelId);
}
