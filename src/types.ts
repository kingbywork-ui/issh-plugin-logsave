// 插件侧类型已收敛到统一 Gateway SDK（packages/issh-gateway/src/types）。
// 本文件仅保留 re-export 与命名 alias（Gateway / PluginStorage 在本插件源码中
// 以 Pick<Gateway, ...> / Pick<PluginStorage, ...> 方式按需窄化使用）。
// 历史差异说明：
// - TerminalDecoratorOptions：原本地为 SDK 的窄化子集（profile 仅 { host }、terminal 仅 element、
//   onOutput 返回 () => void）；SDK 形状为超集，宿主实参可直接赋值，行为不变。
// - Gateway：原本地 request 的 options 仅 { timeoutMs?: number }，为 SDK GatewayRequestOptions 子集。
export type {
    GatewayRequestOptions,
    IsshPlugin,
    IsshPluginContext,
    IsshPluginManifest,
    PluginStorage,
    TerminalDecoratorOptions,
} from '../../../packages/issh-gateway/src/types'
export type { PluginGateway as Gateway } from '../../../packages/issh-gateway/src/types'
