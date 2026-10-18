#!/usr/bin/env bash
# 在隔离 display 里用 Steam 兼容套件（Proton）跑 Windows 游戏
#
# 为什么需要它：`steam -applaunch <appid>` 由 Steam 客户端进程带着「它自己的」
# 环境启动游戏，调用方设的 DISPLAY 传不进去 —— 游戏会开在用户桌面上。
# 所以绕开 Steam 客户端，直接调 Proton，并显式给足 Steam 的兼容环境变量。
#
# 用法：
#   run-proton.sh --list                       # 只打印探测结果，不启动
#   run-proton.sh <appid> [额外游戏参数...]
#   GAME_EXE=/path/to/Game.exe run-proton.sh <appid>     # 手动指定 exe
#   PROTON=/path/to/proton run-proton.sh <appid>         # 手动指定 Proton
#
# 依赖：steam 库目录 + 已建好的 compatdata 前缀（Steam 玩过一次就有了）。
set -euo pipefail

LIST_ONLY=0
if [ "${1:-}" = "--list" ]; then LIST_ONLY=1; shift; fi
APPID="${1:-}"
if [ -z "$APPID" ]; then
  echo "用法: $0 [--list] <steam_appid> [游戏参数...]" >&2
  exit 2
fi
shift || true

STEAM_ROOT="${STEAM_ROOT:-$HOME/.local/share/Steam}"
[ -d "$STEAM_ROOT" ] || { echo "找不到 Steam 目录: $STEAM_ROOT" >&2; exit 1; }

# ── 1) 枚举所有库目录 ────────────────────────────────────────────────────────
libs=("$STEAM_ROOT")
while IFS= read -r p; do
  # libraryfolders.vdf 里的路径是 JSON 风格转义的
  p="${p//\\\\//}"
  [ -d "$p/steamapps" ] && libs+=("$p")
done < <(grep -o '"path"[[:space:]]*"[^"]*"' "$STEAM_ROOT/steamapps/libraryfolders.vdf" 2>/dev/null | sed 's/.*"path"[[:space:]]*"//; s/"$//')

# ── 2) 找到这个 appid 的 manifest / 安装目录 / 前缀 ─────────────────────────
MANIFEST="" PREFIX="" LIB=""
for l in "${libs[@]}"; do
  if [ -f "$l/steamapps/appmanifest_$APPID.acf" ]; then
    MANIFEST="$l/steamapps/appmanifest_$APPID.acf"
    PREFIX="$l/steamapps/compatdata/$APPID"
    LIB="$l"
    break
  fi
done
[ -n "$MANIFEST" ] || { echo "在已枚举的库里找不到 appid=$APPID 的 appmanifest" >&2; printf '  库: %s\n' "${libs[@]}" >&2; exit 1; }

INSTALLDIR="$(grep -m1 '"installdir"' "$MANIFEST" | sed 's/.*"installdir"[[:space:]]*"//; s/"$//')"
NAME="$(grep -m1 '"name"' "$MANIFEST" | sed 's/.*"name"[[:space:]]*"//; s/"$//')"
GAMEDIR="$LIB/steamapps/common/$INSTALLDIR"

# ── 3) 探测 Proton 版本：compatdata/<appid>/version 记着建前缀用的版本 ──────
PROTON="${PROTON:-}"
if [ -z "$PROTON" ]; then
  V="$(cat "$PREFIX/version" 2>/dev/null || true)"
  # 优先级：与 compatdata/version 同版本的 Proton > 其它版本号 Proton（新→旧）
  #         > Proton - Experimental > Proton Hotfix。
  # 用错版本会触发前缀更新（慢，但一般可用），所以先精确匹配。
  all=()
  for l in "${libs[@]}"; do
    while IFS= read -r d; do all+=("$d"); done < <(ls -d "$l"/steamapps/common/Proton\ [0-9]* 2>/dev/null | sort -rV)
  done
  cand=()
  if [ -n "$V" ]; then
    want="Proton ${V%%-*}"
    for d in "${all[@]}"; do [ "$(basename "$d")" = "$want" ] && cand+=("$d"); done
    # 11.0-100 的前缀也接受 11.0.x 的目录名
    for d in "${all[@]}"; do case "$(basename "$d")" in "${want}."*) cand+=("$d");; esac; done
  fi
  cand+=("${all[@]}")
  for l in "${libs[@]}"; do
    cand+=("$l/steamapps/common/Proton - Experimental" "$l/steamapps/common/Proton Hotfix")
  done
  for c in "${cand[@]}"; do [ -x "$c/proton" ] && { PROTON="$c"; break; }; done
fi
[ -n "$PROTON" ] && [ -x "$PROTON/proton" ] || { echo "找不到可执行的 proton（用 PROTON=... 指定）" >&2; exit 1; }

# ── 4) 探测游戏 exe：优先 GAME_EXE，其次 <installdir>.exe，再退 Binaries/Win64 ─
GAME="${GAME_EXE:-}"
if [ -z "$GAME" ]; then
  GAME="$(find "$GAMEDIR" -maxdepth 5 -iname "$INSTALLDIR.exe" -print -quit 2>/dev/null || true)"
fi
if [ -z "$GAME" ]; then
  GAME="$(find "$GAMEDIR" -maxdepth 6 -ipath '*Binaries/Win64/*.exe' ! -iname '*CrashReport*' ! -iname '*Launcher*' -print -quit 2>/dev/null || true)"
fi
if [ -z "$GAME" ]; then
  GAME="$(find "$GAMEDIR" -maxdepth 4 -iname '*.exe' ! -iname '*CrashReport*' -print -quit 2>/dev/null || true)"
fi
[ -n "$GAME" ] && [ -f "$GAME" ] || { echo "找不到游戏 exe（用 GAME_EXE=... 指定）" >&2; exit 1; }

# ── 5) Steam 兼容环境 ───────────────────────────────────────────────────────
export STEAM_COMPAT_CLIENT_INSTALL_PATH="$STEAM_ROOT"
export STEAM_COMPAT_DATA_PATH="$PREFIX"
export STEAM_COMPAT_INSTALL_PATH="$GAMEDIR"
export SteamAppId="$APPID"
export SteamGameId="$APPID"
# Proton 需要 64 位 Steam runtime 里的这些库；找不到时它自己会报缺什么
export STEAM_RUNTIME_LIBRARY_PATH="${STEAM_RUNTIME_LIBRARY_PATH:-$LIB/steamapps/common/SteamLinuxRuntime}"

if [ "$LIST_ONLY" = 1 ]; then
  cat <<EOF
appid          : $APPID ($NAME)
library        : $LIB
install dir    : $GAMEDIR
compatdata     : $PREFIX
prefix version : $(cat "$PREFIX/version" 2>/dev/null || echo '(未创建)')
proton         : $PROTON
exe            : $GAME
DISPLAY        : ${DISPLAY:-<未设置>}
EOF
  exit 0
fi

echo "[run-proton] $NAME ($APPID) → $GAME" >&2
echo "[run-proton] proton: $PROTON  display: ${DISPLAY:-<未设置>}" >&2
exec "$PROTON/proton" run "$GAME" "$@"
