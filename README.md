# dsh-isolated-x11

在**隔离的虚拟 X display**（Xephyr）里运行并操作 GUI 程序 —— 不抢用户焦点、不占用桌面。
给 Agent 提供 7 个工具，并在 DSH Web 界面里提供一个**可看可点的实时画面面板**。

> 本插件由 `dsh-ego-browser` 与自建的 `tools/isolated_display.sh` 演进而来；
> 设计目标见下文「为什么需要隔离 display」。

---

## 目录

- [为什么需要隔离 display](#为什么需要隔离-display)
- [功能](#功能)
- [安装](#安装)
- [配置](#配置)
- [Agent 工具](#agent-工具)
- [HTTP API](#http-api)
- [Web UI 面板](#web-ui-面板)
- [架构](#架构)
- [⚠️ 维护者必读：三个已经踩过的坑](#️-维护者必读三个已经踩过的坑)
- [已知限制](#已知限制)
- [部署到其他设备](#部署到其他设备)
- [故障排查](#故障排查)

---

## 为什么需要隔离 display

目标机器的桌面往往是 **KDE / GNOME 的 Wayland 会话**。在 Wayland 主桌面上：

| 想做的事 | 现实 |
|---|---|
| 把输入注入到**非焦点窗口** | ❌ XTEST 只打给当前焦点；`XSendEvent` 多数程序（含 Proton/UE）不理会 |
| 抓某个窗口的图 | ❌ XWayland 下 `import -window root` 直接 `BadMatch` |
| 安静地跑自动化 | ❌ 一定会抢焦点、占满屏，干扰用户 |

**解法**：Xephyr 在用户桌面上开一个**普通窗口**，但内部是一个**独立的 X server**。
在那个 display 里，XTEST / XSendEvent / 抓屏全部正常，且与用户会话**完全隔离** ——
用户照常用电脑，自动化在窗口内部跑。

---

## 功能

- **7 个 Agent 工具**：启停隔离 display、在其中跑命令、抓屏、列窗口、注入键鼠
- **Web 侧边栏面板**：实时画面 + 点击操作 + 文本/按键注入 + 窗口列表
- **宿主 HTTP API**：`/gui-isolation/*`，面板与外部脚本都可用
- **零 npm 依赖**：纯 JS，无构建步骤

---

## 安装

### 前置（Linux / X11 或 Wayland）

```bash
sudo apt install xserver-xephyr x11-utils xdotool imagemagick
# 验证
command -v Xephyr xdpyinfo xdotool import identify
```

- `Xephyr` —— 隔离 display 本体
- `xdpyinfo` —— 探活
- `xdotool` —— 注入键鼠
- `import` / `identify`（ImageMagick）—— 抓屏

### 安装插件

把本目录放到任意位置，然后在 DSH 里安装该**目录 bundle**：

```
plugin_manager(action: "install_bundle", target: "<本目录的绝对路径>")
```

安装后确认：

```
plugin_manager(action: "list_bundles")     # 应出现 dsh-isolated-x11，rows: gui-isolation
```

### 验证

```
iso_display_start            → {"display": ":9", "size": "1280x720", ...}
iso_display_run  ":9" sh ["-c", "setsid xclock &"]
iso_display_capture ":9"     → PNG 路径
iso_display_stop ":9"
```

---

## 配置

在 `cordis.patch.yml` 的 `config` 里改（安装后也可在 DSH 的插件页配置）：

| 键 | 默认 | 说明 |
|---|---|---|
| `parentDisplay` | `$DISPLAY` 或 `:1` | 承载 Xephyr 窗口的桌面 display |
| `xauthority` | 自动探测 | X 授权文件 |
| `defaultSize` | `1280x720` | 默认分辨率 |
| `displayRange` | `[9, 20]` | 可用的 display 编号区间 |
| `stateDir` | `~/.dsh-gui-isolation` | 记录已启动 display 的目录 |
| `xephyrPath` / `xdotoolPath` / `importPath` | 同名的 PATH 查找 | 自定义可执行文件路径 |

> ⚠️ `parentDisplay` 与 `xauthority` **建议显式配置** —— 见下面第 3 个坑。

---

## Agent 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `iso_display_start` | `size?` `display?` | 启动隔离 display，返回 `{display, size, pid}` |
| `iso_display_list` | — | 列出已知 display 及是否存活 |
| `iso_display_stop` | `display` | 停止并清理状态记录 |
| `iso_display_run` | `display` `command` `args?` `timeoutMs?` | 在该 display 里执行命令（**同步**，GUI 程序请用 `setsid ... &`） |
| `iso_display_capture` | `display` `outPath?` | 整屏截图，返回 PNG 路径与尺寸 |
| `iso_display_windows` | `display` | 列顶层窗口 |
| `iso_display_input` | `display` `kind` `key?` `text?` `x?` `y?` `window?` | 注入输入；`kind` ∈ `key type click focus` |

**`window` 参数很关键**：给出窗口 id 时 `key`/`type` 走 `XSendEvent` **定向投递，不依赖焦点**；
不给则走 XTEST（依赖焦点，全屏程序自己会持有焦点时够用）。

---

## HTTP API

全部挂在 `/gui-isolation/` 下，由宿主 Web 服务提供（默认 `http://127.0.0.1:3080`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/gui-isolation/state` | `{displays:[{display,alive,size,pid}], defaultSize, parentDisplay}` |
| `GET` | `/gui-isolation/snapshot?display=:9` | `image/png` 整屏截图 |
| `GET` | `/gui-isolation/windows?display=:9` | `{windows:[...]}` |
| `POST` | `/gui-isolation/start` | body `{size?, display?}` |
| `POST` | `/gui-isolation/stop` | body 或 query `display` |
| `POST` | `/gui-isolation/input` | body `{display, kind, key?, text?, x?, y?, window?}` |

示例：

```bash
curl -X POST -H 'content-type: application/json' -d '{"size":"1024x768"}' \
     http://127.0.0.1:3080/gui-isolation/start
curl -o shot.png "http://127.0.0.1:3080/gui-isolation/snapshot?display=%3A9"
curl -X POST -H 'content-type: application/json' \
     -d '{"display":":9","kind":"click","x":100,"y":200}' \
     http://127.0.0.1:3080/gui-isolation/input
```

> 这些路由**不受 dsh 的浏览器鉴权 cookie 限制**（实测 curl 直接可用），
> 但默认只监听本机回环地址。**不要**把 3080 暴露到公网。

---

## Web UI 面板

`client.js` 提供一个「隔离显示」面板：实时画面（约 0.9s 轮询）、点画面即在该坐标点击、
文本输入、常用按键、窗口列表、启停按钮。

落点策略：

- 装了 **`dsh-better-sidebar`** → 注册成**右侧栏标签页**（`ctx.betterSidebar.registerTab`）
- 没装 → 回退成 `shell.overlay` 上的**浮动面板**

样式只用宿主主题 token（`--dsw-alias-*`），不引入任何 Harness Client 包。

---

## 架构

```
┌─ 浏览器 ────────────────────────────────┐
│ client.js → 侧边栏标签页 / 浮动面板       │
│   fetch /gui-isolation/snapshot  (轮询)  │
│   fetch /gui-isolation/input     (点击)  │
└───────────────┬─────────────────────────┘
                │ HTTP
┌───────────────▼─────────────────────────┐
│ plugin.js（宿主）                        │
│   ctx.tools.register(...)   × 7 个工具   │
│   ctx.webServer.register(...)  × 6 路由  │
│   ctx.betterSidebar 由 client 侧使用      │
└───────────────┬─────────────────────────┘
                │ execFile
┌───────────────▼─────────────────────────┐
│ Xephyr（独立 X server :9）                │
│   你的被测程序跑在这里                     │
└─────────────────────────────────────────┘
```

**后端可插拔**：所有 display 操作集中在 `start/stop/snapshotBuffer/windows/input` 几个函数里。
要接第二个后端（例如 MaaFramework 修好后的 `WlrRootsController`），在这几个函数上分派即可。

---

## ⚠️ 维护者必读：三个已经踩过的坑

### 1. 插件的 `Config` 不能是裸 JSON Schema

Cordis 的实现是：

```js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config;
  const result = runtime.Config["~standard"].validate(config);  // ← 需要 Standard Schema
  ...
}
```

声明成裸 JSON Schema 会报 `Cannot read properties of undefined (reading 'validate')`，
**插件直接激活失败**。零依赖的纯 JS bundle 拿不到 schema 库，
所以**干脆不要声明 `Config`**，把默认值写在代码里。

（`/home/user/deepseek-harness/vendor/cordis/lib/index.js:956`）

### 2. ★ 模块被**进程级缓存**：改了 JS 代码，重装也不会加载新代码

**实测结论（2026-10-11）**：

| 手段 | 能否加载新代码 |
|---|---|
| `set_plugin` 关→开 | ❌ |
| `remove_bundle` + `install_bundle` | ❌ |
| 改**入口文件名**（`index.js` → `plugin.js`） | ❌ |
| 换**目录路径**（同样的包名） | ❌ |
| **换包名** | ✅ |

缓存按**包名**键控。所以：

> **开发期每改一次宿主代码，就要换一次包名，或者重启 dsh。**
> 正式维护时，改完代码**重启 dsh** 是最省事的路径（规范也写明「替换已安装的包需要重启」）。

### 3. dsh 宿主进程**不继承**桌面的 `DISPLAY` / `XAUTHORITY`

实测宿主进程的 environ 里这两个变量**都没有**。因此：

- 不配置就会连不上 X server（Xephyr 起不来 / xdotool 报错）
- 代码里有自动探测兜底：`$XAUTHORITY` → `/run/user/<uid>/xauth_*` → `~/.Xauthority`
- 但**显式配置最稳**（见 `cordis.patch.yml` 的 `parentDisplay` / `xauthority`）

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **跑不了 Vulkan / 3D 程序** | Xephyr **不提供 DRI3**。`vulkaninfo` 会报 *No DRI3 support detected - required for presentation*；UE 游戏启动即 `EXCEPTION_INT_DIVIDE_BY_ZERO`。2D / X11 程序完全可用。3D 需求请用 headless wlroots 或 gamescope。 |
| `iso_display_run` 是同步的 | 跑不会退出的 GUI 程序会占满超时。用 `sh -c "setsid <程序> &"` 后台起。 |
| 画面靠轮询 | 约 0.9s 一帧。要更流畅可改成 WebSocket + MJPEG/VP8 流。 |
| 无输入法/多指手势 | 只有 `xdotool` 能力范围内的键鼠。 |
| 默认只监听回环 | 不要把 3080 暴露到公网。 |

---

## 部署到其他设备

1. **装前置**（见上）
2. **取到本目录**（git clone 或拷贝）
3. **改 `cordis.patch.yml`**：
   - `parentDisplay` 改成目标机器的桌面 display（`echo $DISPLAY`）
   - `xauthority` 改成目标机器的 X 授权文件（`ls /run/user/$(id -u)/xauth_*`）
4. **安装**：`plugin_manager(action:"install_bundle", target:"<目标机上的绝对路径>")`
5. **验证**：`iso_display_list` → `iso_display_start` → `iso_display_capture`
6. 装了 `dsh-better-sidebar` 时，刷新页面应能在右栏看到「隔离显示」

> 目标机没有 `Xephyr` 时，也可以退而使用自建的
> `tools/isolated_display.sh`（功能等价、命令行驱动，不依赖 dsh 插件系统）。

---

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 插件行 `fiberPhase: failed`，报 `...reading 'validate'` | 声明了 `Config` —— 删掉它（见坑 1） |
| 改了代码但行为没变 | 模块缓存（见坑 2）—— 换包名或重启 dsh |
| `iso_display_start` 报「Xephyr 未能在 :N 上就绪」 | `parentDisplay` 或 `xauthority` 不对（见坑 3）；手动跑一次 `DISPLAY=:1 Xephyr :9 -screen 1280x720 -ac` 看报错 |
| 抓屏是纯黑/纯色 | 该 display 里确实没有窗口；先用 `iso_display_run` 起个程序 |
| 面板里没有画面 | 确认 display 存活（`iso_display_list`），以及 `/gui-isolation/state` 能返回 |
| 3D 程序秒退 | Xephyr 无 DRI3（见「已知限制」） |
| 页面看不到「隔离显示」标签 | 需要**刷新页面**；并确认 `dsh-better-sidebar` 已启用 |

---

## 文件

| 文件 | 说明 |
|---|---|
| `plugin.js` | 宿主：7 个工具 + 6 条 HTTP 路由 |
| `client.js` | 浏览器：侧边栏标签页 / 浮动面板 |
| `cordis.patch.yml` | bundle patch（插入 `gui-isolation` 行 + 配置） |
| `locale/{en,zh}.json` | 插件卡片标题与描述 |
| `icon.svg` | 插件图标 |
