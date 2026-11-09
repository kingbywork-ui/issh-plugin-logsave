import { errorText } from './recorder'
import type { Gateway, PluginStorage } from './types'

export const DIRECTORY_KEY = 'logsave.directory'

export class Settings {
    directory = ''
    choosing = false
    error = ''
    recordingError = ''
    private active = true
    private listeners = new Set<() => void>()

    constructor (private gateway: Pick<Gateway, 'request' | 'log'>, private storage: PluginStorage) {
        try { this.directory = storage.get(DIRECTORY_KEY) ?? '' }
        catch (cause) { this.error = `读取日志目录失败：${errorText(cause)}` }
    }
    subscribe (listener: () => void): () => void {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }
    private notify (): void { for (const listener of this.listeners) listener() }
    reportRecordingError (message: string): void {
        this.recordingError = message
        this.notify()
        // The gateway may already be revoked during plugin deactivation.
        try { this.gateway.log('error', message) } catch { /* UI retains the error; no authority bypass. */ }
    }
    async chooseDirectory (): Promise<void> {
        if (!this.active || this.choosing) return
        this.choosing = true
        this.error = ''
        this.notify()
        try {
            // System dialogs commonly take longer than the gateway's default timeout.
            const directory = await this.gateway.request<string | null>('fs.logs.pickDirectory', {}, { timeoutMs: 300000 })
            if (!this.active || directory === null) return // Cancel must not change storage/configuration.
            if (typeof directory !== 'string' || !directory.trim()) throw new Error('目录选择器返回了无效路径')
            this.storage.set(DIRECTORY_KEY, directory) // Publish only after storage succeeds.
            this.directory = directory
        } catch (cause) {
            if (this.active) this.error = `选择或保存目录失败：${errorText(cause)}`
        } finally {
            this.choosing = false
            this.notify()
        }
    }
    dispose (): void { this.active = false; this.listeners.clear() }
}
