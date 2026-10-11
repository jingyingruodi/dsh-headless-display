// dsh-isolated-display —— Web UI 那一半
//
// 提供一个「隔离显示」面板：
//   * 实时画面（轮询宿主 /gui-isolation/snapshot 拿 PNG）
//   * 在画面上点击 → 映射成隔离 display 的坐标并注入点击
//   * 文本输入 / 常用按键 / 窗口列表 / 启停 display
//
// 落点策略（与 ego-browser 一致）：
//   * 装了 dsh-better-sidebar → 注册成**右侧栏标签页**
//   * 没装 → 回退成 shell.overlay 上的**浮动面板**
//
// 样式只用宿主主题 token（--dsw-alias-*）；不引入任何 Harness Client 包。

window.__ModuleLoader__.load({
  id: 'dsh-isolated-display',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/gui-isolation'
    const KEY_ROWS = [
      ['Return', 'Enter'], ['Escape', 'Esc'], ['Tab', 'Tab'], ['BackSpace', '⌫'],
      ['Up', '↑'], ['Down', '↓'], ['Left', '←'], ['Right', '→'],
      ['ctrl+c', 'Ctrl+C'], ['ctrl+v', 'Ctrl+V'],
    ]

    // ── 小工具 ────────────────────────────────────────────────────────────
    async function call(path, opts) {
      const res = await fetch(API + path, opts)
      const ct = res.headers.get('content-type') || ''
      if (!res.ok) {
        let msg = res.status + ''
        try { msg = (await res.json()).error || msg } catch {}
        throw new Error(msg)
      }
      return ct.includes('json') ? res.json() : res
    }
    const postJson = (p, body) => call(p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    })

    // ── 样式（全部走主题 token）────────────────────────────────────────────
    const S = {
      root: {
        display: 'flex', flexDirection: 'column', gap: 8, padding: 10, height: '100%',
        boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)', fontSize: 12, overflow: 'auto',
      },
      row: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
      btn: {
        padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      btnPrimary: {
        padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 500,
        color: 'var(--dsw-alias-bg-base)', background: 'var(--dsw-alias-brand-primary)',
        border: '1px solid var(--dsw-alias-brand-primary)',
      },
      select: {
        padding: '4px 6px', borderRadius: 6, fontSize: 12, background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)',
      },
      input: {
        flex: 1, minWidth: 80, padding: '4px 8px', borderRadius: 6, fontSize: 12,
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', outline: 'none',
      },
      stage: {
        position: 'relative', borderRadius: 8, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)', minHeight: 120,
      },
      img: { display: 'block', width: '100%', height: 'auto', cursor: 'crosshair' },
      muted: { color: 'var(--dsw-alias-label-secondary)' },
      err: { color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-all' },
      ok: { color: 'var(--dsw-alias-state-success-primary)' },
      win: {
        fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      },
      chip: {
        padding: '1px 6px', borderRadius: 999, fontSize: 11,
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
      },
    }

    // ── 面板 ──────────────────────────────────────────────────────────────
    function Panel() {
      const [info, setInfo] = useState(null)       // {displays, defaultSize, parentDisplay}
      const [display, setDisplay] = useState(null)
      const [src, setSrc] = useState(null)         // object URL
      const [natural, setNatural] = useState(null) // {w, h}
      const [err, setErr] = useState(null)
      const [busy, setBusy] = useState(false)
      const [text, setText] = useState('')
      const [wins, setWins] = useState([])
      const imgRef = useRef(null)
      const lastUrl = useRef(null)

      const refreshInfo = useCallback(async () => {
        try {
          const s = await call('/state')
          setInfo(s)
          setErr(null)
          const alive = (s.displays || []).filter((d) => d.alive)
          setDisplay((cur) => (cur && alive.some((d) => d.display === cur) ? cur : (alive[0]?.display || null)))
          return s
        } catch (e) { setErr(String(e.message || e)); return null }
      }, [])

      useEffect(() => { refreshInfo() }, [refreshInfo])

      // 画面轮询
      useEffect(() => {
        if (!display) { setSrc(null); return }
        let stop = false
        const tick = async () => {
          try {
            const res = await call(`/snapshot?display=${encodeURIComponent(display)}&_=${Date.now()}`)
            const blob = await res.blob()
            if (stop) return
            const url = URL.createObjectURL(blob)
            if (lastUrl.current) URL.revokeObjectURL(lastUrl.current)
            lastUrl.current = url
            setSrc(url)
            setErr(null)
          } catch (e) {
            if (!stop) setErr(String(e.message || e))
          }
        }
        tick()
        const id = setInterval(tick, 900)
        return () => { stop = true; clearInterval(id); if (lastUrl.current) { URL.revokeObjectURL(lastUrl.current); lastUrl.current = null } }
      }, [display])

      const doStart = async () => {
        setBusy(true)
        try { await postJson('/start', {}); await refreshInfo() }
        catch (e) { setErr(String(e.message || e)) } finally { setBusy(false) }
      }
      const doStop = async () => {
        if (!display) return
        setBusy(true)
        try { await postJson('/stop', { display }); setDisplay(null); await refreshInfo() }
        catch (e) { setErr(String(e.message || e)) } finally { setBusy(false) }
      }
      const send = async (payload) => {
        if (!display) return
        try { await postJson('/input', { display, ...payload }); setErr(null) }
        catch (e) { setErr(String(e.message || e)) }
      }
      const onClickImage = (ev) => {
        const el = imgRef.current
        if (!el || !natural) return
        const r = el.getBoundingClientRect()
        const x = Math.round(((ev.clientX - r.left) / r.width) * natural.w)
        const y = Math.round(((ev.clientY - r.top) / r.height) * natural.h)
        send({ kind: 'click', x, y })
      }
      const loadWins = async () => {
        if (!display) return
        try { const s = await call(`/windows?display=${encodeURIComponent(display)}`); setWins(s.windows || []) }
        catch (e) { setErr(String(e.message || e)) }
      }

      const displays = (info?.displays || [])
      const alive = displays.filter((d) => d.alive)

      return h('div', { style: S.root },
        h('div', { style: S.row },
          h('span', { style: { fontWeight: 600 } }, '隔离显示'),
          h('span', { style: S.muted }, info?.parentDisplay ? `父 ${info.parentDisplay}` : ''),
        ),

        h('div', { style: S.row },
          alive.length > 1
            ? h('select', { style: S.select, value: display || '', onChange: (e) => setDisplay(e.target.value) },
                alive.map((d) => h('option', { key: d.display, value: d.display }, `${d.display} ${d.size || ''}`)))
            : h('span', { style: S.chip }, display || '无'),
          h('button', { style: S.btnPrimary, disabled: busy, onClick: doStart }, busy ? '…' : '启动'),
          h('button', { style: S.btn, disabled: !display || busy, onClick: doStop }, '停止'),
          h('button', { style: S.btn, disabled: !display, onClick: loadWins }, '窗口'),
        ),

        h('div', { style: S.stage },
          src
            ? h('img', {
                ref: imgRef, src, style: S.img, alt: 'isolated display',
                onClick: onClickImage,
                onLoad: (e) => setNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight }),
              })
            : h('div', { style: { padding: 16, ...S.muted } },
                display ? '正在获取画面…' : '还没有隔离 display，点「启动」。'),
        ),

        err ? h('div', { style: S.err }, err) : null,
        src && natural ? h('div', { style: S.muted }, `${natural.w}×${natural.h} · 在画面上点击即可在该坐标点击`) : null,

        h('div', { style: S.row },
          h('input', {
            style: S.input, value: text, placeholder: '输入文本后回车发送',
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') { send({ kind: 'type', text }); setText('') } },
          }),
          h('button', { style: S.btn, disabled: !display, onClick: () => { send({ kind: 'type', text }); setText('') } }, '发送'),
        ),

        h('div', { style: S.row },
          KEY_ROWS.map(([k, label]) =>
            h('button', { key: k, style: S.btn, disabled: !display, onClick: () => send({ kind: 'key', key: k }) }, label)),
        ),

        wins.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              wins.map((w, i) => h('div', { key: i, style: S.win, title: w }, w)))
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let hasBetter = false
        try { hasBetter = !!ctx.get('betterSidebar') } catch {}
        if (hasBetter) {
          ctx.inject(['betterSidebar'], (bctx) => {
            bctx.effect(() => bctx.betterSidebar.registerTab({
              id: 'gui-isolation',
              title: '隔离显示',
              component: Panel,
            }))
          })
        } else {
          // 没有 better-sidebar 时回退成浮动面板，保证任何 composition 都能看到画面
          ctx.slots.inject('shell.overlay', () => ctx.slots.register(
            { name: 'shell.overlay', id: 'gui-isolation', order: 60, label: '隔离显示' },
            Panel,
          ))
        }
      },
    }
  },
})
