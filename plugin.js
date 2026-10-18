// dsh-headless-display —— 在隔离的虚拟 X display 里驱动 GUI 程序
//
// ── 目标 ───────────────────────────────────────────────────────────────────
//   让 Agent **静默**完成 UI 操作：用户桌面上不出现任何窗口、不抢焦点。
//   为此另起独立的 X server（sway+Xwayland 或 Xvfb），自动化全部在它内部进行。
//
// ── 三种后端（实测） ───────────────────────────────────────────────────────
//   后端       桌面有窗口?   有 DRI3?   Vulkan           适合
//   ---------  ------------  --------  ---------------  ------------------------
//   xvfb       否            否        仅 lavapipe(CPU)  2D / X11，最轻
//   xephyr     是（会打扰）   否        ✗                需要可见窗口时
//   sway       否            **是**    **RADV 真 GPU**  **Proton/DXVK/VKD3D 游戏**
//
//   `backend: auto`：有 sway 就用 sway，失败回退 xvfb（结果带 fallback）。
//
// ── 两条「静默」硬保证（都是踩过坑换来的，改代码前先读懂） ─────────────────
//   1. 隔离 display 的编号靠**进程归属**判定：sway 以 detached 启动是进程组组长，
//      只认 pgid/ppid === sway.pid 的那个 Xwayland。曾经靠「探活失败即新 display」，
//      在 xauthority 过期时把用户桌面的 :1 当成隔离 display，命令全跑在用户屏上。
//   2. 子进程默认**钉到 X11**（GDK_BACKEND / QT_QPA_PLATFORM / SDL_VIDEODRIVER /
//      ELECTRON_OZONE_PLATFORM_HINT / XDG_SESSION_TYPE），并清掉 WAYLAND_DISPLAY：
//      libwayland 在它为空时默认连 $XDG_RUNTIME_DIR/wayland-0，也就是用户桌面。
//      需要 Wayland 客户端时用 exposeWaylandClients 或 iso_display_run 的 env。
//
// ── 本文件提供两件事 ───────────────────────────────────────────────────────
//   1. 给 Agent 的 10 个工具（iso_display_*）
//   2. 给浏览器 Web UI 的 HTTP 路由（/gui-isolation/*），供 client.js 的
//      侧边栏标签页拉取画面、注入输入
//
// 接口按后端无关设计；新增后端只需在 startBackend() 里加分支。
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, accessSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const run = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const name = 'dsh-headless-display'
export const inject = ['tools']

// 不声明 `Config`：Cordis 要求它是一个实现了 Standard Schema 的对象
// （`Config["~standard"].validate`）。零依赖的纯 JS bundle 拿不到 schema 库，
// 声明成裸 JSON Schema 会让插件激活失败。默认值写在代码里，
// 仍可通过 cordis.patch.yml 的 config 覆盖（不做校验）。

const text = (s) => [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }]
const output = (schema) => ({ schema, render: (_args, value) => text(value) })
const okSchema = { type: 'object', additionalProperties: true }

export function apply(ctx, config = {}) {
  const stateDir = config.stateDir || path.join(os.homedir(), '.dsh-headless-display')
  const [rangeLo, rangeHi] = config.displayRange || [9, 20]
  const defaultSize = config.defaultSize || '1280x720'
  const bin = {
    xephyr: config.xephyrPath || 'Xephyr',
    xvfb: config.xvfbPath || 'Xvfb',
    sway: config.swayPath || 'sway',
    vnc: config.x11vncPath || 'x11vnc',
    viewer: config.viewerPath || 'gvncviewer',
    xdotool: config.xdotoolPath || 'xdotool',
    shot: config.importPath || 'import',
    // sway 后端用它抓屏（import 在 Xwayland 上取不到根窗口）
    grim: config.grimPath || 'grim',
    // sway 后端的 display 是 Xwayland —— x11vnc 在此不可用（XGetImage 会 BadMatch），
    // 「打开真实窗口」改用 wayvnc（读 Wayland 输出）。
    wayvnc: config.wayvncPath || 'wayvnc',
    // 探活 / 窗口枚举 / 自检也要能报「装没装」，所以单独列出来
    xdpyinfo: config.xdpyinfoPath || 'xdpyinfo',
    xwininfo: config.xwininfoPath || 'xwininfo',
  }
  // 裸命令名不能直接用 existsSync 判断（它不是路径，永远 false）——
  // 沿 PATH 解析成绝对路径，解析不到就是没装。
  function which(cmd) {
    if (!cmd) return null
    if (cmd.includes('/')) return existsSync(cmd) ? cmd : null
    for (const d of String(process.env.PATH || '').split(':')) {
      if (!d) continue
      const p = path.join(d, cmd)
      if (existsSync(p)) return p
    }
    return null
  }
  const grimPath = which(bin.grim)
  const wayvncPath = which(bin.wayvnc)
  // 只有 TigerVNC 的 vncviewer 认识 -Shared；GTK-VNC 的 gvncviewer 不认识
  // （注意 gvncviewer 也以 "vncviewer" 结尾，所以要锚定整个 basename）
  const viewerPath = which(bin.viewer)
  const viewerIsTigerVnc = viewerPath ? path.basename(viewerPath) === 'vncviewer' : false
  // 后端默认 'auto'：有 sway 就用 sway（有 DRI3、能跑 3D/Proton 游戏），
  // 否则退 xvfb。两者桌面上都**不开任何窗口**，完全静默。
  // 需要看/亲手操作真实画面时，用「打开真实窗口」按需起 VNC 服务端 + 查看器
  // （sway 后端用 wayvnc，其余用 x11vnc）；关掉查看器即回到静默，**应用不重启**。
  // 想直接开可见窗口（旧行为）可把 backend 配成 'xephyr'。
  // 后端选择。'auto' = 有 sway 就用 sway（能跑 3D/Proton 游戏），否则退 xvfb。
  const backendCfg = config.backend || 'auto'
  if (!['sway', 'xvfb', 'xephyr', 'auto'].includes(backendCfg)) {
    throw new Error(`未知 backend: ${backendCfg}（可选 sway / xvfb / xephyr / auto）`)
  }
  // sway 可用性探测**懒执行**：apply() 是同步的，在这里 spawnSync 会阻塞 dsh 启动
  // 最多 5 秒（sway 不在 PATH 或响应慢时尤其明显）。首次真正要用时再探。
  let swayUsableCache
  function swayUsable() {
    if (swayUsableCache !== undefined) return Promise.resolve(swayUsableCache)
    return new Promise((resolve) => {
      if (!which(bin.sway)) { swayUsableCache = false; return resolve(false) }
      let settled = false
      const done = (v) => { if (!settled) { settled = true; swayUsableCache = v; resolve(v) } }
      try {
        const p = spawn(bin.sway, ['--version'], { stdio: 'ignore' })
        p.on('error', () => done(false))
        p.on('exit', (code) => done(code === 0))
        setTimeout(() => { try { p.kill() } catch {} done(false) }, 5000).unref?.()
      } catch { done(false) }
    })
  }
  const VNC_PORT_BASE = config.vncPortBase || 5900
  // 默认只操作**本插件自己启动的** display。外部 display（尤其是用户桌面的 :0/:1）
  // 一律拒绝写入，避免自动化误伤用户会话。
  const allowForeignDisplays = config.allowForeignDisplays === true
  // 是否把该实例的 wayland socket 显式交给子进程（默认**不**）：
  //   传了 → Wayland 原生客户端渲染进隔离合成器，但 xdotool（XTEST）**够不到**
  //          Wayland 客户端，键鼠注入会失效；
  //   不传 → GTK/Qt/Electron/SDL 全部退回 X11（Xwayland），xdotool / xwininfo /
  //          逐窗口聚焦都可正常工作 —— 这是自动化优先的默认。
  // 需要 Wayland 客户端时：置 true，或在 iso_display_run 的 env 里显式给绝对路径。
  const exposeWaylandClients = config.exposeWaylandClients === true
  // stop() 时是否顺带杀掉 DISPLAY 指向该 display 的客户端。
  // 起因：`iso_display_run` 里用 `setsid ... &` 起的 GUI 程序与 display 没有父子关系，
  // X server 一关它们**不一定**退出（游戏通常崩退，但普通 X 应用常变成孤儿）。
  const killClientsOnStop = config.killClientsOnStop !== false
  const parentDisplay = config.parentDisplay || process.env.DISPLAY || ':1'

  // dsh 宿主进程通常**不继承**桌面会话的 DISPLAY/XAUTHORITY（实测：host env 里
  // 两者都没有），所以必须在配置之外自动探测，否则 Xephyr/xdotool 连不上 X server。
  function detectXauthority() {
    // ★ 配置里的 xauthority 也可能是**过期路径**：不同设备的 xauth_XXXXXX 文件名不同，
    //   KDE 会话重启后还会换名。实测本机配置里留着上一轮的 xauth_ZALigT（文件已不存在），
    //   因为「配置优先」导致所有探活失败，进而把用户桌面的 :1 误判成新建的 display。
    //   所以配置路径同样要**校验存在性**，不存在就继续往下探测。
    if (config.xauthority && existsSync(config.xauthority)) return config.xauthority
    if (process.env.XAUTHORITY && existsSync(process.env.XAUTHORITY)) return process.env.XAUTHORITY
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

  // 每个 display 可能有**自己的** XAUTHORITY：sway 后端的 Xwayland 用的是
  // 私有 XDG_RUNTIME_DIR 里的 auth 文件，跟桌面会话那个不是同一个。
  // 该映射在 start 时填充，并在插件加载后从状态文件异步补回（DSH 重启后仍可用）。
  const displayAuth = new Map()
  // sway 后端每个实例都有自己的 wayland socket（在私有 XDG_RUNTIME_DIR 里）。
  // display → socket 的**绝对路径**，供 envFor() 注入：Wayland 原生程序（GTK4 /
  // Qt6 / Electron）于是渲染进隔离合成器，而不是用户桌面。
  const displayWayland = new Map()

  const envFor = (display) => {
    const env = { ...process.env, DISPLAY: display }
    // ★ 静默第一原则：宿主进程的 WAYLAND_DISPLAY 指向**用户桌面**的合成器
    //   （实测 dsh-web 的 env 是 WAYLAND_DISPLAY=wayland-0）。
    //   原样传给子进程，GTK4/Qt6/Electron 会优先走 Wayland，窗口直接开在用户桌面上。
    //   所以一律先剥掉桌面侧的会话变量。
    delete env.WAYLAND_DISPLAY
    delete env.XDG_SESSION_TYPE
    delete env.XDG_CURRENT_DESKTOP
    // sway 后端：注入该实例自己的 wayland socket。libwayland 接受**绝对路径**，
    // 所以不必改 XDG_RUNTIME_DIR —— 音频 / DBus / 字体缓存照旧可用。
    const isoWayland = displayWayland.get(display)
    if (isoWayland && exposeWaylandClients) {
      env.WAYLAND_DISPLAY = isoWayland
    } else {
      // ★ 只删 WAYLAND_DISPLAY **不够**：libwayland 在它为空时默认连
      //   `$XDG_RUNTIME_DIR/wayland-0` —— 正是**用户桌面**的合成器。
      //   （实测：删掉后 GTK 仍以 Wayland 客户端身份连上桌面。）
      //   所以默认显式把各工具包钉到 X11：X11 客户端由 Xwayland/Xvfb 承载，
      //   xdotool（XTEST）/ xwininfo / 逐窗口聚焦才能工作，且绝无窗口漏到桌面。
      env.GDK_BACKEND = 'x11'
      env.QT_QPA_PLATFORM = 'xcb'
      env.SDL_VIDEODRIVER = 'x11'
      env.ELECTRON_OZONE_PLATFORM_HINT = 'x11'
      env.XDG_SESSION_TYPE = 'x11'
    }
    if (displayAuth.has(display)) {
      // 已经探明了这个 display 的鉴权方式：'' 表示它**不需要**鉴权
      // （sway 的 Xwayland 常如此，它没带 -auth 参数）
      const a = displayAuth.get(display)
      if (a) env.XAUTHORITY = a
      else delete env.XAUTHORITY
    } else if (xauthority) {
      env.XAUTHORITY = xauthority
    }
    return env
  }

  // x11vnc 会**检测会话环境**：只要看到 Wayland 就拒绝服务
  //   "Wayland display server detected. ... Exiting."
  // 即使 -display 指向的是 Xwayland 也一样。所以必须剥掉这些变量，把它当纯 X11。
  const x11EnvFor = (display) => {
    const env = { ...envFor(display) }
    delete env.WAYLAND_DISPLAY
    delete env.XDG_SESSION_TYPE
    delete env.XDG_CURRENT_DESKTOP
    return env
  }

  // 用某个候选 XAUTHORITY 试连 display。返回该候选（'' = 无需鉴权）或 null（连不上）。
  async function tryAuth(display, cand) {
    const env = { ...process.env, DISPLAY: display }
    if (cand) env.XAUTHORITY = cand
    else delete env.XAUTHORITY
    try {
      await run(bin.xdpyinfo, ['-display', display], { timeout: 4000, env })
      return cand
    } catch { return null }
  }

  // 只判断「这个 display 现在是否可用」，不关心鉴权方式（用于启动前快照）
  async function probeAlive(display) {
    for (const cand of ['', xauthority]) if (await tryAuth(display, cand) !== null) return true
    return false
  }

  async function resolveAuth(display) {
    const fromCmd = await findWaylandAuth(display)
    const cands = fromCmd ? [fromCmd, '', xauthority] : ['', xauthority]
    for (const cand of cands) {
      const r = await tryAuth(display, cand)
      if (r !== null) return r
    }
    return null
  }

  const stateFile = (display) => path.join(stateDir, `${String(display).replace(':', '')}.json`)

  // display / size 的写法归一化。工具调用方（模型）经常写 "9"、":9.0"、" :9 "，
  // 旧实现会原样拼进 DISPLAY="9" → X 连不上但没人报错；这里统一成 ":9"。
  function normDisplay(d) {
    if (typeof d !== 'string' || !d.trim()) throw new Error('需要 display 参数（字符串，如 ":9"，由 iso_display_start 返回）')
    const m = d.trim().match(/^:?(\d+)(?:\.\d+)?$/)
    if (!m) throw new Error(`display 写法不对：${JSON.stringify(d)}（应形如 ":9" 或 "9"）`)
    return ':' + m[1]
  }
  function normSize(size, fallback) {
    const v = String(size ?? fallback ?? '')
    if (!/^\d+x\d+$/.test(v)) throw new Error(`size 写法不对：${JSON.stringify(size ?? fallback)}（应形如 "1280x720"）`)
    return v
  }
  // 串行化 start/stop：两个工具调用并发时，编号挑选 + 状态写入会互相覆盖
  // （实测：并发 start 导致两个实例抢同一个 display 号、状态文件被覆盖成孤儿进程）。
  let opChain = Promise.resolve()
  function serialized(fn) {
    const p = opChain.then(fn, fn)
    opChain = p.then(() => {}, () => {})
    return p
  }

  async function readState(display) {
    try { return JSON.parse(await readFile(stateFile(display), 'utf8')) } catch { return null }
  }

  // 只允许操作本插件自己启动的 display。外部 display（尤其用户桌面的 :0 / :1）
  // 一旦被自动化误伤就是「干扰用户」，所以默认拒绝写入。
  async function ensureOwned(display) {
    const st = await readState(display)
    if (!st && !allowForeignDisplays) {
      throw new Error(await alive(display)
        ? `${display} 不是本插件启动的 display（可能是用户桌面），已拒绝操作以免干扰用户；确需操作外部 display 请把配置 allowForeignDisplays 设为 true。`
        : `${display} 没有本插件的状态记录（可能已停止、编号写错，或不是本插件启动的），已拒绝操作。`)
    }
    return st
  }

  async function alive(display) {
    try { await run(bin.xdpyinfo, ['-display', display], { timeout: 4000, env: envFor(display) }); return true } catch { return false }
  }

  // 进程是否还活着（用于判断 visible / 清理陈旧状态）
  function pidAlive(pid) {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  // DSH 重启后本进程不认识既有 display，从状态文件把各自的 XAUTHORITY 与
  // wayland socket 补回。**同步**读：envFor() 是同步函数，异步恢复会有一段时间
  // 拿不到这些值（实测：重启后立刻 iso_display_run，WAYLAND_DISPLAY 会被漏掉）。
  try {
    if (existsSync(stateDir)) {
      for (const f of readdirSync(stateDir)) {
        if (!f.endsWith('.json')) continue
        try {
          const st = JSON.parse(readFileSync(path.join(stateDir, f), 'utf8'))
          const d = st?.display || (':' + f.replace(/\.json$/, ''))
          // 注意：'' 是有意义的值（该 display 无需鉴权），所以判「键存在」而非真值
          if (st && 'xauthority' in st) displayAuth.set(d, st.xauthority || '')
          if (st?.runDir && st?.waylandDisplay) displayWayland.set(d, path.join(st.runDir, st.waylandDisplay))
        } catch {}
      }
    }
  } catch {}

  async function listDisplays() {
    if (!existsSync(stateDir)) return []
    const names = (await readdir(stateDir)).filter((f) => f.endsWith('.json'))
    const out = []
    for (const f of names) {
      const display = ':' + f.replace(/\.json$/, '')
      const st = await readState(display)
      const isAlive = await alive(display)
      // ★ 自愈：display 已经死了就把这条状态记录清掉，避免留下陈旧条目
      //   （包名改过几次，历史上遗留的 stateDir/条目都可能指向早已不存在的 display）
      if (!isAlive && st) {
        try { await rm(stateFile(display), { force: true }) } catch {}
      }
      // ★ visible 不能只看「有没有记过 viewerPid」—— 查看器可能早已退出，
      //   那样 UI 会一直显示「关闭真实窗口」而实际什么都没有。
      const visible = isAlive && pidAlive(st?.viewerPid)
      const backendOf = st?.backend || (isAlive ? 'external' : undefined)
      // ★ 不能把 undefined 塞进对象：工具输出的 JSON 校验会报
      //   "value is not lossless JSON"（实测：只要存在一条 xvfb 记录，list 就整个失败）。
      const item = { display, alive: isAlive, visible }
      for (const [k, v] of [['size', st?.size], ['pid', st?.pid], ['backend', backendOf]]) {
        if (v !== undefined) item[k] = v
      }
      // sway 后端才有 DRI3 → Vulkan/GL 能直通 GPU
      if (backendOf === 'sway') item.gpu = true
      out.push(item)
    }
    return out.sort((a, b) => a.display.localeCompare(b.display, undefined, { numeric: true }))
  }

  // 挑一个空闲序号。只看 socket **文件存在** 会被上次 kill -9 留下的残留 socket
  // 永久占用；所以文件在但探活失败时，把 socket 与 lock 一起清掉复用这个序号。
  async function pickDisplay() {
    for (let n = rangeLo; n <= rangeHi; n++) {
      const sock = `/tmp/.X11-unix/X${n}`
      const lock = `/tmp/.X${n}-lock`
      if (!existsSync(sock)) return `:${n}`
      if (await alive(`:${n}`)) continue
      try { await rm(sock, { force: true }) } catch {}
      try { await rm(lock, { force: true }) } catch {}
      if (!existsSync(sock)) return `:${n}`
    }
    return null
  }

  // ── sway headless 后端 ────────────────────────────────────────────────────
  // 目的：拿到一个**有 DRI3 的 X display**，让 Vulkan/GL 直通 GPU，
  // 从而能跑 Proton + DXVK/VKD3D 的 Windows/DX 游戏，同时桌面上零窗口。
  //
  // 做法：给 sway 一个**私有 XDG_RUNTIME_DIR**（与用户桌面会话彻底隔离），
  // 以 WLR_BACKENDS=headless 启动；sway 自带 Xwayland，Xwayland 提供 DRI3。
  // display 号由 Xwayland 自己挑（sway 传 -displayfd），所以启动后**发现**它。
  // 私有 XDG_RUNTIME_DIR 的基路径。systemd 发行版有 /run/user/<uid>，非 systemd
  // （Void、Alpine、容器）没有 —— 逐个回退到 $XDG_RUNTIME_DIR、$TMPDIR。
  function pickRunBase() {
    if (config.swayRunDirBase) return config.swayRunDirBase
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    const cands = [
      ...(uid !== null ? [`/run/user/${uid}/dsh-iso`] : []),
      ...(process.env.XDG_RUNTIME_DIR ? [path.join(process.env.XDG_RUNTIME_DIR, 'dsh-iso')] : []),
      path.join(os.tmpdir(), `dsh-iso-${uid ?? 'u'}`),
    ]
    for (const c of cands) {
      try { accessSync(path.dirname(c), 0o2); return c } catch {}
    }
    return cands[cands.length - 1]
  }
  const swayRunBase = pickRunBase()

  function pickSwayIndex() {
    for (let n = 1; n <= 20; n++) {
      const dir = `${swayRunBase}-${n}`
      if (!existsSync(dir)) return n
      // ★ 自愈：目录还在、但里面那个 sway 已经不在了 —— 说明上次是异常退出
      //   （OOM / kill -9）没走 stop，runDir 留了下来。直接复用这个序号，
      //   否则崩溃累积到 20 次后插件就再也起不来。
      //   sway 的 ipc socket 名里带自己的 pid：sway-ipc.<uid>.<pid>.sock
      let alive_ = false
      try {
        const sock = readdirSync(dir).find((f) => f.startsWith('sway-ipc.'))
        const m = sock && sock.match(/sway-ipc\.\d+\.(\d+)\.sock$/)
        if (m && pidAlive(Number(m[1]))) alive_ = true
      } catch {}
      if (!alive_) return n
    }
    return null
  }

  function xSockets() {
    try { return new Set(readdirSync('/tmp/.X11-unix').filter((f) => /^X\d+$/.test(f))) }
    catch { return new Set() }
  }

  // Xwayland 的 cmdline 形如：
  //   /usr/bin/Xwayland :2 -auth /run/user/1000/dsh-iso-1/xauth_XXXX -listenfd 8 ...
  // 从里面取出这个 display 专属的 XAUTHORITY。
  async function findWaylandAuth(display) {
    try {
      const { stdout } = await run('pgrep', ['-a', '-x', 'Xwayland'])
      for (const line of String(stdout).split('\n')) {
        const m = line.match(/\bXwayland\s+(:\d+)\b[^\n]*?-auth\s+(\S+)/)
        if (m && m[1] === display) return m[2]
      }
    } catch {}
    return ''
  }

  // ── 进程归属 / 预检 ──────────────────────────────────────────────────────
  function requireBins(list) {
    const missing = list.filter(([, cmd]) => !which(cmd)).map(([label]) => label)
    if (missing.length) {
      throw new Error(`缺少可执行文件：${missing.join('、')}。先跑 iso_display_doctor 看本机的安装命令。`)
    }
  }

  // /tmp/.X<n>-lock 的内容是持有该 display 的 X server pid（Xvfb/Xephyr/Xwayland 都写）
  async function lockOwner(display) {
    try {
      const t = (await readFile(`/tmp/.X${String(display).replace(':', '')}-lock`, 'utf8')).trim()
      const n = Number(t)
      return Number.isFinite(n) && n > 0 ? n : null
    } catch { return null }
  }

  async function procField(pid, field) {
    try {
      const { stdout } = await run('ps', ['-o', `${field}=`, '-p', String(pid)], { timeout: 3000 })
      const n = Number(String(stdout).trim())
      return Number.isFinite(n) && n > 0 ? n : null
    } catch { return null }
  }

  // 找出**本次 sway 实例**拉起的 Xwayland。
  // 归属判据：sway 以 detached 启动 → 它是进程组组长，Xwayland 由它拉起，
  // 于是 pgid（或 ppid）=== sway.pid。这比「socket 文件新增」和「启动前是否活着」
  // 都可靠 —— 后者在 xauthority 过期时会把**用户桌面**的 :1 当成新建的 display
  // （实测发生过：`iso_display_run :1 env` 于是把命令跑在用户桌面上）。
  async function findOurXwayland(swayPid) {
    if (!swayPid) return null
    try {
      const { stdout } = await run('pgrep', ['-a', '-x', 'Xwayland'], { timeout: 5000 })
      for (const line of String(stdout).split('\n')) {
        const m = line.match(/^(\d+)\s+\S*Xwayland\s+(:\d+)\b(.*)$/)
        if (!m) continue
        const pid = Number(m[1])
        const [pgid, ppid] = await Promise.all([procField(pid, 'pgid'), procField(pid, 'ppid')])
        if (pgid !== swayPid && ppid !== swayPid) continue
        const auth = (m[3].match(/-auth\s+(\S+)/) || [])[1] || ''
        return { pid, display: m[2], auth }
      }
    } catch {}
    return null
  }

  async function startSway({ size = defaultSize } = {}) {
    requireBins([['sway', bin.sway], ['Xwayland', 'Xwayland'], ['grim', bin.grim]])
    const idx = pickSwayIndex()
    if (idx === null) throw new Error('sway 隔离实例已达上限（20 个）')
    const runDir = `${swayRunBase}-${idx}`
    // pickSwayIndex 可能复用一个「目录还在但 sway 已死」的序号，先清干净再用
    try { await rm(runDir, { recursive: true, force: true }) } catch {}
    await mkdir(runDir, { recursive: true, mode: 0o700 })
    try { await chmod(runDir, 0o700) } catch {}

    // 最小 sway 配置：headless 输出 + 明确启用 Xwayland
    const [w, h] = String(size).split('x')
    const confPath = path.join(stateDir, `sway-${idx}.conf`)
    await writeFile(confPath, [
      '# 由 dsh-headless-display 生成：headless 隔离 display',
      `output HEADLESS-1 resolution ${w || 1280}x${h || 720}`,
      'output * bg #000000 solid_color',
      'xwayland enable',
      '',
    ].join('\n'))

    // 快照：启动前**活着**的 display（安全网）与已有 socket 名（回退判据）。
    // 注意这只是「安全网」：真正判断哪个 display 是我们起的，靠下面的进程归属。
    const beforeLive = new Set()
    const beforeSocks = new Set()
    for (const f of xSockets()) {
      const d = ':' + f.slice(1)
      beforeSocks.add(d)
      if (await probeAlive(d)) { beforeLive.add(d); displayAuth.set(d, await resolveAuth(d) ?? '') }
    }
    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: runDir,
      WAYLAND_DISPLAY: 'wayland-iso',
      WLR_BACKENDS: 'headless',
      WLR_LIBINPUT_NO_DEVICES: '1',
      WLR_RENDERER_ALLOW_SOFTWARE: '1',
      XDG_SESSION_TYPE: 'wayland',
      XDG_CURRENT_DESKTOP: 'sway',
    }
    delete env.DISPLAY  // 别把用户桌面的 DISPLAY 传给 sway

    const child = spawn(bin.sway, ['-c', confPath], { detached: true, stdio: 'ignore', env })
    // spawn 的 ENOENT 是**异步** 'error' 事件；不监听会抛未捕获异常，直接带崩 dsh。
    child.on('error', () => {})
    child.unref()

    let target = ''
    let auth = ''
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500)
      if (child.pid && !pidAlive(child.pid)) break
      const ours = await findOurXwayland(child.pid)
      if (!ours) continue
      // Xwayland 起来到能连上还有一小段；用它的 auth 直接试
      const a = await tryAuth(ours.display, ours.auth)
      if (a === null) continue
      target = ours.display
      auth = a
    }

    // 回退：进程归属判不出来（例如 pgrep 不可用）时，按「启动前不存在的 socket 名」找。
    // 安全网仍然生效：绝不接受启动前活着 / 已存在的 socket / 用户桌面的 display。
    for (let i = 0; i < 10 && !target; i++) {
      await sleep(500)
      for (const f of xSockets()) {
        const d = ':' + f.slice(1)
        if (beforeSocks.has(d) || beforeLive.has(d) || d === parentDisplay) continue
        const a = await resolveAuth(d)
        if (a !== null) { target = d; auth = a; break }
      }
    }

    // ★ 安全网：绝不能把用户桌面的 display 当成隔离 display。
    //   实测事故：xauthority 配置过期 → 所有探活失败 → 把 :1（用户自己的
    //   XWayland）当成新建的 display，`iso_display_run` 于是操作了用户桌面。
    if (target && (target === parentDisplay || beforeLive.has(target))) {
      target = ''
      auth = ''
    }

    if (!target) {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
      try { process.kill(child.pid, 'SIGKILL') } catch {}
      try { await rm(runDir, { recursive: true, force: true }) } catch {}
      throw new Error('sway 未能在 30 秒内提供可用的 Xwayland display（检查 sway / Xwayland / grim 是否已安装、GPU 是否可用；用 iso_display_doctor 自检）')
    }

    displayAuth.set(target, auth)          // '' 也要记：表示该 display 无需鉴权
    // sway 自己挑 wayland socket 名（通常 wayland-1），不是我们传的 WAYLAND_DISPLAY，
    // 所以要看目录里实际出现了哪个 —— grim 抓屏与 Wayland 程序注入都要用它。
    let waylandDisplay = ''
    try {
      waylandDisplay = (await readdir(runDir)).find((f) => f.startsWith('wayland-') && !f.endsWith('.lock')) || ''
    } catch {}
    if (waylandDisplay) displayWayland.set(target, path.join(runDir, waylandDisplay))
    const st = {
      size, pid: child.pid, backend: 'sway', display: target, runDir, confPath,
      ...(waylandDisplay ? { waylandDisplay } : {}),
      xauthority: auth,
      parentDisplay, startedAt: new Date().toISOString(),
    }
    await writeFile(stateFile(target), JSON.stringify(st, null, 2))
    return {
      display: target, size, pid: child.pid, backend: 'sway', visible: false,
      runDir, ...(waylandDisplay ? { waylandDisplay } : {}),
      xauthority: auth, gpu: true,
      note: '该 display 有 DRI3，Vulkan/GL 直通 GPU，可跑 Proton/DXVK/VKD3D 游戏',
    }
  }

  // ── 启动 / 停止 ──────────────────────────────────────────────────────────
  // 单个后端的启动实现。拆出来是为了让 backend=auto 能在 sway 失败时回退 xvfb。
  async function startBackend(whichBackend, { size = defaultSize, display } = {}) {
    size = normSize(size, defaultSize)
    if (display !== undefined && display !== null && display !== '') display = normDisplay(display)
    // sway 后端的 display 号由 Xwayland 决定，无法指定；其余后端按区间挑。
    if (whichBackend === 'sway') return startSway({ size })
    const binName = whichBackend === 'xephyr' ? bin.xephyr : bin.xvfb
    requireBins([[whichBackend === 'xephyr' ? 'Xephyr' : 'Xvfb', binName]])
    const target = display || (await pickDisplay())
    if (!target) throw new Error(`display 区间 ${rangeLo}-${rangeHi} 已用满（先 iso_display_list 看有没有遗漏的）`)
    if (await alive(target)) {
      const st = await readState(target)
      if (st) return { display: target, size: st.size, alreadyRunning: true }
      throw new Error(`${target} 已被其它程序占用`)
    }
    let args, env
    if (whichBackend === 'xephyr') {
      // 可见窗口后端：会在用户桌面上开一个窗口（旧行为，会打扰用户）
      args = [target, '-screen', size, '-ac', '-noreset', '-title', `DSH isolated display ${target}`]
      env = { ...process.env, DISPLAY: parentDisplay, ...(xauthority ? { XAUTHORITY: xauthority } : {}) }
    } else {
      // Xvfb：真 headless，**没有任何窗口**。24 位色，禁 TCP 监听。
      const [w, h] = String(size).split('x')
      args = [target, '-screen', '0', `${w || 1280}x${h || 720}x24`, '-nolisten', 'tcp', '-ac']
      env = { ...process.env }
    }
    const child = spawn(binName, args, { detached: true, stdio: 'ignore', env })
    child.on('error', () => {})   // 不监听 'error' 会抛未捕获异常带崩 dsh
    child.unref()
    for (let i = 0; i < 30; i++) {
      await sleep(400)
      if (await alive(target)) {
        // ★ 校验编号归属：并发 start / 残留锁时，可能「连上的是别人的 X server」。
        //   锁文件里的 pid 必须是本次拉起的子进程，否则宁可失败也不写状态。
        const owner = await lockOwner(target)
        if (owner && owner !== child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch {}
          try { process.kill(child.pid, 'SIGKILL') } catch {}
          throw new Error(`${target} 的 X 锁属于 pid ${owner}，不是本次启动的 ${child.pid} —— 编号被并发占用，请重试`)
        }
        const st = { size, pid: child.pid, backend: whichBackend, parentDisplay, startedAt: new Date().toISOString() }
        await writeFile(stateFile(target), JSON.stringify(st, null, 2))
        return { display: target, size, pid: child.pid, backend: whichBackend, visible: whichBackend === 'xephyr', parentDisplay, silent: whichBackend !== 'xephyr' }
      }
    }
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    try { process.kill(child.pid, 'SIGKILL') } catch {}
    throw new Error(`${whichBackend === 'xephyr' ? 'Xephyr' : 'Xvfb'} 未能在 ${target} 上就绪`)
  }

  async function start({ size = defaultSize, display, backend: reqBackend } = {}) {
    size = normSize(size, defaultSize)
    if (display !== undefined && display !== null && display !== '') display = normDisplay(display)
    await mkdir(stateDir, { recursive: true })
    const want = reqBackend || backendCfg
    if (!['sway', 'xvfb', 'xephyr', 'auto'].includes(want)) {
      throw new Error(`未知 backend: ${want}（可选 sway / xvfb / xephyr / auto）`)
    }
    // auto：优先 sway（有 DRI3、能跑 3D/Proton），失败就回退 xvfb，并说明原因。
    const order = want === 'auto' ? ((await swayUsable()) ? ['sway', 'xvfb'] : ['xvfb']) : [want]
    const failures = []
    for (const b of order) {
      try {
        const r = await startBackend(b, { size, display })
        return failures.length ? { ...r, fallback: true, fallbackReason: failures.join(' | ') } : r
      } catch (e) {
        failures.push(`${b}: ${e?.message || String(e)}`)
      }
    }
    throw new Error(`无法启动隔离 display —— ${failures.join(' | ')}`)
  }

  // 按「进程名 + 该 display 参数前缀」精确找进程。不用 `pkill -f` —— 它会匹配到
  // 命令行里含有同样字符串的**任意**进程（历史上就这样误杀过自己的 shell）。
  async function killExactProcess(procName, argPrefix, signal = 'SIGTERM') {
    let n = 0
    try {
      const { stdout } = await run('pgrep', ['-x', procName])
      for (const pid of stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
        try {
          const { stdout: cl } = await run('ps', ['-o', 'args=', '-p', pid], { timeout: 3000 })
          if (cl.startsWith(argPrefix)) { process.kill(Number(pid), signal); n++ }
        } catch {}
      }
    } catch {}
    return n
  }

  // 尽力而为：扫描 /proc/<pid>/environ，找出 DISPLAY 指向该 display 的进程。
  // 很多桌面进程是 non-dumpable（读不到 environ），读不到就跳过 —— 宁漏勿错。
  async function killClients(display, signal = 'SIGTERM') {
    const killed = []
    let entries = []
    try { entries = readdirSync('/proc').filter((f) => /^\d+$/.test(f)) } catch { return killed }
    for (const name of entries) {
      const pid = Number(name)
      if (pid === process.pid) continue
      let env = ''
      try { env = readFileSync(`/proc/${name}/environ`, { encoding: 'utf8' }) } catch { continue }
      if (!env.split('\0').includes(`DISPLAY=${display}`)) continue
      try { process.kill(pid, signal); killed.push(pid) } catch {}
    }
    return killed
  }

  async function stop({ display } = {}) {
    display = normDisplay(display)
    const st = await readState(display)
    if (!st) {
      throw new Error(await alive(display)
        ? `${display} 不是本插件启动的 display（可能是用户桌面），拒绝停止`
        : `${display} 没有本插件的状态记录（可能已经停止，或编号写错）`)
    }
    let killed = false
    // 先收「真实窗口」一侧，避免查看器还连着 VNC 时先杀掉服务端
    for (const pid of [st?.viewerPid, st?.vncPid]) {
      if (!pid) continue
      try { process.kill(pid, 'SIGTERM'); killed = true } catch {}
    }
    if (st?.pid) {
      // detached 启动 → 是进程组组长，杀整组才能带走 Xwayland / Xvfb / Xephyr
      for (const sig of ['SIGTERM', 'SIGKILL']) {
        try { process.kill(-st.pid, sig); killed = true } catch {}
        try { process.kill(st.pid, sig); killed = true } catch {}
        await sleep(250)
        if (!pidAlive(st.pid)) break
      }
    }
    // 先收客户端：X server 一关，很多 X 应用会变成没有家的孤儿进程
    let clients = []
    if (killClientsOnStop) clients = await killClients(display)
    // 兜底：状态文件缺失或被改写时，按命令行前缀精确收尾
    await killExactProcess('Xephyr', `${path.basename(bin.xephyr)} ${display} `)
    await killExactProcess('x11vnc', `x11vnc -display ${display} `)
    // sway 的私有 XDG_RUNTIME_DIR（含其 wayland socket 与 xauth 文件）
    if (st?.runDir) { try { await rm(st.runDir, { recursive: true, force: true }) } catch {} }
    if (st?.confPath) { try { await rm(st.confPath, { force: true }) } catch {} }
    displayAuth.delete(display)
    displayWayland.delete(display)
    // Xvfb / Xephyr / Xwayland 被杀后可能留下 socket 与 lock；
    // 不清掉会永久占住该序号（旧实现正是这样把区间耗尽的）。
    const n = String(display).replace(':', '')
    if (!(await alive(display))) {
      try { await rm(`/tmp/.X11-unix/X${n}`, { force: true }) } catch {}
      try { await rm(`/tmp/.X${n}-lock`, { force: true }) } catch {}
    }
    await rm(stateFile(display), { force: true })
    return { display, killed, ...(clients.length ? { killedClients: clients } : {}) }
  }

  // ── 真实窗口（按需弹出 / 关闭）────────────────────────────────────────────
  // ego-browser 模型：默认静默跑，用户想看/想亲手操作时才弹出一个真实窗口。
  // 这里用 x11vnc 把该 display 暴露到本机回环，再用 VNC 查看器开一个窗口。
  // 关掉查看器即回到静默；被操作的应用程序**不受影响、无需重启**。
  function vncPort(display) {
    const n = Number(String(display).replace(':', '')) || 0
    return VNC_PORT_BASE + (n % 100)
  }

  async function popout({ display } = {}) {
    display = normDisplay(display)
    const st = (await ensureOwned(display)) || {}
    if (!(await alive(display))) throw new Error(`${display} 不在运行`)
    const port = vncPort(display)

    // 1) 起一个只监听回环、无密码的 VNC 服务端。
    //    ★ 两条完全不同的路径：
    //      · sway 后端 → 该 display 是 **Xwayland**。x11vnc 靠 XGetImage 读根窗口，
    //        在 Xwayland 上必然 BadMatch，**根本无法工作**；必须改用 wayvnc
    //        （走 wlr-screencopy 读 Wayland 输出）。
    //      · xvfb / xephyr → 真 X server，用 x11vnc。
    // sway 后端的 display 是 Xwayland：x11vnc 用 XGetImage 读根窗口，在 Xwayland 上
    // 必然 BadMatch，只能改用 wayvnc（wlr-screencopy）。缺 wayvnc 时**明确报错**，
    // 不要偷偷退回 x11vnc 让人对着 BadMatch 猜。
    const useWayvnc = st.backend === 'sway'
    if (useWayvnc && (!wayvncPath || !st.runDir)) {
      throw new Error('sway 后端的「打开真实窗口」需要 wayvnc（x11vnc 在 Xwayland 上不可用）；请先安装 wayvnc，或用 iso_display_doctor 看安装命令')
    }
    if (!useWayvnc && !which(bin.vnc)) throw new Error('缺少 x11vnc：无法打开真实窗口')
    requireBins([['VNC 查看器', bin.viewer]])
    let vncPid = st.vncPid
    let vncUp = false
    if (vncPid) { try { process.kill(vncPid, 0); vncUp = true } catch {} }
    if (!vncUp) {
      // wayvnc 的参数：0.9.x 的 `-r` 是 --render-cursor、`-p` 是 --show-performance，
      // **没有** -p/--port —— 端口只能靠位置参数。
      // 旧版（≤0.7）对位置参数的支持一致，所以位置参数最稳；
      // 带 -r 会画出鼠标指针，失败就退回纯位置参数再试一次。
      const vncExe = useWayvnc ? wayvncPath : bin.vnc
      const argSets = useWayvnc
        ? [['-r', '127.0.0.1', String(port)], ['127.0.0.1', String(port)]]
        : [['-display', display, '-rfbport', String(port), '-localhost',
            '-nopw', '-forever', '-shared', '-quiet', '-noxdamage']]
      const vncEnv = useWayvnc
        ? {
            ...process.env,
            XDG_RUNTIME_DIR: st.runDir,
            ...(st.waylandDisplay ? { WAYLAND_DISPLAY: st.waylandDisplay } : {}),
          }
        : x11EnvFor(display)
      let tried = []
      for (const args of argSets) {
        tried.push(`${path.basename(vncExe)} ${args.join(' ')}`)
        const vnc = spawn(vncExe, args, { detached: true, stdio: 'ignore', env: vncEnv })
        vnc.on('error', () => {})   // ENOENT 也不能带崩 dsh
        vnc.unref()
        for (let i = 0; i < 25 && !vncUp; i++) {
          await sleep(200)
          try { await run('bash', ['-c', `exec 3<>/dev/tcp/127.0.0.1/${port}`], { timeout: 1500 }); vncUp = true } catch {}
        }
        if (vncUp) { vncPid = vnc.pid; break }
        try { vnc.kill('SIGKILL') } catch {}
      }
      if (!vncUp) {
        throw new Error(`VNC 服务端未能在端口 ${port} 就绪（尝试过：${tried.join(' ; ')}）`)
      }
    }

    // 2) VNC 查看器：这就是用户看到的「真实窗口」
    //    ★ 必须 GDK_BACKEND=x11：GTK 查看器默认走 Wayland 原生窗口，
    //      那样既进不了 X11 窗口树、也无法被 xdotool 激活/抬升。
    //      强制 X11 后至少能在任务栏出现、可被脚本激活。
    //    ★ 参数与**地址语法**都按查看器实现区分（两者实测都踩过）：
    //      · TigerVNC `vncviewer`：认 `localhost::<端口>`，也认 `-Shared`
    //      · GTK-VNC `gvncviewer`：只认 `localhost:<display号>`（端口-offset），
    //        传 `::端口` 会被它当成默认 5900 → "连接被拒绝"，且它不认识 `-Shared`
    //        （传了直接 "未知选项" 退出）。服务端本身已允许多客户端
    //        （wayvnc 默认、x11vnc 带 -shared），所以不传 `-Shared` 没有副作用。
    const vncAddr = viewerIsTigerVnc
      ? `localhost::${port}`
      : `localhost:${port - VNC_PORT_BASE}`
    const viewerArgs = viewerIsTigerVnc ? [vncAddr, '-Shared'] : [vncAddr]
    // 查看器是**唯一**允许出现在用户桌面上的窗口，且只由用户/AI 显式 popout 触发。
    // GDK_BACKEND=x11 让它落到 XWayland（可被 xdotool 激活）；
    // 同时剥掉 WAYLAND_DISPLAY，避免某些构建无视 GDK_BACKEND 走原生 Wayland。
    const viewerEnv = { ...process.env, GDK_BACKEND: 'x11' }
    delete viewerEnv.WAYLAND_DISPLAY
    const viewer = spawn(bin.viewer, viewerArgs, { detached: true, stdio: 'ignore', env: viewerEnv })
    viewer.on('error', () => {})
    viewer.unref()

    // 3) 尽力把它抬到前台。
    //    注意：KDE Wayland 下 **XWayland 窗口抬不到原生 Wayland 窗口之上**（平台限制），
    //    所以这里只是「尽力而为」；窗口标题里带 display 名，用户可从任务栏找到它。
    if (st.parentDisplay || parentDisplay) {
      const pd = st.parentDisplay || parentDisplay
      const penv = { ...process.env, DISPLAY: pd, ...(xauthority ? { XAUTHORITY: xauthority } : {}) }
      for (let i = 0; i < 12; i++) {
        await sleep(500)
        try {
          const { stdout } = await run('xdotool', ['search', '--class', 'vnc'], { timeout: 2500, env: penv })
          const wid = stdout.split('\n').map((x) => x.trim()).filter(Boolean).pop()
          if (wid) { await run('xdotool', ['windowactivate', wid], { timeout: 2500, env: penv }); break }
        } catch {}
      }
    }

    await writeFile(stateFile(display), JSON.stringify({ ...st, vncPid, viewerPid: viewer.pid, vncPort: port }, null, 2))
    return { display, vncPort: port, vncPid, viewerPid: viewer.pid, visible: true,
             note: 'KDE Wayland 下弹出窗口可能不会自动到最前，可在任务栏点击' }
  }

  async function popin({ display } = {}) {
    display = normDisplay(display)
    const st = (await ensureOwned(display)) || {}
    let closed = false
    // ESRCH 表示进程本来就已退出 —— 对「窗口是否已关掉」而言同样是成功了，
    // 不能因为 kill 抛异常就报 closed:false（视图器启动失败时会这样）。
    if (st.viewerPid) {
      try { process.kill(st.viewerPid, 'SIGTERM'); closed = true }
      catch (e) { closed = e?.code === 'ESRCH' }
    }
    if (st.vncPid) { try { process.kill(st.vncPid, 'SIGTERM') } catch {} }
    await writeFile(stateFile(display), JSON.stringify({ ...st, vncPid: undefined, viewerPid: undefined }, null, 2))
    return { display, closed, visible: false }
  }

  // ── 观察 / 操作 ──────────────────────────────────────────────────────────
  // sway 后端的 display 是 **Xwayland**：`import -window root` 在 Xwayland 上取不到
  // 根窗口（BadMatch / 空图）。所以走 Wayland 侧抓屏 —— grim 用 wlr-screencopy，
  // 在 headless 后端上同样有效，抓到的就是那个虚拟输出。
  async function waylandEnvFor(display) {
    const st = await readState(display)
    if (!st?.runDir) return null
    return {
      ...process.env,
      XDG_RUNTIME_DIR: st.runDir,
      ...(st.waylandDisplay ? { WAYLAND_DISPLAY: st.waylandDisplay } : {}),
    }
  }

  // 统一抓屏：返回 { ok, via } 或抛错。via = 'grim' | 'import'
  async function shotTo(display, { out } = {}) {
    const wenv = await waylandEnvFor(display)
    if (wenv && grimPath) {
      const args = out ? [out] : ['-']
      const r = await run(grimPath, args, { timeout: 30000, env: wenv, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
      // 走 stdout 分支时把 buffer 带回去，别让上层再抓第二次（旧实现会抓两遍）
      return { via: 'grim', buffer: out ? null : r.stdout }
    }
    if (out) {
      await run(bin.shot, ['-display', display, '-window', 'root', out], { timeout: 30000, env: envFor(display) })
      return { via: 'import' }
    }
    const { stdout } = await run(bin.shot, ['-display', display, '-window', 'root', 'png:-'], {
      timeout: 30000, env: envFor(display), encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
    })
    return { via: 'import', buffer: stdout }
  }

  async function snapshotBuffer(display) {
    await ensureOwned(display)
    const r = await shotTo(display)
    if (r.buffer) return r.buffer
    // grim 走文件路径分支时不会给 buffer；这里再取一次到 stdout
    const wenv = await waylandEnvFor(display)
    const { stdout } = await run(grimPath, ['-'], { timeout: 30000, env: wenv, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
    return stdout
  }

  async function capture({ display, outPath } = {}) {
    display = normDisplay(display)
    await ensureOwned(display)
    if (!(await alive(display))) throw new Error(`${display} 不在运行`)
    const out = outPath || path.join(stateDir, `shot-${String(display).replace(':', '')}-${Date.now()}.png`)
    await mkdir(path.dirname(out), { recursive: true })
    const r = await shotTo(display, { out })
    let size = null
    let colors = null
    try {
      const { stdout } = await run('identify', ['-format', '%wx%h %k', out], { timeout: 8000 })
      const parts = stdout.trim().split(/\s+/)
      size = parts[0]
      colors = Number(parts[1])
    } catch {}
    const rec = { display, out, size, via: r.via }
    if (Number.isFinite(colors)) {
      rec.colors = colors
      if (colors <= 1) rec.note = '整屏只有一种颜色：display 里可能没有窗口；若明明有窗口却全黑，说明抓屏与 X 客户端不在同一显示上'
    }
    return rec
  }

  async function windows({ display } = {}) {
    display = normDisplay(display)
    await ensureOwned(display)
    const { stdout } = await run(bin.xwininfo, ['-display', display, '-root', '-children'], { timeout: 8000, env: envFor(display) })
    return stdout.split('\n').filter((l) => /0x[0-9a-f]+ /.test(l)).map((l) => l.trim())
  }

  async function input({ display, kind, key, text: txt, x, y, window: wid } = {}) {
    display = normDisplay(display)
    if (!kind) throw new Error('需要 kind 参数（key | type | click | focus）')
    await ensureOwned(display)
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

  async function runCommand({ display, command, args = [], timeoutMs = 60000, env: extraEnv } = {}) {
    display = normDisplay(display)
    if (!command) throw new Error('需要 command 参数')
    await ensureOwned(display)
    const env = envFor(display)
    if (extraEnv && typeof extraEnv === 'object') {
      for (const [k, v] of Object.entries(extraEnv)) {
        if (v === undefined || v === null) continue
        // ★ 静默目标的最后一道闸：不让 env 把 DISPLAY / WAYLAND_DISPLAY 指回用户桌面。
        //   envFor() 已经剥掉了宿主的那两个变量，这里只放行安全值。
        if (k === 'DISPLAY' && String(v) !== display) {
          throw new Error(`env.DISPLAY 只能是本 display（${display}），收到 ${v}`)
        }
        if (k === 'WAYLAND_DISPLAY') {
          // 只放行**本实例**的 socket：$XDG_RUNTIME_DIR/wayland-0 是用户桌面的合成器，
          // 放过去等于给隔离客户端开了通往用户会话的口子（黑盒测试抓到过）。
          const wst = await readState(display)
          const wl = String(v)
          if (!wst?.runDir || !wl.startsWith(wst.runDir + '/')) {
            throw new Error(`env.WAYLAND_DISPLAY 只接受本隔离实例 socket 的绝对路径（例如 ${wst?.runDir ? `${wst.runDir}/wayland-1` : '/run/user/1000/dsh-iso-1/wayland-1'}），收到 ${wl}`)
          }
        }
        env[k] = String(v)
      }
    }
    try {
      const { stdout, stderr } = await run(command, args, { timeout: timeoutMs, env, maxBuffer: 4 * 1024 * 1024 })
      return { display, command, exitCode: 0, stdout: stdout.slice(-8000), stderr: stderr.slice(-4000) }
    } catch (e) {
      // e.code 可能是数字（退出码）或字符串（'ENOENT' 等 spawn 错误）。
      // 统一 exitCode 为数字，原始值另放 errorCode —— 否则调用方按类型判断会踩空。
      const code = typeof e.code === 'number' ? e.code : -1
      const rec = {
        display, command, exitCode: code,
        stdout: (e.stdout || '').toString().slice(-8000),
        stderr: (e.stderr || e.message || '').toString().slice(-4000),
      }
      if (typeof e.code === 'string') rec.errorCode = e.code
      return rec
    }
  }

  // ── 环境自检 ─────────────────────────────────────────────────────────────
  // 换一台机器（不同发行版）时，一条命令回答三件事：缺什么、怎么装、能不能跑。
  // 包名只对 Debian/Ubuntu、Fedora、Arch 给出「可直接粘贴」的命令；其余发行版
  // 给通用包名清单，避免编错包名把人带沟里。
  const DEP_ROLES = {
    Xvfb: ['xvfb 后端'], Xephyr: ['xephyr 后端'], sway: ['sway 后端'], Xwayland: ['sway 后端'],
    grim: ['sway 后端抓屏'], xdpyinfo: ['探活/自检'], xwininfo: ['窗口枚举'],
    xdotool: ['键鼠注入'], import: ['x11 后端抓屏'], identify: ['截图尺寸'],
    x11vnc: ['xvfb/xephyr 弹出窗口'], wayvnc: ['sway 弹出窗口'], gvncviewer: ['弹出窗口的查看器'],
    vncviewer: ['弹出窗口的查看器（TigerVNC，可替代 gvncviewer）'],
  }
  const PACKAGES = {
    debian: {
      label: 'Debian/Ubuntu', cmd: 'sudo apt install -y',
      map: {
        Xvfb: 'xvfb', Xephyr: 'xserver-xephyr', sway: 'sway', Xwayland: 'xwayland',
        grim: 'grim', xdpyinfo: 'x11-utils', xwininfo: 'x11-utils', xdotool: 'xdotool',
        import: 'imagemagick', identify: 'imagemagick', x11vnc: 'x11vnc',
        wayvnc: 'wayvnc', gvncviewer: 'gvncviewer', vncviewer: 'tigervnc-viewer',
      },
    },
    fedora: {
      label: 'Fedora/RHEL', cmd: 'sudo dnf install -y',
      map: {
        Xvfb: 'xorg-x11-server-Xvfb', Xephyr: 'xorg-x11-server-Xephyr', sway: 'sway',
        Xwayland: 'xorg-x11-server-Xwayland', grim: 'grim', xdpyinfo: 'xorg-x11-utils',
        xwininfo: 'xorg-x11-utils', xdotool: 'xdotool', import: 'ImageMagick',
        identify: 'ImageMagick', x11vnc: 'x11vnc', wayvnc: 'wayvnc',
        gvncviewer: 'gtk-vnc', vncviewer: 'tigervnc',
      },
    },
    arch: {
      label: 'Arch/Manjaro', cmd: 'sudo pacman -S --needed',
      map: {
        Xvfb: 'xorg-server-xvfb', Xephyr: 'xorg-server-xephyr', sway: 'sway',
        Xwayland: 'xorg-xwayland', grim: 'grim', xdpyinfo: 'xorg-xdpyinfo',
        xwininfo: 'xorg-xwininfo', xdotool: 'xdotool', import: 'imagemagick',
        identify: 'imagemagick', x11vnc: 'x11vnc', wayvnc: 'wayvnc',
        gvncviewer: 'gtk-vnc', vncviewer: 'tigervnc',
      },
    },
  }

  async function detectDistro() {
    let id = ''
    let like = ''
    let pretty = ''
    try {
      const raw = await readFile('/etc/os-release', 'utf8')
      const get = (k) => (raw.match(new RegExp(`^${k}=("?)(.*)\\1$`, 'm')) || [])[2] || ''
      id = get('ID').toLowerCase()
      like = get('ID_LIKE').toLowerCase()
      pretty = get('PRETTY_NAME')
    } catch {}
    const keys = `${id} ${like}`
    const family = /debian|ubuntu/.test(keys) ? 'debian'
      : /fedora|rhel|centos|rocky|alma/.test(keys) ? 'fedora'
        : /arch|manjaro|endeavour/.test(keys) ? 'arch'
          : /suse/.test(keys) ? 'suse'
            : /alpine/.test(keys) ? 'alpine' : 'unknown'
    return { id, like, pretty: pretty || id || 'unknown', family }
  }

  // 哪些依赖是「本次配置下真正需要的」
  function neededDeps(resolvedBackend) {
    const need = new Set(['xdpyinfo', 'xdotool'])
    if (resolvedBackend === 'sway') { need.add('sway'); need.add('Xwayland'); need.add('grim'); need.add('wayvnc') }
    else if (resolvedBackend === 'xephyr') { need.add('Xephyr'); need.add('x11vnc') }
    else { need.add('Xvfb'); need.add('x11vnc') }
    // 抓屏：sway 用 grim；xvfb/xephyr 用 import + identify
    if (resolvedBackend !== 'sway') { need.add('import'); need.add('identify') }
    return need
  }

  async function doctor() {
    const distro = await detectDistro()
    const warnings = []
    const missing = []
    const resolvedBackend = backendCfg === 'auto' ? ((await swayUsable()) ? 'sway' : 'xvfb') : backendCfg
    const need = neededDeps(resolvedBackend)

    const deps = Object.entries(bin).filter(([k]) => k !== 'viewer').map(([k, cmd]) => {
      const KEY_NAME = { xephyr: 'Xephyr', xvfb: 'Xvfb', sway: 'sway', vnc: 'x11vnc', xdotool: 'xdotool',
        shot: 'import', grim: 'grim', wayvnc: 'wayvnc', xdpyinfo: 'xdpyinfo', xwininfo: 'xwininfo' }
      const name = KEY_NAME[k] || k
      const p = which(cmd)
      return {
        name, binary: cmd, found: !!p, path: p || null,
        role: (DEP_ROLES[name] || []).join(' / '),
        required: need.has(name),
        package: (PACKAGES[distro.family]?.map || {})[name] || undefined,
      }
    })
    deps.push({
      name: 'identify', binary: 'identify', found: !!which('identify'), path: which('identify'),
      role: '截图尺寸', required: need.has('identify'),
      package: (PACKAGES[distro.family]?.map || {}).identify,
    })
    // 查看器是二选一：gvncviewer 或 TigerVNC vncviewer
    const viewerOk = !!(which(bin.viewer) || which('vncviewer'))
    deps.push({ name: 'viewer', binary: bin.viewer, found: viewerOk, path: which(bin.viewer) || which('vncviewer'),
      role: '弹出窗口的查看器', required: false, package: (PACKAGES[distro.family]?.map || {}).gvncviewer })
    for (const d of deps) if (d.required && !d.found) missing.push(d.name)
    if (!viewerOk) warnings.push('没有 VNC 查看器：iso_display_popout 会失败（headless 自动化本身不受影响）')

    // GPU / DRI3：sway 后端需要能打开 render 节点
    const gpu = { renderNodes: [], accessible: false, inRenderGroup: false, note: '' }
    try {
      for (const f of readdirSync('/dev/dri')) if (f.startsWith('renderD')) gpu.renderNodes.push(`/dev/dri/${f}`)
    } catch {}
    for (const node of gpu.renderNodes) {
      try { await access(node, 0o2); gpu.accessible = true; break } catch {}
    }
    try {
      const groups = process.getgroups ? process.getgroups() : []
      // render 组 gid 从 /etc/group 里查
      const etc = await readFile('/etc/group', 'utf8')
      const m = etc.match(/^render:x:(\d+):/m)
      if (m && groups.includes(Number(m[1]))) gpu.inRenderGroup = true
    } catch {}
    if (resolvedBackend === 'sway') {
      if (!gpu.renderNodes.length) warnings.push('没有任何 /dev/dri/renderD*：sway 只能软件渲染（3D/Proton 会退到 llvmpipe）')
      else if (!gpu.accessible) warnings.push('打不开 render 节点：sway 可能只能软件渲染。确认用户在 render 组或有 ACL（本机 ACL 由 systemd-logind uaccess 提供）')
    }

    // 目录可写性：状态目录 + sway 私有 runtime 目录
    const dirs = { stateDir, writable: false, runDirBase: swayRunBase, runDirWritable: false }
    try {
      await mkdir(stateDir, { recursive: true })
      const probe = path.join(stateDir, `.probe-${Date.now()}`)
      await writeFile(probe, 'ok'); await rm(probe, { force: true })
      dirs.writable = true
    } catch {}
    try {
      await mkdir(`${swayRunBase}-probe`, { recursive: true, mode: 0o700 })
      const probe = path.join(`${swayRunBase}-probe`, 'p')
      await writeFile(probe, 'ok'); await rm(probe, { force: true })
      await rm(`${swayRunBase}-probe`, { recursive: true, force: true })
      dirs.runDirWritable = true
    } catch {}

    // 桌面 X 会话（仅 xephyr / 弹出窗口的「抬到前台」用得到）
    const x11 = { parentDisplay, alive: await probeAlive(parentDisplay), xauthority: xauthority || null }
    if (config.xauthority && !existsSync(config.xauthority)) {
      warnings.push(`配置里的 xauthority 不存在（${config.xauthority}），已忽略并自动探测：${xauthority || '无'}`)
    }

    const pkgs = [...new Set(missing.map((n) => (PACKAGES[distro.family]?.map || {})[n] || n))]
    const install = PACKAGES[distro.family] && pkgs.length
      ? `${PACKAGES[distro.family].cmd} ${pkgs.join(' ')}`
      : (pkgs.length ? `用发行版包管理器安装：${pkgs.join(' ')}` : '')
    const ok = missing.length === 0 && dirs.writable && (resolvedBackend !== 'sway' || dirs.runDirWritable)
    if (distro.family === 'unknown' && pkgs.length) warnings.push('未识别的发行版：安装命令只给了通用包名，请对照仓库确认')
    if (!x11.alive) warnings.push(`桌面 X display ${parentDisplay} 连不上：xephyr 后端与「弹出窗口后抬到前台」会受影响；headless 后端不受影响`)

    return {
      ok, host: { os: process.platform, distro: distro.pretty, family: distro.family, kernel: os.release(), desktop: process.env.XDG_CURRENT_DESKTOP || '', sessionType: process.env.XDG_SESSION_TYPE || '' },
      config: {
        backend: backendCfg, resolvedBackend, defaultSize, parentDisplay, stateDir,
        swayRunDirBase: swayRunBase, allowForeignDisplays, exposeWaylandClients,
      },
      backends: {
        sway: { available: await swayUsable(), gpu: resolvedBackend === 'sway' ? (gpu.accessible ? 'gpu' : 'software') : undefined },
        xvfb: { available: !!(which(bin.xvfb) && which(bin.xdpyinfo)) },
        xephyr: { available: !!(which(bin.xephyr) && x11.alive) },
      },
      deps, missing, install, gpu, dirs, x11, warnings,
      next: ok
        ? (resolvedBackend === 'sway'
          ? 'sway 后端可用（有 GPU）→ 直接 iso_display_start，桌面零窗口'
          : 'xvfb 后端可用（无 GPU）→ 直接 iso_display_start；3D/Proton 游戏需要先装 sway')
        : '先把 missing 里的可执行文件装上（见 install），再跑一次自检',
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
      name: 'iso_display_doctor',
      description: '自检运行环境：逐项检查依赖（sway / Xvfb / Xwayland / grim / xdotool / x11vnc / wayvnc / VNC 查看器 / xdpyinfo / xwininfo / ImageMagick）、'
        + 'GPU 与 DRI3 可用性、状态目录与私有 runtime 目录的可写性、桌面 X 会话是否连得上；'
        + '缺什么就按当前发行版（Debian/Ubuntu、Fedora、Arch）给出可直接粘贴的安装命令。'
        + '换机器部署、或 iso_display_start 报错时先跑它。返回 { ok, missing, install, warnings, ... }。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: output(okSchema),
      execute: guard(async () => doctor()),
    },
    {
      name: 'iso_display_start',
      description: '启动一个隔离的 display，返回 display 标识供其它 iso_display_* 工具使用。'
        + '后端由插件配置的 backend 决定（默认 auto：有 sway 用 sway，否则 xvfb）：'
        + 'sway = 真 headless 且**有 DRI3**，Vulkan/GL 直通 GPU，**可跑 Proton/DXVK/VKD3D 的 Windows/DX 游戏**；'
        + 'xvfb = 真 headless 但无 DRI3，Vulkan 只能落 lavapipe（CPU 软渲），适合 2D/X11；'
        + 'xephyr = 会在用户桌面上开一个窗口（旧行为）。'
        + '三者都与用户会话隔离：不抢焦点、可任意抓屏与注入键鼠。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          size: { type: 'string', description: '分辨率，如 "1280x720"（默认取插件配置）。' },
          display: { type: 'string', description: '指定 display 编号，如 ":9"；省略则自动挑选空闲的（仅 xvfb/xephyr；sway 的编号由 Xwayland 决定）。' },
          backend: { type: 'string', enum: ['auto', 'sway', 'xvfb', 'xephyr'], description: '本次启动用哪个后端；省略则沿用插件配置。auto 会在 sway 启动失败时自动回退 xvfb，并在结果里给 fallback/fallbackReason。' },
        },
      },
      output: output(okSchema),
      execute: guard((a) => serialized(() => start(a))),
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
      execute: guard((a) => serialized(() => stop(a))),
    },
    {
      name: 'iso_display_run',
      description: '在隔离 display 里运行一个命令（其 DISPLAY 已指向该 display），并返回 stdout/stderr 与退出码。注意本工具是**同步**的：跑不会自己退出的 GUI 程序会一直等到 timeout，请用 sh -c "setsid 程序 &" 之类的写法后台启动。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['display', 'command'],
        properties: {
          display: D, command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          timeoutMs: { type: 'integer', description: '超时毫秒，默认 60000。' },
          env: {
            type: 'object', additionalProperties: { type: 'string' },
            description: '追加/覆盖的环境变量，适合 Proton 游戏（STEAM_COMPAT_CLIENT_INSTALL_PATH / STEAM_COMPAT_DATA_PATH / SteamAppId / WINEDEBUG 等）。'
              + '安全限制：DISPLAY 只能等于本 display；WAYLAND_DISPLAY 只接受隔离实例 socket 的绝对路径。',
          },
        },
      },
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
    {
      name: 'iso_display_popout',
      description: '把一个隔离 display 的**真实窗口**弹出来给用户看/亲手操作（默认是纯 headless、桌面上没有任何窗口）。实现方式：在该 display 上启动只监听本机回环的 x11vnc，再用 VNC 查看器开一个窗口。**不影响正在运行的程序，无需重启**；关掉窗口（iso_display_popin）即回到静默。',
      parameters: { type: 'object', additionalProperties: false, required: ['display'], properties: { display: D } },
      output: output(okSchema),
      execute: guard(popout),
    },
    {
      name: 'iso_display_popin',
      description: '关闭先前用 iso_display_popout 弹出的真实窗口，回到静默（隔离 display 与其中的程序继续运行）。',
      parameters: { type: 'object', additionalProperties: false, required: ['display'], properties: { display: D } },
      output: output(okSchema),
      execute: guard(popin),
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
        case 'GET doctor':
          return sendJson(res, 200, await doctor())
        case 'GET snapshot': {
          if (!display) return sendJson(res, 400, { error: 'display required' })
          if (!(await alive(display))) return sendJson(res, 404, { error: `${display} 不在运行` })
          return sendPng(res, await snapshotBuffer(display))
        }
        case 'GET windows':
          if (!display) return sendJson(res, 400, { error: 'display required' })
          return sendJson(res, 200, { windows: await windows({ display }) })
        case 'POST start': {
          const body = await readBody(req)
          return sendJson(res, 200, await serialized(() => start(body)))
        }
        case 'POST stop': {
          const body = await readBody(req)
          return sendJson(res, 200, await serialized(() => stop({ display: display || body.display })))
        }
        case 'POST input': {
          // 注意：query 的 display 只在**存在时**才覆盖 body —— 之前写成 `{ ...body, display }`
          // 会让 query 缺失时的 undefined 覆盖 body 里的 display，面板的点击/输入全部 500。
          const body = await readBody(req)
          return sendJson(res, 200, await input({ ...body, display: display ?? body.display }))
        }
        case 'POST popout':
          return sendJson(res, 200, await popout({ ...(await readBody(req)), display }))
        case 'POST popin':
          return sendJson(res, 200, await popin({ ...(await readBody(req)), display }))
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
  const ROUTE_ACTIONS = ['state', 'doctor', 'snapshot', 'windows', 'start', 'stop', 'input', 'popout', 'popin']
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
