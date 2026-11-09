import { Recorder, UNSUPPORTED } from './recorder'
import { Settings } from './settings'

// DOM-only, scoped styles. Inherit the host font/theme, with explicit readable fallbacks.
const CSS = `
.issh-logsave-settings { color:var(--text-primary,#e4e4e7); font:inherit; max-width:720px; line-height:1.6; }
.issh-logsave-settings h3 { font-size:18px; margin:0 0 12px; }
.issh-logsave-settings p { margin:8px 0; }
.issh-logsave-settings code { display:block; white-space:pre-wrap; overflow-wrap:anywhere; padding:8px 10px; background:var(--bg-secondary,#27272a); border-radius:4px; }
.issh-logsave-settings button, .issh-logsave-overlay button { font:inherit; cursor:pointer; border:1px solid #71717a; border-radius:4px; padding:5px 10px; background:var(--bg-secondary,#27272a); color:var(--text-primary,#f4f4f5); }
.issh-logsave-settings button:focus-visible, .issh-logsave-overlay button:focus-visible { outline:2px solid #60a5fa; outline-offset:2px; }
.issh-logsave-settings button:disabled, .issh-logsave-overlay button:disabled { cursor:default; opacity:.75; }
.issh-logsave-error { color:var(--color-error,#fca5a5); white-space:pre-wrap; overflow-wrap:anywhere; }
.issh-logsave-overlay { position:absolute; top:6px; right:18px; z-index:20; pointer-events:none; display:flex; flex-direction:column; align-items:flex-end; gap:3px; max-width:min(380px,calc(100% - 36px)); font-family:inherit; font-size:12px; line-height:1.4; }
.issh-logsave-overlay button { pointer-events:auto; font-size:12px; box-shadow:0 1px 3px #0005; }
.issh-logsave-overlay button[aria-pressed=true] { background:#14532d; color:#dcfce7; border-color:#4ade80; }
.issh-logsave-overlay .issh-logsave-status { max-width:100%; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--bg-secondary,#27272a); color:var(--text-primary,#f4f4f5); border-radius:3px; padding:3px 6px; }
.issh-logsave-overlay .issh-logsave-status[data-error=true] { color:var(--color-error,#fca5a5); border:1px solid #b91c1c; }
`

function element<K extends keyof HTMLElementTagNameMap> (doc: Document, tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag)
    if (text !== undefined) node.textContent = text
    return node
}
function style (doc: Document): HTMLStyleElement { return element(doc, 'style', CSS) }

export function mountSettings (target: HTMLElement, settings: Settings): () => void {
    const doc = target.ownerDocument
    const root = element(doc, 'section')
    root.className = 'issh-logsave-settings'
    const directory = element(doc, 'code')
    directory.setAttribute('aria-label', '已选日志目录')
    const choose = element(doc, 'button', '选择保存目录…')
    choose.type = 'button'
    const error = element(doc, 'p')
    error.className = 'issh-logsave-error'
    error.setAttribute('role', 'alert')
    const recordingError = element(doc, 'p')
    recordingError.className = 'issh-logsave-error'
    recordingError.setAttribute('role', 'alert')
    root.append(style(doc), element(doc, 'h3', '终端日志'), element(doc, 'p', '保存目录'), directory, choose, error,
        element(doc, 'p', '每个终端右上角独立开启，默认关闭。目录更改只影响下次开始；重连后的新会话仍为关闭。'),
        element(doc, 'p', '仅记录开启成功后的终端输出，不读取键盘输入或历史。原始 .log 保留 ANSI 控制序列；命令回显、令牌和其他敏感输出也可能被保存，请妥善保护目录。'),
        element(doc, 'p', '需要含 onOutput 与 fs.logs.* 新接口的 0.2.1 或更新宿主；当前已安装的 0.2.0 不支持。停用插件或退出应用可能丢失尚未落盘的尾部，请先在各终端停止并等待关闭完成。'),
        element(doc, 'p', '最近一次录制错误（不会因切换设置页消失）'), recordingError)
    const render = (): void => {
        directory.textContent = settings.directory || '尚未选择目录'
        choose.disabled = settings.choosing
        choose.textContent = settings.choosing ? '正在选择目录…' : '选择保存目录…'
        error.textContent = settings.error
        error.hidden = !settings.error
        recordingError.textContent = settings.recordingError || '无'
    }
    const onChoose = (): void => { void settings.chooseDirectory() }
    choose.addEventListener('click', onChoose)
    const unsubscribe = settings.subscribe(render)
    render()
    target.append(root)
    return () => { unsubscribe(); choose.removeEventListener('click', onChoose); root.remove() }
}

export function mountRecorder (target: HTMLElement, recorder: Recorder, supported: boolean): () => void {
    const doc = target.ownerDocument
    const root = element(doc, 'div')
    root.className = 'issh-logsave-overlay'
    const button = element(doc, 'button')
    button.type = 'button'
    const status = element(doc, 'span')
    status.className = 'issh-logsave-status'
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    root.append(style(doc), button, status)
    // xterm is normally positioned. Only establish an anchor if it is static;
    // never change padding, width, height, terminal screen or sudo actions.
    const oldPosition = target.style.position
    const needsAnchor = doc.defaultView?.getComputedStyle(target).position === 'static'
    if (needsAnchor) target.style.position = 'relative'
    const render = (): void => {
        const s = recorder.snapshot()
        button.setAttribute('aria-pressed', String(s.phase === 'recording'))
        button.disabled = !supported || s.phase === 'stopping' || s.phase === 'disposed' || (s.phase === 'error' && s.busy)
        button.textContent = !supported ? '日志不可用' : s.phase === 'opening' ? '取消开启日志' : s.phase === 'recording' ? '停止日志' : s.phase === 'stopping' ? '正在保存日志…' : s.phase === 'error' ? (s.busy ? '日志错误 · 正在收尾' : '日志错误 · 重新开始') : '开启日志'
        button.title = s.path || '仅记录本窗口之后的终端输出'
        const message = !supported ? UNSUPPORTED : s.error || (s.phase === 'recording' ? `录制中 · 已确认 ${s.writtenBytes} B · 待写 ${s.bufferedBytes} B` : s.phase === 'opening' ? '正在创建文件；此时的输出不会记录' : s.phase === 'stopping' ? `正在写完尾部并关闭 · 待写 ${s.bufferedBytes} B` : s.path ? '日志已停止并关闭' : '')
        status.textContent = message
        status.dataset.error = String(Boolean(s.error) || !supported)
        status.hidden = !message
    }
    const click = (event: MouseEvent): void => {
        event.stopPropagation()
        const phase = recorder.snapshot().phase
        if (phase === 'recording' || phase === 'opening') void recorder.stop()
        else recorder.start()
    }
    button.addEventListener('click', click)
    const unsubscribe = recorder.subscribe(render)
    render()
    target.append(root)
    return () => {
        unsubscribe()
        button.removeEventListener('click', click)
        root.remove()
        if (needsAnchor && target.style.position === 'relative') target.style.position = oldPosition
    }
}
