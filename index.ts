import { Recorder, UNSUPPORTED } from './src/recorder'
import { Settings } from './src/settings'
import { mountRecorder, mountSettings } from './src/ui'
import type { IsshPlugin, IsshPluginContext, IsshPluginManifest } from './src/types'

export const manifest: IsshPluginManifest = {
    id: 'issh-plugin-logsave',
    name: '终端日志',
    version: '0.1.1',
    description: '按终端窗口独立开启的原始输出日志，保存至系统选择的目录',
    kind: 'feature',
    minAppVersion: '0.2.0',
    entry: 'index.js',
    gatewayApiVersion: '1',
    permissions: ['settings:tab', 'terminal:decorate', 'fs.logs.write'],
    capabilities: ['ui.settings.register', 'terminal.decorate', 'fs.logs.write'],
    author: 'kingbywork-ui',
}

let shutdown: (() => Promise<void>) | null = null

const plugin: IsshPlugin = {
    manifest,
    activate (ctx: IsshPluginContext) {
        if (shutdown) throw new Error('终端日志插件已激活')
        const settings = new Settings(ctx.gateway, ctx.storage)
        const recordings = new Set<Recorder>()
        const views = new Set<() => void>()
        const registrations: Array<() => void> = []
        let active = true
        const trackView = (cleanup: () => void): (() => void) => {
            let removed = false
            const remove = (): void => {
                if (removed) return
                removed = true
                views.delete(remove)
                cleanup()
            }
            views.add(remove)
            return remove
        }
        shutdown = async () => {
            active = false
            for (const remove of registrations.splice(0)) remove()
            for (const remove of Array.from(views)) remove()
            settings.dispose() // Ignore any late directory-picker response after deactivation.
            // Best effort only. Host revokes authority first; never bypass the gateway.
            await Promise.all(Array.from(recordings, recorder => recorder.dispose()))
            recordings.clear()
            shutdown = null
        }
        registrations.push(ctx.gateway.ui.registerSettingsTab({
            id: 'logsave', title: '终端日志', order: 15,
            mount: target => active ? trackView(mountSettings(target, settings)) : () => {},
        }))
        registrations.push(ctx.gateway.ui.registerTerminalDecorator({
            id: 'logsave',
            decorate (options) {
                if (!active) return
                const label = options.title || options.sessionId
                const target = options.terminal.element
                if (!target) {
                    settings.reportRecordingError(`${label}：无法挂载日志按钮（terminal.element 不可用），本窗口未录制。`)
                    return
                }
                // A new decorator/session always gets a NEW recorder, initially off.
                const recorder = new Recorder(ctx.gateway, options, () => settings.directory,
                    message => settings.reportRecordingError(`${label}：${message}`))
                recordings.add(recorder)
                const remove = trackView(mountRecorder(target, recorder, typeof options.onOutput === 'function'))
                if (!options.onOutput) settings.reportRecordingError(`${label}：${UNSUPPORTED}`)
                options.dispose(() => {
                    remove()
                    // Host auto-cleans the output subscription; stop is also idempotent.
                    void recorder.dispose().finally(() => { recordings.delete(recorder) })
                })
            },
        }))
        ctx.gateway.log('info', 'logsave plugin activated; all terminal recordings default to off')
    },
    async deactivate () { await shutdown?.() },
}

export default plugin
