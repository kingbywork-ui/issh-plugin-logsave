// Local structural subset of the host API. No runtime import or Svelte dependency.
export interface IsshPluginManifest {
    id: string
    name: string
    version: string
    description: string
    kind: 'feature'
    minAppVersion: string
    entry: string
    gatewayApiVersion: string
    permissions: string[]
    capabilities: string[]
    author: string
}

export interface PluginStorage {
    get (key: string): string | null
    set (key: string, value: string): void
}

export interface TerminalDecoratorOptions {
    sessionId: string
    kind: 'local' | 'ssh'
    title: string
    profile: { host: string } | null
    terminal: { readonly element: HTMLElement | undefined }
    // Borrowed bytes, synchronously delivered by the host; copy before returning.
    // Optional solely to detect unsupported old hosts; never fall back to input/history.
    onOutput? (listener: (data: Uint8Array) => void): () => void
    dispose (callback: () => void): void
}

export interface Gateway {
    request<T = unknown> (method: string, args?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>
    ui: {
        registerSettingsTab (tab: {
            id: string; title: string; order?: number
            mount (target: HTMLElement): () => void
        }): () => void
        registerTerminalDecorator (decorator: {
            id: string; decorate (options: TerminalDecoratorOptions): void
        }): () => void
    }
    log (level: 'info' | 'warn' | 'error', message: string): void
}

export interface IsshPluginContext {
    gateway: Gateway
    storage: PluginStorage
}

export interface IsshPlugin {
    manifest: IsshPluginManifest
    activate (ctx: IsshPluginContext): void
    deactivate? (): void | Promise<void>
}
