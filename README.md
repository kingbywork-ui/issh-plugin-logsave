# issh-plugin-logsave 0.1.0

独立安装的终端输出日志插件。使用本地最小结构类型和 DOM UI，无 Svelte 或其他运行时依赖，结构沿用 linkifier/config-sync。

## 当前可用性与发布前提

**这是插件源码，不是当前安装版可用的功能。** 主程序当前为 0.2.0；本插件的 `minAppVersion` 为建议的 **0.2.1**。必须使用**包含下述新增接口的宿主**，仅版本号达到 0.2.1 并不足以保证兼容。旧宿主没有 `onOutput` 时，终端按钮显示“日志不可用”与升级原因，不会退回轮询历史、读取输入或拦截 xterm.write。

终端装饰器需要 trusted 执行环境。**须完成宿主接口发布、插件签名发布后才能 trusted 运行**；未签名的本地源码/压缩包不等于可在市场或沙箱中使用。此目录未修改注册表、签名、发布脚本或宿主代码。

## 使用

1. 设置 → 终端日志 → **选择保存目录…**，由系统目录选择器选择。取消不改变配置；配置只经过 `ctx.storage.get/set`，不直接使用 localStorage。多设置视图共用一个目录选择锁。
2. 每个终端右上角有独立的 **开启日志** 按钮，默认关闭。只有文件创建成功并订阅真实输出之后的新输出会记录，不补历史，等待创建或系统确认期间的输出也不会记录。
3. 按钮会显示开启中、录制中、停止保存中、关闭或错误。点击 **停止日志** 后立即停止接收新输出，再串行写完已接收尾数据并关闭文件；请等到“日志已停止并关闭”。重复开始会创建另一个文件，不追加上次文件。
4. 改目录只影响**下次开始**。录制中的 logId 继续指向原目录。每窗口独立文件、独立开关，不同步开启其他窗口。重连后的新 session/decorator 始终关闭，绝不继承旧开关。

按钮是挂在 `terminal.element` 内的绝对定位覆盖层，不改变 padding、宽高或终端网格，不复用 sudoAction/setAction。静态定位的 element 仅临时建立 `position: relative` 定位锚点，卸载时恢复；其他已有定位保持不变。设置页能看到已选目录、选择/保存错误和最近一次录制错误；窗口关闭后的错误仍可在设置页查看（本次插件生命周期内）。

## 文件与安全

- `.log` 原样保存宿主输出的 **UTF-8 字节流与 ANSI 控制序列**，不做 strip parser、换行转换、解码再编码。跨批次拆开的多字节字符也不改写。日志可能含颜色、光标移动、回车覆盖、OSC 等控制序列，**不是纯文本屏幕转储**；查看器显示可能与终端不同，直接回放到终端也有控制序列风险。
- 只订阅宿主 `onOutput`；不监听键盘、粘贴、onData，不调用 terminal/session write/read，也不读取 scrollback。远端/本地 PTY 回显的命令及结果属于输出，会被保存。**不能承诺“日志没有密码”：虽然不捕获键入密码，程序回显/打印的密码、令牌、私钥、连接信息等敏感输出仍会保存**，不做脱敏。请保护保存目录权限，不要随意同步或共享日志。
- 文件名格式为 `host前缀_UTC日期时间(含毫秒)_16位随机十六进制.log`。SSH 使用配置中的 host，不做 DNS 查询：IPv4 保持原样，IPv6 的冒号等不适合文件名的字符替换为 `-`；域名只接受 ASCII 字母、数字、标签内连字符和分隔点（可用 punycode，每标签最多 63 字符、域名最多 253 字符），去掉末尾根点。前缀最多 96 字符；缺失或非法 host（含路径字符等）回退字面量 `host`，本地终端使用 `local`。不使用用户名或终端标题拼路径。例如 `example.test_2026-11-07T10-20-30.123Z_0123456789abcdef.log`。
- 随机后缀来自 `crypto.getRandomValues`。宿主必须用 `create_new` 排他创建，永不覆盖已有文件；碰撞或创建失败会显式报错，不绕过确认，也不自动选择其他目录。
- 仅申请 `settings:tab`、`terminal:decorate` 和 `fs.logs.write`，不申请键盘输入、session.write、Vault 或通用文件写权限。文件只能经授权网关写入，不能绕过授权调用 Tauri、Node fs 或其他文件 API。

## 队列、失败与生命周期

- 每次录制一个 worker、一个 1 MiB 环形字节缓冲，**包含在途 append 的总待确认字节最多 1 MiB**；另有一份最大 32 KiB 的发送批次及其 base64/JSON 临时副本。按顺序、每窗口最多一个在途请求；不会为每条输出建立无界 Promise 链或对象队列。短尾最多约 100ms 合并，正常停止/关闭窗口时立即唤醒写完。
- 每批最多 32 KiB（二进制），base64 最多 43,692 字符；正常短 logId 下，请求整体远低于 64 KiB 网关限制。宿主负责限制/生成合理长度的 logId 和执行请求大小校验。
- 缓冲将超上限时，**拒收本次整块输出并停止录制**，明确提示有多少字节未录制，再尝试写完已接收数据；之后输出也不再记录，必须人工排查后重新开启。不会悄悄裁剪或无限堆积。
- 创建、订阅、追加、短写/ack 不符、关闭、权限或网关错误均显示并停止录制。append 必须确认完整批次字节数；失败/超时或短确认可能已经部分写入，因此**绝不盲目重试**以免重复。错误会说明未确认字节，最后尝试 close。错误收尾期间按钮不可重新开始。`acceptedBytes` 是宿主写入确认，不是掉电安全的 fsync 保证。
- stop/dispose 在 open 尚未完成时会取消开启意图；迟到的有效 logId 只会被关闭，不会挂订阅。旧录制完成关闭前不能重开。窗口 dispose 同步解除订阅，并尽力 flush 已接收的尾数据及 close；宿主自动生命周期清理与插件清理均应幂等。
- **停用/卸载插件时宿主先撤销授权**，所以 deactivate/dispose 的尾数据 flush 和 close 可能被拒绝；退出、崩溃、强关应用或网关超时也可能丢失尚未落盘尾部，宿主负责撤权后回收文件句柄。插件不持有特权旁路，也不承诺停用/退出零丢失。需要完整日志时，先逐个停止录制并等待关闭成功，再停用或退出。

## 宿主接口契约（由宿主/后端实现）

`TerminalDecoratorOptions` 已有 `sessionId, kind, title, profile: { host, ... } | null, terminal.element, dispose(cb)`，新增

```ts
onOutput?(listener: (data: Uint8Array) => void): () => void
```

同步交付真实终端输出，宿主自动做生命周期清理。参数只在回调期间借用；插件在回调返回前复制到自有缓冲。不可把输入事件混入该流。返回取消订阅函数必须可与宿主清理安全并用。

网关 `request` 方法，统一权限 **`fs.logs.write`**（前后端都须映射并校验）

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `fs.logs.pickDirectory` | `{}` | `string \| null` |
| `fs.logs.open` | `{ directory, fileName }` | `{ logId, path }` |
| `fs.logs.append` | `{ logId, dataBase64 }` | `{ acceptedBytes }` |
| `fs.logs.close` | `{ logId }` | `{ closed }` |

插件对 `pickDirectory` 和 `open` 使用 `request(method, args, { timeoutMs: 300000 })`，给系统选目录/已保存目录确认留出 5 分钟，避免普通用户确认超过默认 10 秒后响应被丢弃、拿不到迟到的文件句柄。`append` / `close` 保持网关默认超时；超过 5 分钟的交互仍可能超时，宿主仍须负责超时后的句柄回收。

append 解码上限 **32 KiB**；单次请求 JSON 整体上限 **64 KiB**。open 可对保存目录弹一次系统确认，必须防任意路径写入，校验单一安全文件名并使用 create_new；文件句柄与插件授权绑定，不应凭其他插件的 logId 写入/关闭。close 只有成功后返回 `closed: true`。后端报错、拒绝确认与撤权必须通过 reject/错误返回传播，不能伪造成功 ack。

UI 使用 `ctx.gateway.ui.registerSettingsTab/registerTerminalDecorator`；持久化用 `ctx.storage`；诊断用 `ctx.gateway.log`。结构类型在 `src/types.ts`，不引入共享 API 的运行时依赖。

## 最小验证与后续构建

本次不安装依赖、不更新任何 lockfile、不构建、不打包。定向测试可直接复用 monorepo 已有 root 或 `issh-tauri` 的 TypeScript

```sh
node --test plugins/issh-plugin-logsave/test/logsave.test.mjs
```

测试仅在内存 transpile/noEmit 类型检查，不生成 dist；用 node:test 和受控网关/DOM 替身覆盖独立开关、字节及顺序、关闭 flush、目录隔离、失败、上限、异步竞态和 UI 清理。不是实际 Windows 系统目录确认、磁盘权限/耗尽、宿主真实输出和关闭时序的端到端验收。

`package.json` 提供未来的 `build` / `package` 命令，`vite.config.ts` 输出 ES module 到 `dist/index.js`，`scripts/package.mjs` 沿用现有插件 tar + SHA256 流程（不签名、不发布）。这些步骤应在接口联调与测试后另行执行；独立迁出仓库时测试需另备 TypeScript 工具链。
