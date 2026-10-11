// dsh-isolated-display —— 在隔离的虚拟 X display 里驱动 GUI 程序
//
// ── 为什么需要 ─────────────────────────────────────────────────────────────
//   用户的桌面是 KDE **Wayland**。在 Wayland 主桌面上：
//     * 无法把输入注入到「非焦点窗口」（XTEST 打给当前焦点；XSendEvent 多数程序不理会）
//     * 抓屏受 XWayland 限制（`import -window root` 直接 BadMatch）
//     * 任何自动化都会抢焦点、干扰用户
//   解法：用 Xephyr 在用户桌面上开一个窗口，**内部却是独立的 X server**。
//   在那个 display 里，XTEST / XSendEvent / 抓屏全部正常，且与用户会话完全隔离。
//
// ── 已知边界 ───────────────────────────────────────────────────────────────
//   Xephyr **不提供 DRI3**，因此**跑不了 Vulkan/3D 游戏**
//   （`vulkaninfo` 会报 "No DRI3 support detected - required for presentation"，
//    UE 启动即 EXCEPTION_INT_DIVIDE_BY_ZERO）。2D / X11 程序完全可用。
//
// ── 本文件提供两件事 ───────────────────────────────────────────────────────
//   1. 给 Agent 的 7 个工具（iso_display_*）
//   2. 给浏览器 Web UI 的 HTTP 路由（/gui-isolation/*），供 client.js 的
//      侧边栏标签页拉取画面、注入输入
//
// 后端目前只有 `xephyr`；接口按后端无关设计，将来可接 MaaFramework 等。

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const run = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const name = 'dsh-isolated-display'
export const inject = ['tools']

// 不声明 `Config`：Cordis 要求它是一个实现了 Standard Schema 的对象
// （`Config["~standard"].validate`）。零依赖的纯 JS bundle 拿不到 schema 库，
// 声明成裸 JSON Schema 会让插件激活失败。默认值写在代码里，
// 仍可通过 cordis.patch.yml 的 config 覆盖（不做校验）。

const text = (s) => [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }]
const output = (schema) => ({ schema, render: (_args, value) => text(value) })
const okSchema = { type: 'object', additionalProperties: true }

export function apply(ctx, config = {}) {
  const stateDir = config.stateDir || path.join(os.homedir(), '.dsh-isolated-display')
  const [rangeLo, rangeHi] = config.displayRange || [9, 20]
  const defaultSize = config.defaultSize || '1280x720'
  const bin = {
    xephyr: config.xephyrPath || 'Xephyr',
    xdotool: config.xdotoolPath || 'xdotool',
    shot: config.importPath || 'import',
  }
  const parentDisplay = config.parentDisplay || process.env.DISPLAY || ':1'

  // dsh 宿主进程通常**不继承**桌面会话的 DISPLAY/XAUTHORITY（实测：host env 里
  // 两者都没有），所以必须在配置之外自动探测，否则 Xephyr/xdotool 连不上 X server。
  function detectXauthority() {
    if (config.xauthority) return config.xauthority
    if (process.env.XAUTHORITY) return process.env.XAUTHORITY
    const candidates = []
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null
      if (uid !== null) {
        const dir = `/run/user/${uid}`
        if (existsSync(dir)) {
          for (const f of readdirSync(dir)) if (f.startsWith('xauth_')) candidates.push(path.join(dir, f))
        }
      }
    } catch {}
    candidates.push(path.join(os.homedir(), '.Xauthority'))
    return candidates.find((c) => existsSync(c)) || ''
  }
  const xauthority = detectXauthority()

  const envFor = (display) => ({
    ...process.env,
    DISPLAY: display,
    ...(xauthority ? { XAUTHORITY: xauthority } : {}),
  })

  const stateFile = (display) => path.join(stateDir, `${String(display).replace(':', '')}.json`)

  async function readState(display) {
    try { return JSON.parse(await readFile(stateFile(display), 'utf8')) } catch { return null }
  }

  async function alive(display) {
    try { await run('xdpyinfo', ['-display', display], { timeout: 4000, env: envFor(display) }); return true } catch { return false }
  }

  async function listDisplays() {
    if (!existsSync(stateDir)) return []
    const names = (await readdir(stateDir)).filter((f) => f.endsWith('.json'))
    const out = []
    for (const f of names) {
      const display = ':' + f.replace(/\.json$/, '')
      const st = await readState(display)
      out.push({ display, alive: await alive(display), size: st?.size, pid: st?.pid, backend: st?.backend })
    }
    return out.sort((a, b) => a.display.localeCompare(b.display, undefined, { numeric: true }))
  }

  function pickDisplay() {
    for (let n = rangeLo; n <= rangeHi; n++) if (!existsSync(`/tmp/.X11-unix/X${n}`)) return `:${n}`
    return null
  }

  // ── 启动 / 停止 ──────────────────────────────────────────────────────────
  async function start({ size = defaultSize, display } = {}) {
    await mkdir(stateDir, { recursive: true })
    const target = display || pickDisplay()
    if (!target) throw new Error(`display 区间 ${rangeLo}-${rangeHi} 已用满`)
    if (await alive(target)) {
      const st = await readState(target)
      if (st) return { display: target, size: st.size, alreadyRunning: true }
      throw new Error(`${target} 已被其它程序占用`)
    }
    const child = spawn(bin.xephyr, [target, '-screen', size, '-ac', '-noreset', '-title', `DSH isolated display ${target}`], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DISPLAY: parentDisplay, ...(xauthority ? { XAUTHORITY: xauthority } : {}) },
    })
    child.unref()
    for (let i = 0; i < 30; i++) {
      await sleep(400)
      if (await alive(target)) {
        await writeFile(stateFile(target), JSON.stringify({ size, pid: child.pid, backend: 'xephyr', parentDisplay, startedAt: new Date().toISOString() }, null, 2))
        return { display: target, size, pid: child.pid, backend: 'xephyr', parentDisplay }
      }
    }
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    throw new Error(`Xephyr 未能在 ${target} 上就绪（父 display ${parentDisplay}）`)
  }

  async function stop({ display } = {}) {
    if (!display) throw new Error('需要 display 参数')
    const st = await readState(display)
    let killed = false
    if (st?.pid) { try { process.kill(st.pid, 'SIGTERM'); killed = true } catch {} }
    // 按进程名精确匹配，避免「同名字符串出现在调用者命令行里」导致误杀
    try {
      const { stdout } = await run('pgrep', ['-x', 'Xephyr'])
      for (const pid of stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
        try {
          const { stdout: cl } = await run('ps', ['-o', 'args=', '-p', pid])
          if (cl.startsWith(`${path.basename(bin.xephyr)} ${display} `)) { process.kill(Number(pid), 'SIGTERM'); killed = true }
        } catch {}
      }
    } catch {}
    await rm(stateFile(display), { force: true })
    return { display, killed }
  }

  // ── 观察 / 操作 ──────────────────────────────────────────────────────────
  async function snapshotBuffer(display) {
    const { stdout } = await run(bin.shot, ['-display', display, '-window', 'root', 'png:-'], {
      timeout: 30000, env: envFor(display), encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  }

  async function capture({ display, outPath } = {}) {
    if (!display) throw new Error('需要 display 参数')
    if (!(await alive(display))) throw new Error(`${display} 不在运行`)
    const out = outPath || path.join(stateDir, `shot-${String(display).replace(':', '')}-${Date.now()}.png`)
    await mkdir(path.dirname(out), { recursive: true })
    await run(bin.shot, ['-display', display, '-window', 'root', out], { timeout: 30000, env: envFor(display) })
    let size = null
    try { const { stdout } = await run('identify', ['-format', '%wx%h', out], { timeout: 8000 }); size = stdout.trim() } catch {}
    return { display, out, size }
  }

  async function windows({ display } = {}) {
    if (!display) throw new Error('需要 display 参数')
    const { stdout } = await run('xwininfo', ['-display', display, '-root', '-children'], { timeout: 8000, env: envFor(display) })
    return stdout.split('\n').filter((l) => /0x[0-9a-f]+ /.test(l)).map((l) => l.trim())
  }

  async function input({ display, kind, key, text: txt, x, y, window: wid } = {}) {
    if (!display) throw new Error('需要 display 参数')
    if (!kind) throw new Error('需要 kind 参数（key | type | click | focus）')
    const e = envFor(display)
    const w = wid ? ['--window', String(wid)] : []
    switch (kind) {
      case 'key':   await run(bin.xdotool, ['key', ...w, String(key)], { timeout: 8000, env: e }); break
      case 'type':  await run(bin.xdotool, ['type', ...w, '--delay', '60', String(txt ?? '')], { timeout: 20000, env: e }); break
      case 'click': await run(bin.xdotool, ['mousemove', String(x ?? 0), String(y ?? 0), 'click', '1'], { timeout: 8000, env: e }); break
      case 'focus': await run(bin.xdotool, ['windowfocus', String(wid)], { timeout: 8000, env: e }); break
      default: throw new Error(`不支持的 kind: ${kind}`)
    }
    return { display, kind, done: true }
  }

  async function runCommand({ display, command, args = [], timeoutMs = 60000 } = {}) {
    if (!display) throw new Error('需要 display 参数')
    if (!command) throw new Error('需要 command 参数')
    try {
      const { stdout, stderr } = await run(command, args, { timeout: timeoutMs, env: envFor(display), maxBuffer: 4 * 1024 * 1024 })
      return { display, command, exitCode: 0, stdout: stdout.slice(-8000), stderr: stderr.slice(-4000) }
    } catch (e) {
      return { display, command, exitCode: e.code ?? -1, stdout: (e.stdout || '').toString().slice(-8000), stderr: (e.stderr || e.message || '').toString().slice(-4000) }
    }
  }

  // ── Agent 工具 ───────────────────────────────────────────────────────────
  const D = { type: 'string', description: '隔离 display，如 ":9"（由 iso_display_start 返回）。' }
  const guard = (fn) => async (args, exec) => {
    try { return await fn(args || {}, exec) } catch (e) {
      const msg = e?.stderr?.toString?.() || e?.stdout?.toString?.() || e?.message || String(e)
      throw new Error(msg.trim().slice(0, 2000))
    }
  }

  const tools = [
    {
      name: 'iso_display_start',
      description: '启动一个隔离的虚拟 X display（Xephyr）。它会以普通窗口形式出现在用户桌面上，但内部是独立 X server：在其中可以任意抓屏、注入键鼠，且不抢用户焦点、不影响用户会话。返回 display 标识供其它 iso_display_* 工具使用。注意：Xephyr 不提供 DRI3，无法运行 Vulkan/3D 程序。',
      parameters: { type: 'object', additionalProperties: false, properties: { size: { type: 'string', description: '分辨率，如 "1280x720"（默认取插件配置）。' }, display: { type: 'string', description: '指定 display 编号，如 ":9"；省略则自动挑选空闲的。' } } },
      output: output(okSchema),
      execute: guard(start),
    },
    {
      name: 'iso_display_list',
      description: '列出由本插件启动的隔离 display 及各自是否仍在运行。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: output({ type: 'array', items: okSchema }),
      execute: guard(async () => listDisplays()),
    },
    {
      name: 'iso_display_stop',
      description: '停止指定的隔离 display 并清理其状态记录。',
      parameters: { type: 'object', additionalProperties: false, required: ['display'], properties: { display: D } },
      output: output(okSchema),
      execute: guard(stop),
    },
    {
      name: 'iso_display_run',
      description: '在隔离 display 里运行一个命令（其 DISPLAY 已指向该 display），并返回 stdout/stderr 与退出码。注意本工具是**同步**的：跑不会自己退出的 GUI 程序会一直等到 timeout，请用 sh -c "setsid 程序 &" 之类的写法后台启动。',
      parameters: { type: 'object', additionalProperties: false, required: ['display', 'command'], properties: { display: D, command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'integer', description: '超时毫秒，默认 60000。' } } },
      output: output(okSchema),
      execute: guard(runCommand),
    },
    {
      name: 'iso_display_capture',
      description: '从隔离 display 抓取整屏截图（真 X server，不受 XWayland 的 BadMatch 限制），返回 PNG 绝对路径与尺寸。',
      parameters: { type: 'object', additionalProperties: false, required: ['display'], properties: { display: D, outPath: { type: 'string', description: '输出 PNG 路径；省略则自动生成。' } } },
      output: output(okSchema),
      execute: guard(capture),
    },
    {
      name: 'iso_display_windows',
      description: '列出隔离 display 中当前的顶层窗口（含窗口 id 与标题）。',
      parameters: { type: 'object', additionalProperties: false, required: ['display'], properties: { display: D } },
      output: output({ type: 'array', items: { type: 'string' } }),
      execute: guard(windows),
    },
    {
      name: 'iso_display_input',
      description: '向隔离 display 注入输入。kind=key 按键（key 为 xdotool 键名，如 "Return"/"a"）；kind=type 输入文本；kind=click 在 (x,y) 点击；kind=focus 聚焦某窗口。给出 window 时 key/type 走 XSendEvent 定向投递，**不依赖焦点**。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['display', 'kind'],
        properties: {
          display: D,
          kind: { type: 'string', enum: ['key', 'type', 'click', 'focus'] },
          key: { type: 'string', description: 'kind=key 时的键名。' },
          text: { type: 'string', description: 'kind=type 时的文本。' },
          x: { type: 'integer' }, y: { type: 'integer' },
          window: { type: 'string', description: '窗口 id（十进制或 0x 十六进制）。' },
        },
      },
      output: output(okSchema),
      execute: guard(input),
    },
  ]

  for (const def of tools) ctx.effect(() => ctx.tools.register(def))

  // ── 给 Web UI 的 HTTP 路由 ───────────────────────────────────────────────
  // client.js 的侧边栏标签页靠这些路由拿画面、发输入。
  // 用 ctx.inject 而不是写进 inject：在没有 webServer 的 profile（如 headless）
  // 里插件仍然可用，只是少了 UI 那一半。
  const sendJson = (res, code, obj) => {
    const body = Buffer.from(JSON.stringify(obj))
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
    res.end(body)
  }
  const sendPng = (res, buf) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'no-store' })
    res.end(buf)
  }
  const readBody = (req) => new Promise((resolve) => {
    const chunks = []
    let n = 0
    req.on('data', (c) => { n += c.length; if (n > 1e6) { req.destroy(); return } chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  async function handleRoute(req, res) {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { return sendJson(res, 400, { error: 'bad url' }) }
    const action = url.pathname.replace(/^\/gui-isolation\/?/, '')
    const display = url.searchParams.get('display') || undefined
    try {
      switch (`${req.method} ${action}`) {
        case 'GET state':
          return sendJson(res, 200, { displays: await listDisplays(), defaultSize, parentDisplay })
        case 'GET snapshot': {
          if (!display) return sendJson(res, 400, { error: 'display required' })
          if (!(await alive(display))) return sendJson(res, 404, { error: `${display} 不在运行` })
          return sendPng(res, await snapshotBuffer(display))
        }
        case 'GET windows':
          if (!display) return sendJson(res, 400, { error: 'display required' })
          return sendJson(res, 200, { windows: await windows({ display }) })
        case 'POST start':
          return sendJson(res, 200, await start(await readBody(req)))
        case 'POST stop': {
          const body = await readBody(req)
          return sendJson(res, 200, await stop({ display: display || body.display }))
        }
        case 'POST input':
          return sendJson(res, 200, await input({ ...(await readBody(req)), display }))
        default:
          return sendJson(res, 404, { error: `no route for ${req.method} ${action}` })
      }
    } catch (e) {
      return sendJson(res, 500, { error: (e?.message || String(e)).slice(0, 500) })
    }
  }

  // 每个动作注册一条 **exact** 路由。
  // 实测教训：`kind: 'prefix'` + `path: '/gui-isolation/'` 只匹配到了
  // `/gui-isolation/` 本身，`/gui-isolation/state` 落到了 SPA 兜底 —— 精确路由最省心。
  const ROUTE_ACTIONS = ['state', 'snapshot', 'windows', 'start', 'stop', 'input']
  ctx.inject(['webServer'], (wctx) => {
    for (const action of ROUTE_ACTIONS) {
      wctx.effect(() => wctx.webServer.register({
        kind: 'exact',
        path: `/gui-isolation/${action}`,
        handler: handleRoute,
      }))
    }
  })

  // 卸载时**不**自动杀掉已启动的 display：它是用户可见的会话资源，
  // 静默清理反而让人困惑。显式用 iso_display_stop 或 UI 上的停止按钮收尾。
}
