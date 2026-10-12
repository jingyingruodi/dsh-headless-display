// dsh-headless-display —— 在隔离的虚拟 X display 里驱动 GUI 程序
//
// ── 为什么需要 ─────────────────────────────────────────────────────────────
//   用户的桌面是 KDE **Wayland**。在 Wayland 主桌面上：
//     * 无法把输入注入到「非焦点窗口」（XTEST 打给当前焦点；XSendEvent 多数程序不理会）
//     * 抓屏受 XWayland 限制（`import -window root` 直接 BadMatch）
//     * 任何自动化都会抢焦点、干扰用户
//   解法：用 Xephyr 在用户桌面上开一个窗口，**内部却是独立的 X server**。
//   在那个 display 里，XTEST / XSendEvent / 抓屏全部正常，且与用户会话完全隔离。
//
// ── 三种后端与能力边界（实测） ─────────────────────────────────────────────
//   后端       桌面上有窗口?   有 DRI3?   Vulkan           适合
//   ---------  -------------  --------  ---------------  ------------------------
//   xvfb       否             否        仅 lavapipe(CPU)  2D / X11，最轻
//   xephyr     是（会打扰）    否        ✗                需要可见窗口时
//   sway       否             **是**    **RADV 真 GPU**  **Proton/DXVK/VKD3D 游戏**
//
//   Xvfb/Xephyr 无 DRI3 时 `vkcube` 会打印
//     "No DRI3 support detected - required for presentation"
//   并自动退到 llvmpipe；UE 游戏则直接 EXCEPTION_INT_DIVIDE_BY_ZERO。
//
//   `sway` 后端的做法：起一个**私有** XDG_RUNTIME_DIR 的 sway
//   （`WLR_BACKENDS=headless`），它自带 Xwayland —— Xwayland 提供 DRI3，
//   Vulkan/GL 因而直通 GPU。sway 的 wayland socket 在私有 runtime dir 里，
//   与用户桌面会话完全不相干。
//
// ── 本文件提供两件事 ───────────────────────────────────────────────────────
//   1. 给 Agent 的 9 个工具（iso_display_*）
//   2. 给浏览器 Web UI 的 HTTP 路由（/gui-isolation/*），供 client.js 的
//      侧边栏标签页拉取画面、注入输入
//
// 接口按后端无关设计；新增后端只需在 start()/stop() 里加分支。

import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
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
  // 默认后端 = **Xvfb（真 headless）**：桌面上**不开任何窗口**，完全静默。
  // 需要看/亲手操作真实画面时，用「打开真实窗口」按需启动 x11vnc + VNC 查看器；
  // 关掉查看器即回到静默，**应用不重启**（这正是 dsh-ego-browser 的模型）。
  // 想直接开可见窗口（旧行为）可把 backend 配成 'xephyr'。
  // 后端选择。'auto' = 有 sway 就用 sway（能跑 3D/Proton 游戏），否则退 xvfb。
  const backendCfg = config.backend || 'auto'
  const swayAvailable = (() => {
    try {
      const p = spawnSync(bin.sway, ['--version'], { stdio: 'ignore', timeout: 5000 })
      return p.status === 0
    } catch { return false }
  })()
  const backend = backendCfg === 'auto' ? (swayAvailable ? 'sway' : 'xvfb') : backendCfg
  if (!['sway', 'xvfb', 'xephyr'].includes(backend)) {
    throw new Error(`未知 backend: ${backend}（可选 sway / xvfb / xephyr / auto）`)
  }
  const VNC_PORT_BASE = config.vncPortBase || 5900
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

  // 每个 display 可能有**自己的** XAUTHORITY：sway 后端的 Xwayland 用的是
  // 私有 XDG_RUNTIME_DIR 里的 auth 文件，跟桌面会话那个不是同一个。
  // 该映射在 start 时填充，并在插件加载后从状态文件异步补回（DSH 重启后仍可用）。
  const displayAuth = new Map()

  const envFor = (display) => {
    const auth = displayAuth.get(display) || xauthority
    return {
      ...process.env,
      DISPLAY: display,
      ...(auth ? { XAUTHORITY: auth } : {}),
    }
  }

  const stateFile = (display) => path.join(stateDir, `${String(display).replace(':', '')}.json`)

  async function readState(display) {
    try { return JSON.parse(await readFile(stateFile(display), 'utf8')) } catch { return null }
  }

  async function alive(display) {
    try { await run('xdpyinfo', ['-display', display], { timeout: 4000, env: envFor(display) }); return true } catch { return false }
  }

  // 进程是否还活着（用于判断 visible / 清理陈旧状态）
  function pidAlive(pid) {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  // DSH 重启后本进程不认识既有 display，从状态文件把各自的 XAUTHORITY 补回。
  // 不 await：apply() 是同步的，这里只是尽力而为地恢复。
  void (async () => {
    try {
      if (!existsSync(stateDir)) return
      for (const f of await readdir(stateDir)) {
        if (!f.endsWith('.json')) continue
        try {
          const st = JSON.parse(await readFile(path.join(stateDir, f), 'utf8'))
          const d = st?.display || (':' + f.replace(/\.json$/, ''))
          if (st?.xauthority) displayAuth.set(d, st.xauthority)
        } catch {}
      }
    } catch {}
  })()

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
      out.push({
        display, alive: isAlive, size: st?.size, pid: st?.pid, backend: backendOf, visible,
        // sway 后端才有 DRI3 → Vulkan/GL 能直通 GPU
        gpu: backendOf === 'sway' ? true : undefined,
      })
    }
    return out.sort((a, b) => a.display.localeCompare(b.display, undefined, { numeric: true }))
  }

  function pickDisplay() {
    for (let n = rangeLo; n <= rangeHi; n++) if (!existsSync(`/tmp/.X11-unix/X${n}`)) return `:${n}`
    return null
  }

  // ── sway headless 后端 ────────────────────────────────────────────────────
  // 目的：拿到一个**有 DRI3 的 X display**，让 Vulkan/GL 直通 GPU，
  // 从而能跑 Proton + DXVK/VKD3D 的 Windows/DX 游戏，同时桌面上零窗口。
  //
  // 做法：给 sway 一个**私有 XDG_RUNTIME_DIR**（与用户桌面会话彻底隔离），
  // 以 WLR_BACKENDS=headless 启动；sway 自带 Xwayland，Xwayland 提供 DRI3。
  // display 号由 Xwayland 自己挑（sway 传 -displayfd），所以启动后**发现**它。
  const swayRunBase = config.swayRunDirBase
    || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}/dsh-iso` : path.join(os.tmpdir(), 'dsh-iso'))

  function pickSwayIndex() {
    for (let n = 1; n <= 20; n++) if (!existsSync(`${swayRunBase}-${n}`)) return n
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

  async function startSway({ size = defaultSize } = {}) {
    const idx = pickSwayIndex()
    if (idx === null) throw new Error('sway 隔离实例已达上限（20 个）')
    const runDir = `${swayRunBase}-${idx}`
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

    const before = xSockets()
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
    child.unref()

    // Xwayland 需要鉴权，所以发现新 socket 后**先取到它自己的 auth**，再判断可用性
    let target = ''
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500)
      for (const f of xSockets()) {
        if (before.has(f)) continue
        const d = ':' + f.slice(1)
        const a = await findWaylandAuth(d)
        if (a) displayAuth.set(d, a)
        if (await alive(d)) { target = d; break }
      }
      if (child.pid && !pidAlive(child.pid)) break
    }

    if (!target) {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
      try { await rm(runDir, { recursive: true, force: true }) } catch {}
      throw new Error('sway 未能在 30 秒内提供可用的 Xwayland display（检查 sway / Xwayland 是否已安装）')
    }

    const auth = displayAuth.get(target) || ''
    // sway 自己挑 wayland socket 名（通常 wayland-1），不是我们传的 WAYLAND_DISPLAY，
    // 所以要看目录里实际出现了哪个 —— grim 抓屏要用它。
    let waylandDisplay = ''
    try {
      waylandDisplay = (await readdir(runDir)).find((f) => f.startsWith('wayland-') && !f.endsWith('.lock')) || ''
    } catch {}
    const st = {
      size, pid: child.pid, backend: 'sway', display: target, runDir, confPath,
      ...(waylandDisplay ? { waylandDisplay } : {}),
      ...(auth ? { xauthority: auth } : {}),
      parentDisplay, startedAt: new Date().toISOString(),
    }
    await writeFile(stateFile(target), JSON.stringify(st, null, 2))
    return {
      display: target, size, pid: child.pid, backend: 'sway', visible: false,
      runDir, ...(waylandDisplay ? { waylandDisplay } : {}),
      ...(auth ? { xauthority: auth } : {}), gpu: true,
      note: '该 display 有 DRI3，Vulkan/GL 直通 GPU，可跑 Proton/DXVK/VKD3D 游戏',
    }
  }

  // ── 启动 / 停止 ──────────────────────────────────────────────────────────
  async function start({ size = defaultSize, display } = {}) {
    await mkdir(stateDir, { recursive: true })
    // sway 后端的 display 号由 Xwayland 决定，无法指定；其余后端按区间挑。
    if (backend === 'sway') return startSway({ size })
    const target = display || pickDisplay()
    if (!target) throw new Error(`display 区间 ${rangeLo}-${rangeHi} 已用满`)
    if (await alive(target)) {
      const st = await readState(target)
      if (st) return { display: target, size: st.size, alreadyRunning: true }
      throw new Error(`${target} 已被其它程序占用`)
    }
    let args, env
    if (backend === 'xephyr') {
      // 可见窗口后端：会在用户桌面上开一个窗口（旧行为，会打扰用户）
      args = [target, '-screen', size, '-ac', '-noreset', '-title', `DSH isolated display ${target}`]
      env = { ...process.env, DISPLAY: parentDisplay, ...(xauthority ? { XAUTHORITY: xauthority } : {}) }
    } else {
      // Xvfb：真 headless，**没有任何窗口**。深色 24 位，禁 TCP 监听。
      const [w, h] = String(size).split('x')
      args = [target, '-screen', '0', `${w || 1280}x${h || 720}x24`, '-nolisten', 'tcp', '-ac']
      env = { ...process.env }
    }
    const child = spawn(backend === 'xephyr' ? bin.xephyr : bin.xvfb, args, {
      detached: true, stdio: 'ignore', env,
    })
    child.unref()
    for (let i = 0; i < 30; i++) {
      await sleep(400)
      if (await alive(target)) {
        const st = { size, pid: child.pid, backend, parentDisplay, startedAt: new Date().toISOString() }
        await writeFile(stateFile(target), JSON.stringify(st, null, 2))
        return { display: target, size, pid: child.pid, backend, visible: backend === 'xephyr', parentDisplay }
      }
    }
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    throw new Error(`${backend === 'xephyr' ? 'Xephyr' : 'Xvfb'} 未能在 ${target} 上就绪`)
  }

  async function stop({ display } = {}) {
    if (!display) throw new Error('需要 display 参数')
    const st = await readState(display)
    let killed = false
    if (st?.pid) {
      // sway 后端：它以 detached 启动，是进程组组长 —— 杀整组才能把
      // 它拉起的 Xwayland 一并收掉，否则会留下孤儿 X server。
      if (st.backend === 'sway') { try { process.kill(-st.pid, 'SIGTERM'); killed = true } catch {} }
      try { process.kill(st.pid, 'SIGTERM'); killed = true } catch {}
    }
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
    // 一并收掉「真实窗口」相关的进程，避免留下孤儿
    if (st?.viewerPid) { try { process.kill(st.viewerPid, 'SIGTERM') } catch {} }
    if (st?.vncPid) { try { process.kill(st.vncPid, 'SIGTERM') } catch {} }
    try { await run('pkill', ['-f', `x11vnc -display ${display} `]) } catch {}
    // sway 的私有 XDG_RUNTIME_DIR（含其 wayland socket 与 xauth 文件）
    if (st?.runDir) { try { await rm(st.runDir, { recursive: true, force: true }) } catch {} }
    if (st?.confPath) { try { await rm(st.confPath, { force: true }) } catch {} }
    displayAuth.delete(display)
    await rm(stateFile(display), { force: true })
    return { display, killed }
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
    if (!display) throw new Error('需要 display 参数')
    if (!(await alive(display))) throw new Error(`${display} 不在运行`)
    const st = (await readState(display)) || {}
    const port = vncPort(display)

    // 1) x11vnc：只监听回环、无密码、允许多个查看器
    let vncPid = st.vncPid
    let vncUp = false
    if (vncPid) { try { process.kill(vncPid, 0); vncUp = true } catch {} }
    if (!vncUp) {
      const vnc = spawn(bin.vnc, ['-display', display, '-rfbport', String(port), '-localhost',
                                  '-nopw', '-forever', '-shared', '-quiet', '-noxdamage'], {
        detached: true, stdio: 'ignore', env: { ...process.env },
      })
      vnc.unref()
      vncPid = vnc.pid
      for (let i = 0; i < 25; i++) {
        await sleep(200)
        try { await run('bash', ['-c', `exec 3<>/dev/tcp/127.0.0.1/${port}`], { timeout: 1500 }); vncUp = true; break } catch {}
      }
      if (!vncUp) throw new Error(`x11vnc 未能在端口 ${port} 就绪`)
    }

    // 2) VNC 查看器：这就是用户看到的「真实窗口」
    //    ★ 必须 GDK_BACKEND=x11：GTK 查看器默认走 Wayland 原生窗口，
    //      那样既进不了 X11 窗口树、也无法被 xdotool 激活/抬升。
    //      强制 X11 后至少能在任务栏出现、可被脚本激活。
    const viewer = spawn(bin.viewer, [`localhost::${port}`, '-Shared'], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, GDK_BACKEND: 'x11' },
    })
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
    if (!display) throw new Error('需要 display 参数')
    const st = (await readState(display)) || {}
    let closed = false
    if (st.viewerPid) { try { process.kill(st.viewerPid, 'SIGTERM'); closed = true } catch {} }
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
      await run(grimPath, args, { timeout: 30000, env: wenv, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
      return { via: 'grim', buffer: out ? null : undefined }
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
    const r = await shotTo(display)
    if (r.buffer) return r.buffer
    // grim 走文件路径分支时不会给 buffer；这里再取一次到 stdout
    const wenv = await waylandEnvFor(display)
    const { stdout } = await run(grimPath, ['-'], { timeout: 30000, env: wenv, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
    return stdout
  }

  async function capture({ display, outPath } = {}) {
    if (!display) throw new Error('需要 display 参数')
    if (!(await alive(display))) throw new Error(`${display} 不在运行`)
    const out = outPath || path.join(stateDir, `shot-${String(display).replace(':', '')}-${Date.now()}.png`)
    await mkdir(path.dirname(out), { recursive: true })
    const r = await shotTo(display, { out })
    let size = null
    try { const { stdout } = await run('identify', ['-format', '%wx%h', out], { timeout: 8000 }); size = stdout.trim() } catch {}
    return { display, out, size, via: r.via }
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
      description: '启动一个隔离的 display，返回 display 标识供其它 iso_display_* 工具使用。'
        + '后端由插件配置的 backend 决定（默认 auto：有 sway 用 sway，否则 xvfb）：'
        + 'sway = 真 headless 且**有 DRI3**，Vulkan/GL 直通 GPU，**可跑 Proton/DXVK/VKD3D 的 Windows/DX 游戏**；'
        + 'xvfb = 真 headless 但无 DRI3，Vulkan 只能落 lavapipe（CPU 软渲），适合 2D/X11；'
        + 'xephyr = 会在用户桌面上开一个窗口（旧行为）。'
        + '三者都与用户会话隔离：不抢焦点、可任意抓屏与注入键鼠。',
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
  const ROUTE_ACTIONS = ['state', 'snapshot', 'windows', 'start', 'stop', 'input', 'popout', 'popin']
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
