// OpenAI Bridge — main entry point
// Translates Anthropic Messages API → OpenAI Chat Completions API

export { createBridgeHandler, getProxyForUrl } from './handler';
export type { BridgeConfig, UpstreamConfig } from './types/bridge';
