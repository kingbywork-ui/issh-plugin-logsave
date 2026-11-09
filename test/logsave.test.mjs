import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'

// Reuse installed monorepo tooling, with no install, build, or generated files.
let ts
for (const base of ['../../../package.json', '../../../issh-tauri/package.json']) {
    try { ts = createRequire(new URL(base, import.meta.url))('typescript'); break } catch { /* Try next existing toolchain. */ }
}
if (!ts) throw new Error('测试需要 monorepo root 或 issh-tauri 已有的 TypeScript；不会自动安装')
const urls = new Map()
function moduleUrl (url) {
    if (urls.has(url.href)) return urls.get(url.href)
    const compiled = ts.transpileModule(readFileSync(url, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText.replace(/from ['"]([^'"]+)['"]/g, (match, specifier) => {
        assert.ok(specifier.startsWith('.'), `No runtime dependency: ${specifier}`)
        return `from '${moduleUrl(new URL(`${specifier}.ts`, url))}'`
    })
    const result = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
    urls.set(url.href, result)
    return result
}
const { Recorder, APPEND_BYTES, MAX_BUFFER_BYTES, makeFileName } = await import(moduleUrl(new URL('../src/recorder.ts', import.meta.url)))
const { Settings, DIRECTORY_KEY } = await import(moduleUrl(new URL('../src/settings.ts', import.meta.url)))
const { default: plugin } = await import(moduleUrl(new URL('../index.ts', import.meta.url)))

function deferred () {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
async function until (predicate) {
    for (let i = 0; i < 1000; i++) { if (predicate()) return; await nextTurn() }
    assert.fail('condition did not settle')
}
function outputSource () {
    let listener
    let subscriptions = 0
    let removals = 0
    return {
        onOutput (fn) {
            assert.equal(listener, undefined)
            listener = fn
            subscriptions++
            let removed = false
            return () => { if (!removed) { removed = true; listener = undefined; removals++ } }
        },
        emit (data) { listener?.(data) },
        get subscriptions () { return subscriptions },
        get removals () { return removals },
    }
}
function gatewayFixture (override = async () => undefined) {
    const calls = []
    const files = new Map()
    let sequence = 0, inFlight = 0, maxInFlight = 0
    const gateway = {
        async request (method, args, options) {
            calls.push({ method, args, options })
            inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
            try {
                const custom = await override(method, args, options)
                if (custom !== undefined) return custom
                if (method === 'fs.logs.open') {
                    const logId = `log-${++sequence}`
                    const path = `${args.directory}/${args.fileName}`
                    files.set(logId, { path, chunks: [], closed: false })
                    return { logId, path }
                }
                if (method === 'fs.logs.append') {
                    const bytes = Buffer.from(args.dataBase64, 'base64')
                    assert.ok(bytes.length <= APPEND_BYTES)
                    assert.ok(Buffer.byteLength(JSON.stringify({ method, args })) < 64 * 1024)
                    files.get(args.logId).chunks.push(bytes)
                    return { acceptedBytes: bytes.length }
                }
                if (method === 'fs.logs.close') { files.get(args.logId).closed = true; return { closed: true } }
                assert.fail(`Unexpected RPC ${method}`)
            } finally { inFlight-- }
        },
        log () {},
    }
    return { gateway, calls, files, get maxInFlight () { return maxInFlight } }
}
function fixture (t, override) {
    const rpc = gatewayFixture(override)
    const source = outputSource()
    const errors = []
    let directory = '/chosen/A'
    const recorder = new Recorder(rpc.gateway, { kind: 'ssh', profile: { host: '192.0.2.1' }, onOutput: source.onOutput }, () => directory, error => errors.push(error))
    t.after(() => recorder.dispose())
    return { ...rpc, rpc, source, recorder, errors, setDirectory (value) { directory = value } }
}
async function start (recorder) { recorder.start(); await until(() => recorder.snapshot().phase === 'recording') }
function bytesOf (file) { return Buffer.concat(file.chunks) }

test('strict noEmit TypeScript and matching manifests; runtime imports are local only', () => {
    const root = fileURLToPath(new URL('../index.ts', import.meta.url))
    const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], skipLibCheck: true }
    const program = ts.createProgram([root], options)
    const errors = ts.getPreEmitDiagnostics(program)
    assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
        getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => '\n',
    }))
    const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))
    assert.deepEqual(plugin.manifest, manifest)
    assert.equal(manifest.version, '0.1.1')
    assert.equal(manifest.minAppVersion, '0.2.0')
    assert.deepEqual(manifest.permissions, ['settings:tab', 'terminal:decorate', 'fs.logs.write'])
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(pkg.version, manifest.version)
    assert.equal(pkg.dependencies, undefined)
    assert.equal(pkg.devDependencies.svelte, undefined)
})

test('two windows default off, independent switches/files, no history or pre-open output', async t => {
    const a = fixture(t), b = fixture(t)
    a.source.emit(Buffer.from('history'))
    assert.equal(a.recorder.snapshot().phase, 'off')
    assert.equal(b.recorder.snapshot().phase, 'off')
    assert.equal(a.calls.length, 0)
    a.recorder.start()
    a.source.emit(Buffer.from('during open'))
    await until(() => a.recorder.snapshot().phase === 'recording')
    a.source.emit(Buffer.from('A'))
    b.source.emit(Buffer.from('not recording'))
    await a.recorder.stop()
    assert.equal(bytesOf(a.files.get('log-1')).toString(), 'A')
    assert.equal(a.files.get('log-1').closed, true)
    assert.equal(b.calls.length, 0)
    await start(b.recorder)
    b.source.emit(Buffer.from('B'))
    await b.recorder.stop()
    assert.notEqual(a.files.get('log-1').path, b.files.get('log-1').path)
})

test('copies borrowed bytes; raw ANSI/UTF-8, split multibyte bytes, order and 32 KiB batches', async t => {
    const f = fixture(t)
    await start(f.recorder)
    const expected = Buffer.concat([Buffer.alloc(APPEND_BYTES - 1, 65), Buffer.from('中\x1b[31m\r\n😀\x1b[0m'), Buffer.alloc(APPEND_BYTES * 2 + 17, 66)])
    const chunks = [expected.subarray(0, APPEND_BYTES), expected.subarray(APPEND_BYTES, APPEND_BYTES + 1), expected.subarray(APPEND_BYTES + 1)]
    for (const chunk of chunks) {
        const borrowed = Uint8Array.from(chunk)
        f.source.emit(borrowed)
        borrowed.fill(0)
    }
    const stopping = f.recorder.stop()
    assert.equal(stopping, f.recorder.stop(), 'one worker, including repeated stop')
    f.source.emit(Buffer.from('after stop'))
    await stopping
    assert.deepEqual(bytesOf(f.files.get('log-1')), expected)
    assert.equal(f.recorder.snapshot().writtenBytes, expected.length)
    assert.equal(f.rpc.maxInFlight, 1)
    assert.equal(f.source.removals, 1)
    assert.equal(f.calls.at(-1).method, 'fs.logs.close')
    assert.deepEqual(f.calls[0].options, { timeoutMs: 300000 }, 'open allows time for saved-directory confirmation')
    assert.ok(f.calls.slice(1).every(call => call.options === undefined), 'append/close keep the default timeout')
})

test('active recording batches short tails without requiring stop', async t => {
    const f = fixture(t)
    await start(f.recorder)
    f.source.emit(Buffer.from('short tail'))
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(bytesOf(f.files.get('log-1')).toString(), 'short tail')
    assert.equal(f.recorder.snapshot().phase, 'recording')
    await f.recorder.stop()
})

test('stop waits for in-flight append, flushes subsequent tail and closes serially', async t => {
    const gate = deferred()
    let blocked = false
    const f = fixture(t, async method => {
        if (method === 'fs.logs.append' && !blocked) { blocked = true; await gate.promise }
    })
    await start(f.recorder)
    f.source.emit(Buffer.alloc(APPEND_BYTES, 65))
    await until(() => blocked)
    f.source.emit(Buffer.from('tail'))
    let settled = false
    const stopping = f.recorder.stop().then(() => { settled = true })
    await nextTurn()
    assert.equal(settled, false)
    assert.equal(f.calls.some(c => c.method === 'fs.logs.close'), false)
    gate.resolve()
    await stopping
    assert.equal(bytesOf(f.files.get('log-1')).subarray(-4).toString(), 'tail')
    assert.equal(f.recorder.snapshot().phase, 'off')
})

test('directory snapshot stays with open file; next start uses new directory and new file', async t => {
    const f = fixture(t)
    await start(f.recorder)
    f.source.emit(Buffer.from('old'))
    f.setDirectory('/chosen/B')
    f.source.emit(Buffer.from(' still old'))
    await f.recorder.stop()
    await start(f.recorder)
    f.source.emit(Buffer.from('new'))
    await f.recorder.stop()
    assert.ok(f.files.get('log-1').path.startsWith('/chosen/A/'))
    assert.ok(f.files.get('log-2').path.startsWith('/chosen/B/'))
    assert.equal(bytesOf(f.files.get('log-1')).toString(), 'old still old')
    assert.equal(bytesOf(f.files.get('log-2')).toString(), 'new')
})

for (const action of ['stop', 'dispose']) {
    test(`late open after ${action} closes once and never subscribes or restarts`, async t => {
        const gate = deferred()
        const f = fixture(t, async method => { if (method === 'fs.logs.open') await gate.promise })
        f.recorder.start()
        const closing = f.recorder[action]()
        f.recorder.start()
        gate.resolve()
        await closing
        assert.equal(f.source.subscriptions, 0)
        assert.deepEqual(f.calls.map(c => c.method), ['fs.logs.open', 'fs.logs.close'])
        if (action === 'dispose') {
            f.recorder.start()
            assert.equal(f.calls.length, 2)
            assert.equal(f.recorder.snapshot().phase, 'disposed')
        } else assert.equal(f.recorder.snapshot().phase, 'off')
    })
}

test('close in flight blocks restart, and directory changes during open only affect next start', async t => {
    const openGate = deferred(), closeGate = deferred()
    let opens = 0, closes = 0
    const f = fixture(t, async method => {
        if (method === 'fs.logs.open' && ++opens === 1) await openGate.promise
        if (method === 'fs.logs.close' && ++closes === 1) await closeGate.promise
    })
    f.recorder.start()
    f.setDirectory('/chosen/B')
    openGate.resolve()
    await until(() => f.recorder.snapshot().phase === 'recording')
    f.source.emit(Buffer.from('first'))
    const stopping = f.recorder.stop()
    await until(() => closes === 1)
    f.recorder.start()
    assert.equal(opens, 1)
    assert.equal(f.recorder.snapshot().phase, 'stopping')
    closeGate.resolve()
    await stopping
    await start(f.recorder)
    await f.recorder.stop()
    assert.ok(f.files.get('log-1').path.startsWith('/chosen/A/'))
    assert.ok(f.files.get('log-2').path.startsWith('/chosen/B/'))
})

test('revoked gateway during dispose reports unconfirmed tail and failed close, without bypass/retry', async t => {
    let revoked = false
    const f = fixture(t, async () => { if (revoked) throw new Error('gateway authority revoked') })
    await start(f.recorder)
    f.source.emit(Buffer.from('unflushed'))
    revoked = true
    await f.recorder.dispose()
    assert.match(f.recorder.snapshot().error, /9 字节未确认/)
    assert.match(f.recorder.snapshot().error, /关闭日志失败.*gateway authority revoked/)
    assert.deepEqual(f.calls.map(c => c.method), ['fs.logs.open', 'fs.logs.append', 'fs.logs.close'])
    assert.equal(f.source.removals, 1)
})

test('synchronous output during subscription overflow still detaches and closes', async () => {
    const rpc = gatewayFixture(), errors = []
    let removals = 0
    const recorder = new Recorder(rpc.gateway, { kind: 'local', profile: null, onOutput (listener) {
        listener(new Uint8Array(MAX_BUFFER_BYTES + 1))
        return () => { removals++ }
    } }, () => '/A', message => errors.push(message))
    recorder.start()
    await until(() => !recorder.snapshot().busy)
    assert.match(recorder.snapshot().error, /上限/)
    assert.equal(removals, 1)
    assert.equal(rpc.files.get('log-1').closed, true)
    assert.equal(rpc.calls.filter(c => c.method === 'fs.logs.append').length, 0)
    await recorder.dispose()
})

test('window dispose flushes a tiny tail and remains permanently off', async t => {
    const f = fixture(t)
    await start(f.recorder)
    f.source.emit(Buffer.from('last bytes'))
    await f.recorder.dispose()
    assert.equal(bytesOf(f.files.get('log-1')).toString(), 'last bytes')
    assert.equal(f.files.get('log-1').closed, true)
    f.recorder.start()
    assert.equal(f.source.subscriptions, 1)
})

for (const failure of ['reject', 'short', 'close']) {
    test(`${failure} failure is visible, stops capture, closes once and never retries append`, async t => {
        const f = fixture(t, async (method, args) => {
            if (method === 'fs.logs.append' && failure === 'reject') throw new Error('disk full / permission revoked')
            if (method === 'fs.logs.append' && failure === 'short') return { acceptedBytes: Buffer.from(args.dataBase64, 'base64').length - 1 }
            if (method === 'fs.logs.close' && failure === 'close') return { closed: false }
        })
        await start(f.recorder)
        f.source.emit(Buffer.from('output'))
        await f.recorder.stop()
        assert.equal(f.recorder.snapshot().phase, 'error')
        assert.ok(f.recorder.snapshot().error)
        assert.ok(f.errors.length)
        f.source.emit(Buffer.from('not captured'))
        assert.equal(f.calls.filter(c => c.method === 'fs.logs.append').length, 1)
        assert.equal(f.calls.filter(c => c.method === 'fs.logs.close').length, 1)
        assert.equal(f.source.removals, 1)
    })
}

test('buffer limit counts in-flight bytes; fail loudly, keep order while draining accepted bytes', async t => {
    const gate = deferred()
    let blocked = false
    const f = fixture(t, async method => {
        if (method === 'fs.logs.append' && !blocked) { blocked = true; await gate.promise }
    })
    await start(f.recorder)
    f.source.emit(Buffer.alloc(APPEND_BYTES, 65))
    await until(() => blocked)
    f.source.emit(Buffer.alloc(MAX_BUFFER_BYTES - APPEND_BYTES, 66))
    assert.equal(f.recorder.snapshot().bufferedBytes, MAX_BUFFER_BYTES)
    f.source.emit(Buffer.from('overflow'))
    assert.equal(f.recorder.snapshot().phase, 'error')
    assert.match(f.recorder.snapshot().error, /1 MiB.*8 字节/)
    f.recorder.start() // No restart while error worker is still draining.
    assert.equal(f.calls.filter(c => c.method === 'fs.logs.open').length, 1)
    gate.resolve()
    await f.recorder.stop()
    const output = bytesOf(f.files.get('log-1'))
    assert.equal(output.length, MAX_BUFFER_BYTES)
    assert.deepEqual(output.subarray(0, APPEND_BYTES), Buffer.alloc(APPEND_BYTES, 65))
    assert.deepEqual(output.subarray(APPEND_BYTES), Buffer.alloc(MAX_BUFFER_BYTES - APPEND_BYTES, 66))
    assert.equal(f.rpc.maxInFlight, 1)
})

test('ring wraps across successive batches without reordering or retaining old bytes', async t => {
    const f = fixture(t)
    await start(f.recorder)
    const expected = []
    for (let i = 0; i < 40; i++) {
        const block = Buffer.alloc(APPEND_BYTES + 13, i)
        expected.push(block)
        f.source.emit(block)
        // Full batches are acknowledged immediately; the small accumulated tail
        // is intentionally left for the coalescing timer or the final stop.
        await until(() => f.recorder.snapshot().writtenBytes >= (i + 1) * APPEND_BYTES)
    }
    await f.recorder.stop()
    assert.deepEqual(bytesOf(f.files.get('log-1')), Buffer.concat(expected))
})

test('old host / missing directory / open failure are explicit and never subscribe', async t => {
    const rpc = gatewayFixture()
    const errors = []
    const old = new Recorder(rpc.gateway, { kind: 'local', profile: null }, () => '/A', e => errors.push(e))
    old.start()
    assert.match(old.snapshot().error, /不支持.*0.2.0/)
    assert.equal(rpc.calls.length, 0)
    const f = fixture(t, async method => { if (method === 'fs.logs.open') throw new Error('user denied / create_new collision') })
    f.setDirectory('')
    f.recorder.start()
    assert.match(f.recorder.snapshot().error, /尚未设置/)
    assert.equal(f.calls.length, 0)
    f.setDirectory('/A')
    f.recorder.start()
    await until(() => !f.recorder.snapshot().busy)
    assert.match(f.recorder.snapshot().error, /user denied/)
    assert.equal(f.source.subscriptions, 0)
})

test('malformed open path still closes valid handle; bad subscription does not leak file', async () => {
    for (const scenario of ['path', 'subscribe']) {
        const calls = [], errors = []
        const recorder = new Recorder({ async request (method) {
            calls.push(method)
            if (method === 'fs.logs.open') return { logId: 'valid', path: scenario === 'path' ? null : '/A/file.log' }
            if (method === 'fs.logs.close') return { closed: true }
            assert.fail('No append expected')
        } }, { kind: 'local', profile: null, onOutput () { throw new Error('subscription failed') } }, () => '/A', e => errors.push(e))
        recorder.start()
        await until(() => !recorder.snapshot().busy)
        assert.deepEqual(calls, ['fs.logs.open', 'fs.logs.close'])
        assert.equal(recorder.snapshot().phase, 'error')
        assert.ok(errors.length)
        await recorder.dispose()
    }
})

test('file names: milliseconds + random, IP/IPv6, configured domain, local, bounded safe prefix', () => {
    const suffix = /_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[a-f\d]{16}\.log$/
    const names = Array.from({ length: 100 }, () => makeFileName('ssh', '192.0.2.7'))
    assert.equal(new Set(names).size, names.length)
    for (const name of names) { assert.match(name, /^192\.0\.2\.7_/); assert.match(name, suffix) }
    assert.match(makeFileName('ssh', '[2001:db8::1]'), /^2001-db8--1_/)
    assert.match(makeFileName('ssh', 'fe80::1%eth0'), /^fe80--1-eth0_/)
    assert.match(makeFileName('ssh', 'example.test'), /^example\.test_/)
    assert.match(makeFileName('ssh', ' Example.TEST. '), /^Example\.TEST_/)
    const longHost = `${'a'.repeat(63)}.${'b'.repeat(63)}.test`
    assert.equal(makeFileName('ssh', longHost).replace(suffix, ''), longHost.slice(0, 96))
    for (const host of [undefined, '', '../../CON', 'bad/host', 'bad\\host', 'bad:host', 'bad\0host', '..', '-bad.test', 'a'.repeat(64), `${longHost}.${longHost}`]) {
        assert.match(makeFileName('ssh', host), /^host_/)
    }
    assert.match(makeFileName('local', 'example.test'), /^local_/)
})

test('directory picker single-flight, cancel preserves storage, storage failure and late disposal', async () => {
    const saved = new Map([[DIRECTORY_KEY, '/old']])
    const gates = [], calls = []
    let failStorage = false
    const settings = new Settings({ log () {}, request (method, args, options) {
        calls.push({ method, args, options }); const gate = deferred(); gates.push(gate); return gate.promise
    } }, { get: key => saved.get(key), set (key, value) { if (failStorage) throw new Error('quota'); saved.set(key, value) } })
    const cancel = settings.chooseDirectory()
    await settings.chooseDirectory()
    assert.equal(calls.length, 1)
    assert.equal(settings.choosing, true)
    assert.deepEqual(calls[0], { method: 'fs.logs.pickDirectory', args: {}, options: { timeoutMs: 300000 } })
    gates[0].resolve(null)
    await cancel
    assert.equal(settings.directory, '/old')
    assert.equal(saved.get(DIRECTORY_KEY), '/old')
    const selected = settings.chooseDirectory()
    gates[1].resolve('/new')
    await selected
    assert.equal(settings.directory, '/new')
    assert.equal(saved.get(DIRECTORY_KEY), '/new')
    failStorage = true
    const failed = settings.chooseDirectory()
    gates[2].resolve('/bad')
    await failed
    assert.match(settings.error, /quota/)
    assert.equal(settings.directory, '/new')
    const late = settings.chooseDirectory()
    settings.dispose()
    gates[3].resolve('/late')
    await late
    assert.equal(settings.directory, '/new')
    assert.equal(saved.get(DIRECTORY_KEY), '/new')
})

// Tiny DOM substitute to test mounting, visible state, actions and cleanup, not geometry.
class Node {
    constructor (doc, tag) {
        this.ownerDocument = doc; this.tagName = tag; this.children = []; this.style = { position: '', padding: '9px', width: '500px' }
        this.dataset = {}; this.attributes = {}; this.events = {}; this.textContent = ''; this.disabled = false
    }
    append (...children) { for (const child of children) { child.parent = this; this.children.push(child) } }
    setAttribute (name, value) { this.attributes[name] = value }
    addEventListener (name, callback) { this.events[name] = callback }
    removeEventListener (name, callback) { if (this.events[name] === callback) delete this.events[name] }
    remove () { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this) }
    click () { if (!this.disabled) this.events.click?.({ stopPropagation () {} }) }
}
function dom () {
    const doc = { createElement: tag => new Node(doc, tag), defaultView: { getComputedStyle: node => ({ position: node.style.position || 'static' }) } }
    return new Node(doc, 'div')
}
function find (node, predicate) { if (predicate(node)) return node; for (const child of node.children) { const found = find(child, predicate); if (found) return found } }

test('plugin DOM: per-window controls, visible failure/unsupported, reconnect off, no layout mutation, cleanup', async t => {
    let decorator, tab
    const rpc = gatewayFixture(async method => { if (method === 'fs.logs.append') throw new Error('permission revoked') })
    let unregisters = 0
    plugin.activate({ storage: { get: () => '/A', set () {} }, gateway: { ...rpc.gateway,
        ui: {
            registerTerminalDecorator (value) { decorator = value; return () => { unregisters++ } },
            registerSettingsTab (value) { tab = value; return () => { unregisters++ } },
        },
    } })
    t.after(() => plugin.deactivate())
    const settingsTarget = dom()
    const unmountSettings = tab.mount(settingsTarget)
    function decorate (id, supported = true) {
        const target = dom(), source = outputSource(), cleanups = []
        decorator.decorate({ sessionId: id, title: id, kind: 'local', profile: null, terminal: { element: target },
            ...(supported ? { onOutput: source.onOutput } : {}), dispose: cb => cleanups.push(cb) })
        return { target, source, cleanup () { for (const cb of cleanups.splice(0)) cb() },
            button: find(target, node => node.tagName === 'button'),
            status: find(target, node => node.attributes.role === 'status'),
        }
    }
    const a = decorate('A'), b = decorate('B')
    assert.equal(a.button.textContent, '开启日志')
    assert.equal(b.button.textContent, '开启日志')
    assert.equal(a.target.style.padding, '9px')
    assert.equal(a.target.style.width, '500px')
    a.button.click()
    await until(() => a.button.textContent === '停止日志')
    assert.equal(a.button.attributes['aria-pressed'], 'true')
    assert.equal(b.button.textContent, '开启日志')
    a.source.emit(Buffer.from('tail'))
    a.button.click()
    assert.equal(a.button.disabled, true)
    await until(() => a.status.textContent.includes('permission revoked') && !a.button.disabled)
    assert.equal(a.status.dataset.error, 'true')
    assert.ok(find(settingsTarget, node => node.textContent.includes('permission revoked')))
    a.cleanup()
    const reconnect = decorate('A-new-session')
    assert.equal(reconnect.button.textContent, '开启日志')
    assert.equal(reconnect.source.subscriptions, 0)
    const old = decorate('old-host', false)
    assert.equal(old.button.disabled, true)
    assert.match(old.status.textContent, /0.2.0/)
    assert.equal(a.target.children.length, 0)
    assert.equal(a.target.style.position, '')
    unmountSettings(); unmountSettings()
    assert.equal(settingsTarget.children.length, 0)
    b.cleanup(); reconnect.cleanup(); old.cleanup()
    await plugin.deactivate()
    assert.equal(unregisters, 2)
})
