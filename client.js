/**
 * dsh-cross-session — browser half: the Settings page.
 *
 * Registers one `settings.section` page (its nav label sits beside the other
 * plugin sections). The page edits the Host-side settings document through
 * `/api/cross-session/settings`; the Host applies tool visibility immediately.
 *
 * The whitelist is rendered from the Client session catalog (`useSessions`),
 * so it shows the same titles, directories and run state the sidebar shows.
 *
 * Plain self-registering browser module: `window.__ModuleLoader__.load({ id,
 * factory })`; `id` must equal the package name. No Harness Client package is
 * imported; React comes from the browser module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cross-session',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/api/cross-session'

    /** Page copy; resolved through the Client locale service at render time. */
    const MESSAGES = {
      zh: {
        nav: '跨会话对话',
        intro: '控制哪些会话能看到跨会话工具，以及开放哪些工具。保存后立即生效。',
        toolsTitle: '工具集',
        toolsAll: '四个工具全部开放',
        toolsAllNote: 'session_list / session_read / session_ask / session_send 都可用。',
        toolsSendOnly: '只开放 session_send',
        toolsSendOnlyNote: '其它 AI 只能"只投递"；列会话、读记录、等回答都不会出现在工具列表里。',
        scopeTitle: '开放范围',
        openAll: '对所有会话开放（忽略白名单）',
        openAllNote: '开启后所有会话都会按上面的工具集显示工具；下面的白名单不再生效。',
        whitelistTitle: '会话白名单',
        whitelistNote: '只有勾选的会话能看到这些工具；未勾选的会话（以及它们的 subagent）工具列表里不会出现任何跨会话工具。',
        selectAll: '全选',
        clearAll: '清空',
        selected: '已选 {count} 个',
        noSessions: '暂时没有可勾选的会话。',
        loading: '加载中…',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        loadFailed: '读取设置失败：{error}',
        saveFailed: '保存失败：{error}',
        retry: '重新读取',
        dimmed: '（当前被"对所有会话开放"覆盖）'
      },
      en: {
        nav: 'Cross-Session Chat',
        intro: 'Choose which sessions may see the cross-session tools, and which tools are exposed. Saved changes apply immediately.',
        toolsTitle: 'Toolset',
        toolsAll: 'All four tools',
        toolsAllNote: 'session_list / session_read / session_ask / session_send are all available.',
        toolsSendOnly: 'Only session_send',
        toolsSendOnlyNote: 'Other AIs get fire-and-forget delivery only; listing, reading and waiting for answers are hidden.',
        scopeTitle: 'Scope',
        openAll: 'Open to every session (ignore whitelist)',
        openAllNote: 'Every session sees the toolset above; the whitelist below is ignored.',
        whitelistTitle: 'Session whitelist',
        whitelistNote: 'Only the checked sessions see these tools. Every other session (and its subagents) has no cross-session tool in its tool list.',
        selectAll: 'Select all',
        clearAll: 'Clear',
        selected: '{count} selected',
        noSessions: 'No selectable sessions yet.',
        loading: 'Loading…',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        loadFailed: 'Failed to load settings: {error}',
        saveFailed: 'Failed to save: {error}',
        retry: 'Reload',
        dimmed: '(overridden by "open to every session")'
      }
    }

    /** Resolve one page string for the active Client locale. */
    function translate(locale, key, vars) {
      let active = ''
      try {
        active = String(locale?.getSnapshot?.()?.active ?? '')
      } catch {
        active = ''
      }
      const dict = active.toLowerCase().startsWith('zh') ? MESSAGES.zh : MESSAGES.en
      let text = dict[key] !== undefined ? dict[key] : MESSAGES.en[key] !== undefined ? MESSAGES.en[key] : key
      if (vars !== undefined) text = text.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined ? whole : String(vars[name])))
      return text
    }

    /** Parse one JSON response, surfacing HTTP failures instead of pretending success. */
    async function asJson(res) {
      if (res.ok) return res.json()
      let detail = ''
      try {
        const body = await res.json()
        detail = typeof body?.error === 'string' ? body.error : ''
      } catch {
        detail = ''
      }
      throw new Error(`HTTP ${res.status}${detail.length > 0 ? `: ${detail}` : ''}`)
    }

    const CSS = `
[data-cs-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:680px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit)}
[data-cs-sec]{display:flex;flex-direction:column;gap:8px}
[data-cs-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#8a8f98)}
[data-cs-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
[data-cs-opt]{display:flex;align-items:flex-start;gap:8px;cursor:pointer}
[data-cs-opt] input{margin:2px 0 0}
[data-cs-list]{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:8px;max-height:300px;overflow:auto}
[data-cs-row]{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.12))}
[data-cs-row]:first-child{border-top:0}
[data-cs-row] input{margin:0}
[data-cs-title]{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-cs-cwd]{flex:none;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-caption,#9aa0a6)}
[data-cs-dot]{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success,#2fa7a0);flex:none}
[data-cs-actions]{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
[data-cs-btn]{padding:4px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:inherit;font:inherit;cursor:pointer}
[data-cs-btn][data-primary]{background:var(--dsw-alias-button-primary-background,#2f6bff);border-color:transparent;color:#fff}
[data-cs-btn]:disabled{opacity:.45;cursor:default}
[data-cs-status]{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
[data-cs-error]{font-size:11px;color:var(--dsw-alias-state-error,#e5484d)}
[data-cs-dim]{opacity:.45}
`

    function SettingsPage(props) {
      const { useSessions, t, locale } = props
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [, rerender] = React.useState(0)

      // Re-render page copy when the Client locale changes.
      React.useEffect(() => {
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => rerender((value) => value + 1))
      }, [locale])

      const load = React.useCallback(async () => {
        setError('')
        try {
          const body = await asJson(await fetch(`${API}/settings`, { credentials: 'same-origin' }))
          const value = body?.value ?? {}
          setState({
            toolset: value.toolset === 'send-only' ? 'send-only' : 'all',
            openAll: value.openAll !== false,
            whitelist: Array.isArray(value.whitelist) ? value.whitelist.filter((id) => typeof id === 'string') : []
          })
        } catch (caught) {
          setError(t('loadFailed', { error: caught instanceof Error ? caught.message : String(caught) }))
        }
      }, [t])

      React.useEffect(() => {
        void load()
      }, [load])

      const catalog = typeof useSessions === 'function' ? useSessions((snapshot) => snapshot) : undefined
      const sessions = React.useMemo(() => {
        const ids = Array.isArray(catalog?.ids) ? catalog.ids : []
        const byId = catalog?.byId ?? {}
        return ids
          .map((id) => byId[id])
          .filter((row) => row !== undefined && row !== null && row.origin !== 'subagent')
          .map((row) => ({
            id: String(row.id),
            title: row.displayTitle !== undefined ? row.displayTitle : String(row.id),
            cwd: typeof row.cwd === 'string' ? row.cwd : '',
            running: row.running === true
          }))
      }, [catalog])

      if (state === null) {
        return h(
          'div',
          { 'data-cs-page': '' },
          error.length > 0
            ? h('div', { 'data-cs-error': '' }, error)
            : h('div', { 'data-cs-status': '' }, t('loading')),
          error.length > 0
            ? h('div', { 'data-cs-actions': '' }, h('button', { 'data-cs-btn': '', type: 'button', onClick: () => void load() }, t('retry')))
            : null
        )
      }

      const whitelist = new Set(state.whitelist)
      const update = (patch) => {
        setState((current) => (current === null ? current : { ...current, ...patch }))
        setStatus('')
      }
      const toggleWhitelist = (id) => {
        const next = new Set(whitelist)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        update({ whitelist: [...next] })
      }
      const selectAll = () => update({ whitelist: sessions.map((row) => row.id) })
      const clearAll = () => update({ whitelist: [] })

      const save = async () => {
        setBusy(true)
        setError('')
        setStatus('')
        try {
          const body = await asJson(
            await fetch(`${API}/settings`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ toolset: state.toolset, openAll: state.openAll, whitelist: state.whitelist })
            })
          )
          const value = body?.value ?? {}
          setState({
            toolset: value.toolset === 'send-only' ? 'send-only' : 'all',
            openAll: value.openAll !== false,
            whitelist: Array.isArray(value.whitelist) ? value.whitelist.filter((id) => typeof id === 'string') : []
          })
          setStatus(t('saved'))
        } catch (caught) {
          setError(t('saveFailed', { error: caught instanceof Error ? caught.message : String(caught) }))
        } finally {
          setBusy(false)
        }
      }

      const toolOption = (value, label, note) =>
        h(
          'label',
          { 'data-cs-opt': '' },
          h('input', {
            type: 'radio',
            name: 'cross-session-toolset',
            checked: state.toolset === value,
            onChange: () => update({ toolset: value })
          }),
          h(
            'span',
            null,
            h('span', null, label),
            h('div', { 'data-cs-note': '' }, note)
          )
        )

      const row = (session) =>
        h(
          'label',
          {
            'data-cs-row': '',
            key: session.id,
            ...(state.openAll ? { 'data-cs-dim': '' } : {})
          },
          h('input', {
            type: 'checkbox',
            checked: whitelist.has(session.id),
            disabled: state.openAll,
            onChange: () => toggleWhitelist(session.id)
          }),
          session.running ? h('span', { 'data-cs-dot': '', title: t('running') }) : null,
          h('span', { 'data-cs-title': '', title: session.title }, session.title),
          session.cwd.length > 0 ? h('span', { 'data-cs-cwd': '', title: session.cwd }, session.cwd) : null
        )

      return h(
        'div',
        { 'data-cs-page': '' },
        h('div', { 'data-cs-note': '' }, t('intro')),

        h(
          'div',
          { 'data-cs-sec': '' },
          h('div', { 'data-cs-h': '' }, t('toolsTitle')),
          toolOption('all', t('toolsAll'), t('toolsAllNote')),
          toolOption('send-only', t('toolsSendOnly'), t('toolsSendOnlyNote'))
        ),

        h(
          'div',
          { 'data-cs-sec': '' },
          h('div', { 'data-cs-h': '' }, t('scopeTitle')),
          h(
            'label',
            { 'data-cs-opt': '' },
            h('input', {
              type: 'checkbox',
              checked: state.openAll,
              onChange: () => update({ openAll: !state.openAll })
            }),
            h('span', null, t('openAll'))
          ),
          h('div', { 'data-cs-note': '' }, t('openAllNote'))
        ),

        h(
          'div',
          { 'data-cs-sec': '' },
          h('div', { 'data-cs-h': '' }, t('whitelistTitle')),
          h('div', { 'data-cs-note': '' }, t('whitelistNote')),
          h(
            'div',
            { 'data-cs-actions': '' },
            h('button', { 'data-cs-btn': '', type: 'button', disabled: state.openAll, onClick: selectAll }, t('selectAll')),
            h('button', { 'data-cs-btn': '', type: 'button', disabled: state.openAll, onClick: clearAll }, t('clearAll')),
            h('span', { 'data-cs-status': '' }, t('selected', { count: whitelist.size }))
          ),
          sessions.length === 0
            ? h('div', { 'data-cs-note': '' }, t('noSessions'))
            : h('div', { 'data-cs-list': '' }, sessions.map(row))
        ),

        h(
          'div',
          { 'data-cs-actions': '' },
          h('button', { 'data-cs-btn': '', 'data-primary': '', type: 'button', disabled: busy, onClick: () => void save() }, busy ? t('saving') : t('save')),
          status.length > 0 ? h('span', { 'data-cs-status': '' }, status) : null,
          error.length > 0 ? h('span', { 'data-cs-error': '' }, error) : null
        )
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-cross-session')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-cross-session: settings page styles')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (slots === undefined || slots === null) return
        let locale
        try {
          locale = typeof ctx.get === 'function' ? ctx.get('locale') : ctx.locale
        } catch {
          locale = undefined
        }
        // One stable translator for this plugin instance: the page's effects
        // depend on `t`, so it must not be re-created per render.
        const t = (key, vars) => translate(locale, key, vars)
        slots.inject('settings.section', () =>
          slots.register(
            {
              name: 'settings.section',
              id: 'cross-session',
              order: 27,
              label: () => translate(locale, 'nav'),
              inject: () => ({ t, locale })
            },
            SettingsPage
          )
        )
      }
    }
  }
})
