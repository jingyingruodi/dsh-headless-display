# dsh-headless-display

在**隔离的虚拟 X display** 里运行并操作 GUI 程序 —— 默认**桌面上零窗口、零干扰**。
给 Agent 提供 **10 个工具**（含环境自检），并在 DSH Web 界面里提供一个**可看可点的实时画面面板**。

- **默认后端 `Xvfb`（真 headless）**：桌面上不开任何窗口
- 想看/想亲手操作时，用面板上的「打开真实窗口」按需弹出
  （`sway` 后端用 **`wayvnc`**，其余后端用 **`x11vnc`**；都只监听回环）
- 可选后端 `Xephyr`：直接在用户桌面上开一个可见窗口（旧的可见行为）

> 本插件由 `dsh-ego-browser` 与自建的 `tools/isolated_display.sh` 演进而来；
> 设计目标见下文「为什么需要隔离 display」。

### 名称沿革（为什么改过几次名）

`@local/isolated-display` → `@local/gui-isolation` → `dsh-isolated-x11` → **`dsh-headless-display`**

改动原因**不是**反复无常，而是 dsh 的一个硬约束：**宿主插件模块按「包名」做进程级缓存**
（详见下文「维护者必读」第 2 个坑）—— 改了 JS 之后，
`set_plugin` 开关、`remove_bundle` + `install_bundle`、改入口文件名、换目录路径
**都无法加载新代码**，只有**换包名**或**重启 dsh** 才行。

所以开发期每改一次宿主代码就得换一次名；最后一次改名同时反映了行为变化
（默认后端从 Xephyr 改为 headless 的 Xvfb）。GitHub 仓库也随之改名，
旧链接会自动重定向；旧提交信息里的名字是当时的历史事实，保留不改写。

---

## 目录

- [为什么需要隔离 display](#为什么需要隔离-display)
- [静默保证：用户桌面上为什么不会多出窗口](#静默保证用户桌面上为什么不会多出窗口)
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
- [许可证](#许可证)

---

## 静默保证：用户桌面上为什么不会多出窗口

「静默」不是口号，而是**两个具体故障的反面** —— 都实测踩过，现在由代码硬保证。

### ① 隔离 display 的编号不能靠「探活失败」来判定

旧实现先记「启动前还活着的 display」，再抓新出现的 socket。它依赖 XAUTHORITY 探测成功，
而 `xauthority` 配置在换机器 / 重启桌面后会失效（`xauth_XXXXXX` 每次可能换名）。
一旦探活全失败，**用户桌面的 `:1` 就会被当成「新建的 display」**。
实测后果：`iso_display_run` 返回的 `DISPLAY=:1`、`xdpyinfo` 报 **1920x1200（用户屏）**，
命令全跑在用户桌面上。

现在的判据是**进程归属**：sway 以 detached 启动、是进程组组长，Xwayland 由它拉起，
所以只认 `pgid/ppid === sway.pid` 的那个 Xwayland；再叠两道安全网：

- 绝不接受「启动前活着」或「等于桌面 display」的编号；
- 所有**写操作**（run / capture / windows / input / popout）都要求该 display 有本插件的
  状态文件 —— 外部 display 默认一律拒绝（`allowForeignDisplays: true` 可放开）。

### ② 只删 `WAYLAND_DISPLAY` 不够

libwayland 在 `WAYLAND_DISPLAY` 为空时**默认连 `$XDG_RUNTIME_DIR/wayland-0`** ——
正是用户桌面的合成器。宿主进程的 env 里本来就有 `WAYLAND_DISPLAY=wayland-0`；
只删掉它，GTK 仍会以 Wayland 客户端身份连上桌面（实测 `zenity` 进程的
`/proc/<pid>/fd` 里出现 `memfd:wayland-cursor`）。

所以 `iso_display_run` 起的子进程默认**显式钉到 X11**：

```text
GDK_BACKEND=x11
QT_QPA_PLATFORM=xcb
SDL_VIDEODRIVER=x11
ELECTRON_OZONE_PLATFORM_HINT=x11
XDG_SESSION_TYPE=x11
（并清掉 WAYLAND_DISPLAY / XDG_CURRENT_DESKTOP）
```

X11 客户端由 Xwayland（sway 后端）或 Xvfb 承载，于是 `xdotool`（XTEST）/
`xwininfo` / 逐窗口聚焦都能工作，窗口也不可能漏到桌面。

> **要用 Wayland 原生客户端**（只有 Wayland 后端的程序）：配置
> `exposeWaylandClients: true`，或给 `iso_display_run` 的 `env` 传**绝对路径**的
> `WAYLAND_DISPLAY`（如 `/run/user/1000/dsh-iso-1/wayland-1`）。
> 代价：xdotool 够不到那些 Wayland 窗口，键鼠注入会失效。

### 验证方法（本仓库作者的实测做法）

KDE 下用 KWin 脚本（`org.kde.kwin.Scripting`）每 2 秒采样一次窗口清单，
跑完整套自动化后与基线做 diff；再用 `spectacle` 定时抓桌面截图旁证。
**出现任何新窗口**（`iso_display_popout` 的查看器除外）就算静默失败。

---

## 三种后端：默认静默 / 按需弹窗

| 后端 | 桌面上有窗口 | **DRI3** | Vulkan | 适用 |
|---|---|---|---|---|
| **`sway`（auto 下的首选）** | 否 | **有** | **GPU（RADV 等）** | **Proton / DX12 / 3D 游戏**，也兼容 2D |
| `xvfb` | 否 | 无 | 仅 lavapipe（CPU 软渲） | 2D / X11 程序，最轻量 |
| `xephyr` | **是**（会打扰用户） | 无 | ✗ | 想一边跑一边直接看真实窗口 |

**`backend: auto`（默认）**：探测到 `sway` 就用 `sway`，否则退回 `xvfb`。
显式写 `sway` / `xvfb` / `xephyr` 可强制指定。

> **为什么 3D 游戏必须用 `sway`**：Xvfb 与 Xephyr 都**不提供 DRI3**，
> Vulkan 的 WSI 会打印
> `No DRI3 support detected - required for presentation` 并退到 llvmpipe；
> UE/Unity 的 3D 游戏往往直接崩（Desynced 在 Xvfb 下抛 `EXCEPTION_INT_DIVIDE_BY_ZERO`）。
> `sway` 后端起一个 **私有 `XDG_RUNTIME_DIR`** 的 headless sway，它自带 **Xwayland** ——
> Xwayland 提供 DRI3，Vulkan/GL 因而直通 GPU。
> 它的 wayland socket 在私有 runtime dir 里，与用户桌面会话**完全不相干**。

想看真实画面、想亲手操作时，**不必切换后端**：用面板上的
**「打开真实窗口」**（或工具 `iso_display_popout`）。它只监听本机回环地起一个 VNC
服务端，再用 VNC 查看器开一个窗口；关掉即回到静默，**里面的程序不用重启**。
这与 `dsh-ego-browser`「浏览器静默跑、需要时弹出真实页」是同一个模型。

> ⚠️ **服务端按后端分两种**，不能混用：
> - `sway` → **`wayvnc`**（走 wlr-screencopy 读 Wayland 输出）
> - `xvfb` / `xephyr` → **`x11vnc`**
>
> 原因是**硬限制**：sway 后端的 display 是 **Xwayland**，而 x11vnc 靠 `XGetImage`
> 读根窗口，在 Xwayland 上必然 `BadMatch`：
> ```
> X Error of failed request:  BadMatch (invalid parameter attributes)
>   Major opcode of failed request:  73 (X_GetImage)
> ```
> 插件会自动按后端选对的工具。

#### 查看器的两套语法（都实测踩过）

| 查看器 | 地址写法 | `-Shared` |
|---|---|---|
| **TigerVNC** `vncviewer` | `localhost::<端口>` ✅ | ✅ 认识 |
| **GTK-VNC** `gvncviewer` | `localhost::<端口>` ❌ → 会被当成默认 **5900**，报「连接被拒绝」<br>`localhost:<display号>` ✅（display 号 = 端口 − `vncPortBase`） | ❌ 不认识 → 报「未知选项」直接退出 |

插件按实际解析到的查看器自动选择地址与参数。默认查看器是 `gvncviewer`；
想换成 TigerVNC 可把配置里的 `viewerPath` 设为 `vncviewer`。

> ⚠️ 已知限制：KDE **Wayland** 下，XWayland 窗口**抬不到原生 Wayland 窗口之上**，
> 所以弹出的查看器窗口可能不会自动到最前 —— 可从任务栏点击它。
> 这是平台行为，不是插件能绕过的。

## 为什么需要隔离 display

目标机器的桌面往往是 **KDE / GNOME 的 Wayland 会话**。在 Wayland 主桌面上：

| 想做的事 | 现实 |
|---|---|
| 把输入注入到**非焦点窗口** | ❌ XTEST 只打给当前焦点；`XSendEvent` 多数程序（含 Proton/UE）不理会 |
| 抓某个窗口的图 | ❌ XWayland 下 `import -window root` 直接 `BadMatch` |
| 安静地跑自动化 | ❌ 一定会抢焦点、占满屏，干扰用户 |

**解法**：另起一个**独立的 X server**，自动化全部在它内部进行，与用户会话完全隔离。

- **`auto`/`sway`（推荐）**：headless sway + Xwayland，**桌面零窗口**且**有 GPU**。
- **`Xvfb`**：纯 headless、最轻，但**无 GPU**（3D 游戏跑不了）。
- **`Xephyr`**：在用户桌面上开一个普通窗口，内部同样是独立 X server。

在这个独立 display 里，XTEST / XSendEvent / 抓屏全部正常。

---

## 功能

- **10 个 Agent 工具**：环境自检、启停隔离 display、在其中跑命令、抓屏、列窗口、
  注入键鼠，以及按需弹出/收起真实窗口
- **Web 侧边栏面板**：实时画面 + 点击操作 + 文本/按键注入 + 窗口列表 + 真实窗口开关
- **宿主 HTTP API**：9 条 `/gui-isolation/*` 路由，面板与外部脚本都可用
- **跨发行版**：`iso_display_doctor` 按 Debian / Fedora / Arch 给安装命令；
  路径全部自动探测，换机器不用手改配置
- **零 npm 依赖**：纯 JS，无构建步骤

---

## 安装

### 前置（Linux / X11 或 Wayland）

> **按发行版安装**：不用手抄下面的命令 —— 装好插件后先跑 `iso_display_doctor`，
> 它会列出本机缺什么，并直接给出 `apt` / `dnf` / `pacman` 的可粘贴命令。
> 下面以 Debian 系为例。

```bash
# sway 后端（默认 auto 下首选；跑 3D / Proton 游戏必需）
sudo apt install sway grim x11-utils xdotool imagemagick
# 说明：sway 自带 Xwayland；grim 用于抓屏（Xwayland 下 import 取不到根窗口）

# xvfb 后端（无 GPU 时的退路 / 纯 2D 自动化）
sudo apt install xvfb

# 「打开真实窗口」所需
#   x11vnc  —— xvfb / xephyr 后端
#   wayvnc  —— sway 后端（它的 display 是 Xwayland，x11vnc 在此不可用）
#   gvncviewer —— 实际的查看器窗口
sudo apt install x11vnc wayvnc gvncviewer

# 想用可见窗口后端（backend: xephyr）再装：
sudo apt install xserver-xephyr

# 验证
command -v sway grim Xvfb Xwayland xdpyinfo xdotool import identify x11vnc wayvnc gvncviewer
```

> **sway 能跑但 GPU 不可用？** 确认当前用户在 `render` 组里（`id -nG | tr ' ' '\n' | grep render`）；
> wlroots 的 headless 后端要打开 `/dev/dri/renderD*`。

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
plugin_manager(action: "list_bundles")     # 应出现 dsh-headless-display，rows: gui-isolation
```

### 验证

```
iso_display_start            → {"display": ":9", "size": "1280x720", ...}
iso_display_run  ":9" sh ["-c", "setsid xclock &"]
iso_display_capture ":9"     → PNG 路径
iso_display_stop ":9"
```

---

## 跑 Windows / DX 游戏（Proton / Steam 兼容套件）

**已实测**：Desynced（Unreal 引擎、DX12、只有 Win64 二进制）在 `sway` 后端的隔离
display 里**完整渲染、有声音、桌面上零窗口**。

### 要点

1. **必须用 `sway` 后端** —— Xvfb/Xephyr 无 DRI3，Vulkan 退到 llvmpipe，
   UE 游戏直接抛 `EXCEPTION_INT_DIVIDE_BY_ZERO`。
2. **绕开 Steam 客户端直接调 Proton** —— `steam -applaunch` 由 Steam 客户端进程
   带着**它自己的**环境启动游戏，调用方设的 `DISPLAY` 传不进去。
3. 用 `iso_display_run` + `setsid ... &`（该工具是同步的，GUI 程序必须后台化）。

### 一键启动：`scripts/run-proton.sh`

**不要自己拼 `STEAM_COMPAT_*`** —— 库目录、前缀、Proton 版本因机器而异，
手写模板最容易把 `DISPLAY` 漏在 Steam 客户端那一侧（于是游戏开到用户桌面上）。

```bash
scripts/run-proton.sh --list 1450900     # 只打印探测结果，不启动
```

```text
appid          : 1450900 (Desynced)
library        : /media/user/F-DataShared/SteamLibrary
install dir    : …/steamapps/common/Desynced
compatdata     : …/steamapps/compatdata/1450900
prefix version : 11.0-100
proton         : …/common/Proton 11.0            ← 优先匹配前缀版本
exe            : …/Desynced/Binaries/Win64/Desynced.exe
```

它做的事：枚举 `libraryfolders.vdf` 里所有库 → 找 `appmanifest_<appid>.acf` →
读 `compatdata/<appid>/version` 选**同版本** Proton（找不到才退 Experimental/Hotfix）
→ 定位 exe（`<installdir>.exe` → `Binaries/Win64/*.exe`，排除 CrashReport/Launcher）
→ 设 `STEAM_COMPAT_CLIENT_INSTALL_PATH / DATA_PATH / INSTALL_PATH / SteamAppId`
→ `exec proton run <exe>`。

在隔离 display 里启动（`iso_display_run` 是同步的，GUI 程序必须后台化）：

```bash
iso_display_start                                    # → :2（backend: sway, gpu: true）
iso_display_run ":2" sh ["-c", "setsid /path/to/scripts/run-proton.sh 1450900 -log > /tmp/game.log 2>&1 &"]
iso_display_capture ":2"                             # 截图确认渲染
iso_display_stop ":2"
```

要给游戏加环境变量时，用工具的 `env` 参数即可（不必改脚本）：

```json
{"display": ":2", "command": "sh",
 "args": ["-c", "setsid /path/to/scripts/run-proton.sh 1450900 &"],
 "env": {"WINEDEBUG": "-all", "SteamAppId": "1450900"}}
```

### 踩过的坑

| 现象 | 原因 / 解法 |
|---|---|
| 抓屏全黑 / 报 `import: ... BadMatch` | Xwayland 下 `import -window root` 取不到根窗口。**插件已自动改用 `grim`** 抓 Wayland 输出；手工抓屏时记得给 `XDG_RUNTIME_DIR` + `WAYLAND_DISPLAY`，别只给 `DISPLAY` |
| `steam -applaunch` 起在了桌面上 | 见上文第 2 点，改直接调 `proton` |
| Proton 版本与前缀不匹配 | `compatdata/<APPID>/version` 记着建前缀用的版本（本机是 `11.0-100`）。用别的版本会触发前缀更新，慢但可用 |
| 起不来但无报错 | 看 `/tmp/game.log`；`pgrep -x <GAME>.exe` 确认进程是否真的起来了 |

---

## 配置

在 `cordis.patch.yml` 的 `config` 里改（安装后也可在 DSH 的插件页配置）：

| 键 | 默认 | 说明 |
|---|---|---|
| `backend` | `auto` | `auto`＝有 `sway` 就用它、否则 `xvfb`；也可强制 `sway` / `xvfb` / `xephyr`。**sway 起不来时 auto 会自动回退 xvfb**，结果里带 `fallback` / `fallbackReason` |
| `parentDisplay` | `$DISPLAY` 或 `:1` | 承载 Xephyr 窗口的桌面 display（**仅 `backend: xephyr` 需要**） |
| `xauthority` | 自动探测 | X 授权文件。**配了但文件不存在会被忽略**并回退自动探测（`/run/user/<uid>/xauth_*` → `~/.Xauthority`） |
| `defaultSize` | `1280x720` | 默认分辨率（sway 后端同时作用于虚拟输出） |
| `displayRange` | `[9, 20]` | 可用编号区间（仅 xvfb/xephyr；sway 的编号由 Xwayland 自己挑）。残留 socket 会被清掉复用 |
| `stateDir` | `~/.dsh-headless-display` | 记录已启动 display 的目录 |
| `swayRunDirBase` | `/run/user/<uid>/dsh-iso` | sway 私有 `XDG_RUNTIME_DIR` 前缀；无 `/run/user` 时自动回退 `$XDG_RUNTIME_DIR`、`$TMPDIR` |
| `vncPortBase` | `5900` | 弹出真实窗口时 VNC 的起始端口（只监听回环） |
| `allowForeignDisplays` | `false` | 是否允许操作**不是本插件启动的** display。默认拒绝，防止误操作到用户桌面 |
| `exposeWaylandClients` | `false` | 是否把该实例的 wayland socket 交给子进程。默认 `false`＝全部钉到 X11，`xdotool` 可用 |
| `swayPath` / `grimPath` / `wayvncPath` / `xephyrPath` / `xvfbPath` / `x11vncPath` / `viewerPath` / `xdotoolPath` / `importPath` / `xdpyinfoPath` / `xwininfoPath` | 按名字在 PATH 查找 | 自定义可执行文件路径 |

> ⚠️ `parentDisplay` 与 `xauthority` **建议显式配置** —— 见下面第 3 个坑。

---

## Agent 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `iso_display_doctor` | — | **环境自检**：依赖 / GPU / 目录 / 桌面 X 会话；缺什么按发行版给安装命令 |
| `iso_display_start` | `size?` `display?` `backend?` | 启动隔离 display，返回 `{display, size, pid, backend, gpu}`；`backend` 可按次覆盖 |
| `iso_display_list` | — | 列出已知 display 及是否存活 |
| `iso_display_stop` | `display` | 停止并清理（杀进程组、清残留 socket/lock） |
| `iso_display_run` | `display` `command` `args?` `timeoutMs?` `env?` | 在该 display 里执行命令（**同步**，GUI 请用 `setsid ... &`）；`env` 适合 Proton 游戏 |
| `iso_display_capture` | `display` `outPath?` | 整屏截图，返回 PNG 路径与尺寸 |
| `iso_display_windows` | `display` | 列顶层窗口 |
| `iso_display_input` | `display` `kind` `key?` `text?` `x?` `y?` `window?` | 注入输入；`kind` ∈ `key type click focus` |
| `iso_display_popout` | `display` | 弹出真实窗口（VNC + 查看器）—— 桌面上**唯一**会出现的窗口 |
| `iso_display_popin` | `display` | 收起真实窗口，回到静默；display 里的程序不重启 |

**`window` 参数很关键**：给出窗口 id 时 `key`/`type` 走 `XSendEvent` **定向投递，不依赖焦点**；
不给则走 XTEST（依赖焦点，全屏程序自己会持有焦点时够用）。

---

## HTTP API

全部挂在 `/gui-isolation/` 下，由宿主 Web 服务提供（默认 `http://127.0.0.1:3080`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/gui-isolation/doctor` | 自检结果（同 `iso_display_doctor`） |
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
文本输入、常用按键、窗口列表、启停按钮，以及**「打开真实窗口 / 关闭真实窗口」**开关。

落点策略：

- 装了 **`dsh-better-sidebar`** → 注册成**右侧栏标签页**（`ctx.betterSidebar.registerTab`）。
  标签页渲染在侧栏那一列内部，结构上不可能覆盖其它区域。
- 没装 → **不注册任何 UI**（Agent 工具与 HTTP API 仍然可用）。

> ⚠️ 曾经有一个「回退到 `shell.overlay` 浮动面板」的分支，**已彻底删除**：
> `shell.overlay` 是贯穿整个窗口的浮层，配上 `height:100%` + 不透明背景的面板
> 会把整个 Web UI 盖死，用户点不到任何东西，只能从外部远程窗口通知 Agent 才回滚掉。
> **教训：绝不要把大尺寸组件挂到 frame-wide 浮层上；宁可没有 UI，也不能挡住用户。**

样式只用宿主主题 token（`--dsw-alias-*`），不引入任何 Harness Client 包。

---

## 架构

```
┌─ 浏览器 ────────────────────────────────┐
│ client.js → 右栏标签页（better-sidebar）  │
│   fetch /gui-isolation/snapshot  (轮询)  │
│   fetch /gui-isolation/input     (点击)  │
└───────────────┬─────────────────────────┘
                │ HTTP
┌───────────────▼─────────────────────────┐
│ plugin.js（宿主）                        │
│   ctx.tools.register(...)   × 9 个工具   │
│   ctx.webServer.register(...)  × 8 路由  │
│   ctx.betterSidebar 由 client 侧使用      │
└───────────────┬─────────────────────────┘
                │ execFile
┌───────────────▼─────────────────────────┐
│ Xvfb（默认，headless） / Xephyr（可选）    │
│   独立 X server（如 :9）                  │
│   默认桌面上无窗口；按需 popout 出真实窗口  │
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

### 4. 判断 `betterSidebar` 可用性**不能**用 `ctx.get()`

better-sidebar 是通过 **`ctx.provide("betterSidebar", service)`** 发布服务的，
它**晚于**本插件 apply。所以：

```js
// ❌ 错：此刻拿到 undefined，标签页永远不注册（表现为「右栏根本没有这个选项」）
if (!ctx.get('betterSidebar')) return
ctx.inject(['betterSidebar'], cb)

// ✅ 对：Cordis 会等待依赖就绪；真的没有时回调不执行，自然没有任何 UI
ctx.inject(['betterSidebar'], cb)
```

另外：`betterSidebar` **不在** Cordis 的 Service 目录里，
`cordis_inspect_query(platform:"client", provider:"Service")` 查不到它 ——
**别因为查不到就以为它不存在**。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **`xvfb` / `xephyr` 跑不了 Vulkan / 3D** | 两者都**不提供 DRI3**。`vulkaninfo` 会报 *No DRI3 support detected - required for presentation*，Vulkan 退到 llvmpipe；UE 游戏启动即 `EXCEPTION_INT_DIVIDE_BY_ZERO`。**3D / Proton 游戏请用 `sway` 后端**（有 DRI3，Vulkan 直通 GPU）。 |
| `iso_display_run` 是同步的 | 跑不会退出的 GUI 程序会占满超时。用 `sh -c "setsid <程序> &"` 后台起。 |
| 画面靠轮询 | 约 0.9s 一帧。要更流畅可改成 WebSocket + MJPEG/VP8 流。 |
| 无输入法/多指手势 | 只有 `xdotool` 能力范围内的键鼠。 |
| 默认只监听回环 | 不要把 3080 暴露到公网。 |
| 弹出窗口不一定到最前 | KDE Wayland 下 XWayland 窗口抬不过原生 Wayland 窗口（平台限制） |
| `backend: xephyr` 会开窗口 | 会打扰用户；除非确实需要，否则保持默认 `auto` |
| `sway` 启动慢于 xvfb | 要连起 wlroots + Xwayland 两个进程，首次约 3–6 秒（xvfb 约 1 秒）。换来的是 GPU。 |
| `sway` 需要 `render` 组 | wlroots headless 要打开 `/dev/dri/renderD*`。不在组里会退到软件渲染（仍能跑，只是慢）。 |
| `sway` 序号上限 20 | 只有 sway 进程**仍然活着**的序号才算占用；异常退出留下的 runDir 会在下次启动时被复用并清理。 |
| **默认强制 X11** | 子进程被钉到 X11（`GDK_BACKEND` / `QT_QPA_PLATFORM` / `SDL_VIDEODRIVER` / `ELECTRON_OZONE_PLATFORM_HINT`）。只有 Wayland 后端的程序需要 `exposeWaylandClients: true`，但那时 `xdotool` 够不到它们的窗口。 |
| **外部 display 默认不可操作** | 防止误伤用户桌面；确需操作请设 `allowForeignDisplays: true` |
| **x11vnc 在 sway 后端不可用** | 硬限制：Xwayland 上 `XGetImage` 会 `BadMatch`。插件已自动改用 `wayvnc`；手工调试时别混用。 |

---

## 部署到其他设备

目标：换一台 Linux（Debian/Ubuntu、Fedora、Arch…）几分钟装好，**不用手改路径**。

1. **取到本目录**（`git clone` 或拷贝）
2. **安装**：`plugin_manager(action:"install_bundle", target:"<本目录绝对路径>")`
3. **自检**：调用 `iso_display_doctor`
   - `ok: true` → 直接 `iso_display_start`
   - `missing` 非空 → 按返回的 `install` 一行命令装好
   - `warnings` 里有 GPU / 查看器 / 桌面临接的提示
4. **验证**：`iso_display_start` → `iso_display_run` 起个窗口 → `iso_display_capture`
5. 装了 `dsh-better-sidebar` 时，刷新页面能在右栏看到「隔离显示」

**不需要**再手改 `parentDisplay` / `xauthority`：

- `parentDisplay` 默认取 `$DISPLAY`，拿不到时探活 `:1`
- `xauthority` 自动扫描 `/run/user/<uid>/xauth_*` 与 `~/.Xauthority`；
  配置里写过但文件不存在时**忽略并回退自动探测**
  （旧版正是被过期路径坑到：探活全失败 → 把用户桌面的 `:1` 当成新建的隔离 display）
- sway 私有 runtime 目录按 `/run/user/<uid>` → `$XDG_RUNTIME_DIR` → `$TMPDIR` 依次回退，
  非 systemd 发行版也能用

> 包名对应关系：Debian/Ubuntu、Fedora、Arch 给可直接粘贴的命令；
> 其它发行版给通用包名清单（避免编错包名带偏）。

---

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `iso_display_start` 返回的 display 是 `:1` 之类、`iso_display_run` 里 `DISPLAY` 指向用户屏 | 旧版故障（`xauthority` 过期 → 误判）。v1.3.0 已改用进程组判定；若仍出现，先跑 `iso_display_doctor` 看 `x11.xauthority` |
| 程序窗口跑到用户桌面上 | 用了 Wayland 原生客户端：默认已钉 X11；如果你设了 `exposeWaylandClients: true` 或 `env.WAYLAND_DISPLAY`，Wayland 窗口就会进隔离合成器，但**不会**到桌面。若真到桌面，检查是否直接用了 `steam -applaunch`（见 Proton 章节） |
| 缺依赖但报错只有一句 `spawn ENOENT` | 跑 `iso_display_doctor`，`missing` + `install` 会告诉你要装什么 |
| `sway` 起不来又不知道原因 | `iso_display_doctor` 看 `backends.sway` / `gpu` / `dirs`；再手工跑 `WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 sway -c /dev/null` |
| 插件行 `fiberPhase: failed`，报 `...reading 'validate'` | 声明了 `Config` —— 删掉它（见坑 1） |
| 改了代码但行为没变 | 模块缓存（见坑 2）—— 换包名或重启 dsh |
| `iso_display_start` 报「Xephyr 未能在 :N 上就绪」 | `parentDisplay` 或 `xauthority` 不对（见坑 3）；手动跑一次 `DISPLAY=:1 Xephyr :9 -screen 1280x720 -ac` 看报错 |
| 抓屏是纯黑/纯色 | 该 display 里确实没有窗口；先用 `iso_display_run` 起个程序 |
| 面板里没有画面 | 确认 display 存活（`iso_display_list`），以及 `/gui-isolation/state` 能返回 |
| 3D 程序秒退 / 报 VKD3D 或 D3D 错误 | 该后端无 DRI3。**改用 `sway`**（见「已知限制」） |
| `sway` 后端启动超时 | 手动验证：`WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 sway -c /dev/null`，看能否起来；再 `command -v Xwayland grim` |
| **`sway` 崩溃（OOM / `kill -9`）后重启总是超时** | 被打断的 Xwayland 会留下**残留 socket 文件**（`/tmp/.X11-unix/X<n>`，无进程监听）。插件已改为按「**启动前是否活着**」而非「socket 文件是否新增」发现 display，并在复用序号时清掉残留 runDir —— 现已能自愈 |
| `sway` 起得来但游戏报 Vulkan 找不到设备 | 检查 `id -nG` 是否含 `render`；`ls -l /dev/dri/renderD*` |
| `grim` 报找不到 wayland socket | 抓屏必须带该实例的 `XDG_RUNTIME_DIR` + `WAYLAND_DISPLAY`（插件已自动处理；手工抓屏常忘） |
| x11vnc 报 `Wayland display server detected` 后退出 | 它靠**环境变量**判断会话类型，即使 `-display` 指向 Xwayland 也会拒绝。插件已剥掉 `WAYLAND_DISPLAY` / `XDG_SESSION_TYPE`；手工起 x11vnc 时同理 |
| 真实窗口不出现，查看器瞬间退出 | 查看器有**两套不兼容的地址语法与选项**（见下），插件按实现自动选；手工调试时别混用 |
| 页面看不到「隔离显示」标签 | 需要**刷新页面**；并确认 `dsh-better-sidebar` 已启用 |

---

## 文件

| 文件 | 说明 |
|---|---|---|
| `plugin.js` | 宿主：10 个工具 + 9 条 HTTP 路由 |
| `client.js` | 浏览器：右栏标签页（better-sidebar 缺失时不注册任何 UI） |
| `scripts/run-proton.sh` | 在隔离 display 里用 Proton 跑 Steam 游戏（自动探测库/前缀/版本/exe） |
| `cordis.patch.yml` | bundle patch（插入 `gui-isolation` 行 + 配置） |
| `locale/{en,zh}.json` | 插件卡片标题与描述 |
| `icon.svg` | 插件图标 |

---

## 更新日志

### v1.3.0（静默硬保证 + 跨发行版 + Proton 辅助脚本）

**修复（都会让窗口/命令落到用户桌面上）**

- **display 归属判定改用进程组**：旧实现靠「启动前是否活着」找新 display，
  `xauthority` 配置过期时会把用户桌面的 `:1` 当成隔离 display
  （实测 `iso_display_run` 报 `DISPLAY=:1`、1920x1200）。现在只认
  `pgid/ppid === sway.pid` 的 Xwayland，并加两道安全网。
- **子进程钉到 X11**：只删 `WAYLAND_DISPLAY` 时 libwayland 会默认连
  `$XDG_RUNTIME_DIR/wayland-0`（用户桌面）。现在显式设
  `GDK_BACKEND=x11` / `QT_QPA_PLATFORM=xcb` / `SDL_VIDEODRIVER=x11` /
  `ELECTRON_OZONE_PLATFORM_HINT=x11` / `XDG_SESSION_TYPE=x11`。
  可用 `exposeWaylandClients: true` 或 `env` 里给绝对路径 socket 恢复 Wayland 客户端。
- **`xauthority` 过期路径**：配置值不存在时忽略并回退自动探测。
- **写操作只允许本插件启动的 display**（`allowForeignDisplays` 可放开）。
- **`spawn` 缺 `error` 监听**：缺二进制时 `ENOENT` 会抛未捕获异常带崩 dsh，已修。
- **wayvnc 参数**：`-r` 实为 `--render-cursor`、`-p` 实为 `--show-performance`，
  端口只能走位置参数（0.9.1 实测）。旧写法只是「碰巧能用」，已改成明确写法并带重试。
- **`stop()` 不再用 `pkill -f`**（会误杀命令行里含同样字符串的进程），
  改按进程组 + 「进程名 + 参数前缀」精确收尾，并清理残留 socket/lock。

**新增**

- `iso_display_doctor` 工具 + `/gui-isolation/doctor` 路由：依赖 / GPU / DRI3 /
  目录可写 / 桌面 X 会话自检，按 Debian/Fedora/Arch 给安装命令。
- `iso_display_start` 支持按次指定 `backend`；`auto` 失败自动回退 `xvfb`。
- `iso_display_run` 支持 `env`（Proton 环境变量），并校验 `DISPLAY` /
  `WAYLAND_DISPLAY` 不能指回用户桌面。
- `scripts/run-proton.sh`：自动探测 Steam 库 / compatdata / Proton 版本 / exe。
- runDir 在无 `/run/user/<uid>` 时回退 `$XDG_RUNTIME_DIR` / `$TMPDIR`。
- `pickDisplay()` 自愈：残留 socket + lock 会被清掉复用编号。

**改进**

- `sway --version` 探测改为懒执行（不再阻塞 dsh 启动最多 5 秒）。
- `snapshotBuffer()` 不再对 sway 后端抓两次屏。
- `listDisplays()` 的状态文件恢复改为同步读取（重启后立刻可用 `WAYLAND_DISPLAY`）。

---

## 许可证

[MIT](LICENSE) © 2026 jingyingruodi
