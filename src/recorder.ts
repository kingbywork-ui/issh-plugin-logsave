import type { Gateway, TerminalDecoratorOptions } from './types'

export const APPEND_BYTES = 32 * 1024
export const MAX_BUFFER_BYTES = 1024 * 1024 // Includes the one in-flight append.
export const FLUSH_INTERVAL_MS = 100
export const UNSUPPORTED = '当前宿主不支持终端输出订阅；请使用含 onOutput 与 fs.logs.* 接口的 0.2.1 或更新宿主。'

export type RecordingPhase = 'off' | 'opening' | 'recording' | 'stopping' | 'error' | 'disposed'
export interface RecordingState {
    phase: RecordingPhase
    path: string
    error: string
    bufferedBytes: number
    writtenBytes: number
}

export function errorText (cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause)
}

export function makeFileName (kind: 'local' | 'ssh', host?: string): string {
    const value = host?.trim().replace(/^\[([^\]]+)\]$/, '$1') ?? ''
    const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(x => Number(x) <= 255)
    const ipv6 = value.includes(':') && /^[a-f\d:]+(?:%[\w.-]+)?$/i.test(value)
    const domain = value.replace(/\.$/, '')
    const safeDomain = domain.length <= 253 && domain.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)) ? domain : 'host'
    // Configured host only: safe ASCII labels, no paths, DNS lookup, username or title.
    const prefix = kind === 'local' ? 'local' : ipv4 || ipv6 ? value.replace(/[^a-z\d.-]/gi, '-') : safeDomain
    const random = new Uint8Array(8)
    globalThis.crypto.getRandomValues(random)
    const suffix = Array.from(random, x => x.toString(16).padStart(2, '0')).join('')
    return `${prefix.slice(0, 96)}_${new Date().toISOString().replace(/:/g, '-')}_${suffix}.log`
}

function toBase64 (bytes: Uint8Array): string {
    // Never decode/re-encode UTF-8. Chunk boundaries may split a multibyte glyph.
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
}

/** One worker and one bounded ring per recording, not a promise per output event. */
export class Recorder {
    private state: RecordingState = { phase: 'off', path: '', error: '', bufferedBytes: 0, writtenBytes: 0 }
    private listeners = new Set<() => void>()
    private worker: Promise<void> | null = null
    private wanted = false
    private disposed = false
    private unsubscribe: (() => void) | null = null
    private wake: (() => void) | null = null
    private ring: Uint8Array | null = null
    private head = 0
    private size = 0
    private inFlight = 0

    constructor (
        private gateway: Pick<Gateway, 'request'>,
        private terminal: Pick<TerminalDecoratorOptions, 'kind' | 'profile' | 'onOutput'>,
        private getDirectory: () => string,
        private onError: (message: string) => void,
    ) {
        if (!terminal.onOutput) this.state = { ...this.state, phase: 'error', error: UNSUPPORTED }
    }

    snapshot (): Readonly<RecordingState & { busy: boolean }> {
        return { ...this.state, bufferedBytes: this.size + this.inFlight, busy: this.worker !== null }
    }
    subscribe (listener: () => void): () => void {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }
    private notify (): void {
        this.state.bufferedBytes = this.size + this.inFlight
        for (const listener of this.listeners) listener()
    }
    private detach (): void {
        const unsubscribe = this.unsubscribe
        this.unsubscribe = null
        if (unsubscribe) {
            try { unsubscribe() } catch (cause) { this.fail(`取消输出订阅失败：${errorText(cause)}`) }
        }
    }
    private fail (message: string): void {
        this.wanted = false
        this.state.phase = 'error'
        this.state.error = this.state.error ? `${this.state.error}\n${message}` : message
        this.detach()
        this.wake?.()
        this.notify()
        this.onError(this.state.error)
    }

    start (): void {
        if (this.disposed || this.worker) return
        if (!this.terminal.onOutput) { this.fail(UNSUPPORTED); return }
        const directory = this.getDirectory() // Snapshot; changes affect only the next start.
        if (!directory) { this.fail('尚未设置日志目录，请先到设置 → 终端日志选择保存目录。'); return }
        this.wanted = true
        this.state = { phase: 'opening', path: '', error: '', bufferedBytes: 0, writtenBytes: 0 }
        this.notify()
        this.worker = this.run(directory).finally(() => {
            this.worker = null
            if (!this.state.error) this.state.phase = this.disposed ? 'disposed' : 'off'
            this.notify()
        })
    }

    stop (): Promise<void> {
        this.wanted = false // Synchronous boundary: no output after the stop click.
        if (this.worker && !this.state.error) this.state.phase = 'stopping'
        else if (this.disposed && !this.state.error) this.state.phase = 'disposed'
        this.detach()
        this.wake?.()
        this.notify()
        return this.worker ?? Promise.resolve()
    }

    dispose (): Promise<void> {
        this.disposed = true // Blocks start even while a delayed open is unresolved.
        return this.stop().finally(() => { this.listeners.clear() })
    }

    private output (data: Uint8Array): void {
        if (!this.wanted || this.disposed || !this.ring || !data.byteLength) return
        if (this.size + this.inFlight + data.byteLength > MAX_BUFFER_BYTES) {
            this.fail(`日志缓冲达到 1 MiB 上限，已停止录制；本次 ${data.byteLength} 字节输出未记录。将尝试写完已接收数据，请检查磁盘或写入速度后重新开始。`)
            return
        }
        const tail = (this.head + this.size) % this.ring.length
        const first = Math.min(data.byteLength, this.ring.length - tail)
        // Copy borrowed host bytes synchronously into owned storage.
        this.ring.set(data.subarray(0, first), tail)
        this.ring.set(data.subarray(first), 0)
        const wasEmpty = this.size === 0
        this.size += data.byteLength
        if (wasEmpty || this.size >= APPEND_BYTES) this.wake?.()
        // Render on flush/state transitions, not on every high-volume output event.
    }

    private wait (ms?: number): Promise<void> {
        return new Promise(resolve => {
            let timer: ReturnType<typeof setTimeout> | undefined
            const finish = (): void => {
                if (timer !== undefined) clearTimeout(timer)
                this.wake = null
                resolve()
            }
            this.wake = finish
            if (ms !== undefined) timer = setTimeout(finish, ms)
        })
    }

    private take (): Uint8Array {
        const count = Math.min(this.size, APPEND_BYTES)
        const bytes = new Uint8Array(count)
        const first = Math.min(count, this.ring!.length - this.head)
        bytes.set(this.ring!.subarray(this.head, this.head + first))
        bytes.set(this.ring!.subarray(0, count - first), first)
        this.head = (this.head + count) % this.ring!.length
        this.size -= count
        this.inFlight = count
        return bytes
    }

    private async run (directory: string): Promise<void> {
        let logId: string | null = null
        try {
            // Saved directories may require system confirmation; keep the response/handle alive while waiting.
            const opened = await this.gateway.request<{ logId: string; path: string }>('fs.logs.open', {
                directory,
                fileName: makeFileName(this.terminal.kind, this.terminal.profile?.host),
            }, { timeoutMs: 300000 })
            // Retain a valid handle even if another response field is malformed, so it can close.
            if (typeof opened?.logId === 'string' && opened.logId) logId = opened.logId
            if (!logId || typeof opened?.path !== 'string' || !opened.path) throw new Error('open 返回无效的日志句柄或路径')
            this.state.path = opened.path
            if (!this.wanted || this.disposed) return // Close a late open; never subscribe.
            this.ring = new Uint8Array(MAX_BUFFER_BYTES)
            this.head = this.size = this.inFlight = 0
            this.state.phase = 'recording'
            // Register only AFTER open succeeded; no historical reads or input listeners.
            const unsubscribe = this.terminal.onOutput!(data => this.output(data))
            if (typeof unsubscribe !== 'function') throw new Error('宿主 onOutput 未返回清理函数')
            if (this.wanted && !this.disposed) this.unsubscribe = unsubscribe
            else unsubscribe() // Handles synchronous callbacks which stop/fail during registration.
            this.notify()
            while (this.wanted || this.size) {
                if (!this.size) { await this.wait(); continue }
                if (this.wanted && this.size < APPEND_BYTES) await this.wait(FLUSH_INTERVAL_MS)
                if (!this.size) continue
                const bytes = this.take()
                const result = await this.gateway.request<{ acceptedBytes: number }>('fs.logs.append', {
                    logId, dataBase64: toBase64(bytes),
                })
                if (result?.acceptedBytes !== bytes.byteLength) {
                    throw new Error(`append 确认字节数不符（应为 ${bytes.byteLength}，实际 ${result?.acceptedBytes}）；不自动重试，避免重复日志`)
                }
                this.state.writtenBytes += bytes.byteLength
                this.inFlight = 0
                this.notify()
            }
        } catch (cause) {
            const pending = this.size + this.inFlight
            this.fail(`日志写入失败：${errorText(cause)}${pending ? `；有 ${pending} 字节未确认落盘，不会自动重试。` : ''}`)
        } finally {
            this.wanted = false
            this.detach()
            if (logId) {
                try {
                    const result = await this.gateway.request<{ closed: boolean }>('fs.logs.close', { logId })
                    if (result?.closed !== true) throw new Error('close 未确认成功')
                } catch (cause) { this.fail(`关闭日志失败：${errorText(cause)}；文件完整性未确认。`) }
            }
            this.ring = null
            this.size = this.head = this.inFlight = 0
        }
    }
}
