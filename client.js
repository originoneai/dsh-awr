// The browser half of the plugin (DSH-021): an "AWR" action in the conversation header with a panel that
// offers the one-click takeover of the project and shows its progress and receipt. It holds no logic of its
// own: it runs `/awr takeover` and `/awr takeover status --json` on the host (`ctx.remote.commands`) and
// draws what comes back. Plain JS against the module table's React, as DSH's plugin guide prescribes.
window.__ModuleLoader__.load({
  id: '@originoneai/dsh-awr',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const en = {
      'trigger.label': 'AWR',
      'trigger.title': 'AWR work state of this project',
      'panel.title': 'AWR',
      'state.loading': 'Reading the state…',
      'state.unavailable': 'AWR cannot work on this conversation.',
      'state.not_initialized': 'This project has no AWR work state yet.',
      'state.initialized': 'This project is managed by AWR. Use /awr status for its work.',
      'state.running': 'Taking the project over in the background. You can keep working.',
      'state.completed': 'The takeover is done.',
      'state.stopped': 'The takeover stopped.',
      'state.failed': 'The takeover failed.',
      'state.interrupted': 'The takeover was interrupted. It can continue where it stopped.',
      'takeover.start': 'Take over this project',
      'takeover.retry': 'Continue the takeover',
      'takeover.hint': 'AWR reads the README, docs, plans and history, organizes the goals and work in the background and asks you nothing. The project gets a .awr/ folder and .gitignore entries; nothing else is changed and nothing is committed.',
      'takeover.starting': 'Starting…',
      'steps.title': 'Steps',
      'step.preflight': 'Check the project',
      'step.preview': 'Read the project',
      'step.review': 'Review the draft',
      'step.accept': 'Apply',
      'step.organize': 'Check what is left',
      'step.receipt': 'Write the receipt',
      'status.pending': 'waiting',
      'status.running': 'running',
      'status.done': 'done',
      'status.skipped': 'skipped',
      'status.stopped': 'stopped',
      'status.failed': 'failed',
      'receipt.title': 'Receipt',
      'receipt.result': 'Result: {state}; {goals} goal(s), {gaps} open gap(s)',
      'receipt.mapped': 'Read as',
      'receipt.created': 'Created',
      'receipt.awaiting': 'Waiting for you to confirm',
      'receipt.nothing': 'nothing',
      'receipt.git': 'Git: nothing committed, nothing pushed.',
      'stop.where': 'Stopped at {step}: {reason}',
      'stop.at': 'Found at {location}',
      'error.call': 'The host did not answer: {message}',
      'work.title': 'This conversation',
      'work.bound': 'Bound work',
      'work.none': 'This conversation is not bound to an AWR session.',
      'work.next': 'Next action',
      'work.blocker': 'Blocked',
      'work.noblocker': 'no blocker',
      'work.claim': 'Claim',
      'work.noclaim': 'This session holds no claim.',
      'work.expires': 'expires {time}',
      'work.noexpiry': 'no expiry',
      'work.session': 'AWR session {id} ({status})',
      'work.counts': 'Project: {progress} in progress, {ready} ready, {blocked} blocked',
      'work.blockedList': 'Blocked work',
      'work.revision': 'revision {revision}',
    }
    const zh = {
      'trigger.label': 'AWR',
      'trigger.title': '本项目的 AWR 工作状态',
      'panel.title': 'AWR',
      'state.loading': '正在读取状态…',
      'state.unavailable': 'AWR 无法处理这个会话。',
      'state.not_initialized': '这个项目还没有 AWR 工作状态。',
      'state.initialized': '这个项目已由 AWR 管理，用 /awr status 查看工作。',
      'state.running': '正在后台接管项目，你可以继续工作。',
      'state.completed': '接管已完成。',
      'state.stopped': '接管已停止。',
      'state.failed': '接管失败。',
      'state.interrupted': '接管被中断，可以从停下的地方继续。',
      'takeover.start': '接管这个项目',
      'takeover.retry': '继续接管',
      'takeover.hint': 'AWR 会阅读 README、文档、计划和历史，在后台整理目标与工作，全程不向你提问。项目会多出 .awr/ 目录和 .gitignore 条目，其他一概不改，也不会提交。',
      'takeover.starting': '正在启动…',
      'steps.title': '步骤',
      'step.preflight': '检查项目',
      'step.preview': '读取项目',
      'step.review': '审阅草稿',
      'step.accept': '应用',
      'step.organize': '检查剩余事项',
      'step.receipt': '写入回执',
      'status.pending': '等待',
      'status.running': '进行中',
      'status.done': '完成',
      'status.skipped': '跳过',
      'status.stopped': '已停止',
      'status.failed': '失败',
      'receipt.title': '回执',
      'receipt.result': '结果：{state}；{goals} 个目标，{gaps} 个未决缺口',
      'receipt.mapped': '读取为',
      'receipt.created': '已创建',
      'receipt.awaiting': '等你确认',
      'receipt.nothing': '无',
      'receipt.git': 'Git：未提交，未推送。',
      'stop.where': '停在 {step}：{reason}',
      'stop.at': '位置：{location}',
      'error.call': '宿主没有回应：{message}',
      'work.title': '本会话',
      'work.bound': '绑定的工作',
      'work.none': '本会话没有绑定 AWR 会话。',
      'work.next': '下一步',
      'work.blocker': '阻塞',
      'work.noblocker': '无阻塞',
      'work.claim': '认领',
      'work.noclaim': '本会话没有持有认领。',
      'work.expires': '到期 {time}',
      'work.noexpiry': '无到期时间',
      'work.session': 'AWR 会话 {id}（{status}）',
      'work.counts': '项目：{progress} 项进行中，{ready} 项就绪，{blocked} 项阻塞',
      'work.blockedList': '被阻塞的工作',
      'work.revision': '版本 {revision}',
    }

    const FALLBACK = (key, params) => (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
    const STEPS = ['preflight', 'preview', 'review', 'accept', 'organize', 'receipt']
    const DOT = { running: '#d8a30b', completed: '#2b9a4a', stopped: '#c0392b', failed: '#c0392b', interrupted: '#d8a30b', not_initialized: '#8a8f98', initialized: '#2b9a4a', unavailable: '#8a8f98' }

    const styles = {
      trigger: { display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 28, padding: '3px 6px', border: 0, background: 'transparent', color: 'var(--dsw-alias-label-tertiary, currentColor)', cursor: 'pointer', fontSize: 12, lineHeight: '18px', borderRadius: 'var(--dsw-radius-sm, 6px)' },
      panel: { position: 'fixed', zIndex: 1000, width: 380, maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(520px, calc(100vh - 100px))', overflow: 'auto', boxSizing: 'border-box', padding: 14, background: 'var(--dsw-specific-menu, var(--dsw-alias-fill-l1, #fff))', color: 'var(--dsw-alias-label-primary, inherit)', border: '0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))', borderRadius: 'var(--dsw-radius-md, 10px)', boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.18))', fontSize: 13, lineHeight: '19px' },
      title: { fontWeight: 600, marginBottom: 6 },
      muted: { color: 'var(--dsw-alias-label-secondary, inherit)', opacity: 0.85 },
      small: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)' },
      section: { marginTop: 10, paddingTop: 8, borderTop: '0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))' },
      heading: { fontSize: 11, textTransform: 'none', color: 'var(--dsw-alias-label-tertiary, inherit)', marginBottom: 3 },
      button: { marginTop: 10, padding: '6px 12px', border: 0, borderRadius: 'var(--dsw-radius-sm, 6px)', background: 'var(--dsw-alias-label-primary, #111)', color: 'var(--dsw-alias-fill-l1, #fff)', cursor: 'pointer', fontSize: 13 },
      mono: { fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: 12, wordBreak: 'break-all' },
      error: { color: 'var(--dsw-alias-state-error-primary, #c0392b)' },
      list: { margin: '2px 0 0', padding: 0, listStyle: 'none' },
    }

    /** `ctx.remote.commands.execute` returns `{ ok, value: { result: { kind, text } } }` or `{ ok: false, error }`. */
    async function runCommand(ctx, sessionId, line) {
      const answer = await ctx.remote.commands.execute(sessionId, line, [])
      if (!answer?.ok) throw new Error(answer?.error?.code ?? 'the host refused the command')
      const result = answer.value?.result
      if (result?.kind === 'error') throw new Error(result.text)
      return result?.text ?? ''
    }

    function AwrAction(props) {
      const ctx = props.__ctx
      const t = React.useMemo(() => {
        try {
          const bound = ctx.locale?.bind?.('awr')
          return typeof bound === 'function' ? (key, params) => bound(key, params) : FALLBACK
        } catch {
          return FALLBACK
        }
      }, [ctx])
      const sessionId = props.sessionId
      const [view, setView] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(undefined)
      const trigger = React.useRef(null)
      const panel = React.useRef(null)

      const [work, setWork] = React.useState(undefined)
      const refresh = React.useCallback(async () => {
        try {
          const text = await runCommand(ctx, sessionId, '/awr takeover status --json')
          const next = JSON.parse(text)
          setView(next)
          setError(undefined)
          // A project AWR manages also has work state to show; asked only then, and only when the panel is looked at.
          if (next.state === 'initialized' || next.state === 'completed') {
            try {
              setWork(JSON.parse(await runCommand(ctx, sessionId, '/awr state --json')))
            } catch {
              setWork(undefined)
            }
          } else {
            setWork(undefined)
          }
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [ctx, sessionId])

      // Every command the panel runs is a line in the conversation's timeline and an entry in its log, so the panel
      // asks only when it is opened, after a click, and while a takeover is running: at a growing interval when the
      // panel is open, every 10 seconds when it is closed (so the dot does not stay "running" after it ends). A
      // conversation nobody looked at, and a project with no takeover running, cost nothing.
      const delay = React.useRef(2000)
      React.useEffect(() => {
        if (view?.state !== 'running') {
          delay.current = 2000
          return undefined
        }
        const wait = open ? delay.current : 10000
        const timer = setTimeout(() => {
          delay.current = Math.min(delay.current * 1.6, 10000)
          refresh()
        }, wait)
        return () => clearTimeout(timer)
      }, [open, view, refresh])

      React.useEffect(() => {
        if (!open) return undefined
        const close = (event) => {
          if (event.type === 'keydown' && event.key !== 'Escape') return
          if (event.type === 'mousedown' && (panel.current?.contains(event.target) || trigger.current?.contains(event.target))) return
          setOpen(false)
        }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', close)
        return () => {
          document.removeEventListener('mousedown', close)
          document.removeEventListener('keydown', close)
        }
      }, [open])

      const toggle = () => {
        if (!open && trigger.current) {
          const rect = trigger.current.getBoundingClientRect()
          setAnchor({ top: rect.bottom + 6, left: Math.max(12, Math.min(rect.left, window.innerWidth - 392)) })
        }
        setOpen(!open)
        if (!open) refresh()
      }

      const start = async () => {
        setBusy(true)
        try {
          await runCommand(ctx, sessionId, '/awr takeover')
          await refresh()
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const state = view?.state ?? (error ? 'unavailable' : undefined)
      const dot = h('span', { 'data-testid': 'awr-dot', 'data-state': state ?? 'loading', style: { width: 7, height: 7, borderRadius: '50%', background: DOT[state] ?? '#8a8f98', display: 'inline-block' } })
      const button = h('button', { ref: trigger, id: 'awr-header-action', type: 'button', style: styles.trigger, title: t('trigger.title'), 'aria-label': t('trigger.title'), 'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: toggle }, dot, t('trigger.label'))
      if (!open || !anchor) return button

      const workNode = !(work && (view?.state === 'initialized' || view?.state === 'completed')) ? null : (() => {
        const bound = work.bound_work
        const when = (ms) => new Date(ms).toLocaleString()
        return (h('div', { key: 'work', 'data-testid': 'awr-work', style: styles.section },
          h('div', { style: styles.heading }, t('work.title'), work.project?.revision != null ? ` · ${t('work.revision', { revision: work.project.revision })}` : ''),
          work.session ? h('div', { style: styles.small }, t('work.session', { id: work.session.id, status: work.session.status })) : h('div', { style: styles.muted }, t('work.none')),
          bound ? h('div', { 'data-testid': 'awr-bound-work', style: { marginTop: 6 } },
            h('div', { style: styles.heading }, t('work.bound')),
            h('div', null, h('span', { style: styles.mono }, bound.key), bound.title ? ` ${bound.title}` : '', bound.status ? h('span', { style: styles.small }, ` [${bound.status}]`) : null),
            bound.next_action ? h('div', { style: styles.small }, `${t('work.next')}: ${bound.next_action}`) : null,
            h('div', { 'data-testid': 'awr-blocker', style: bound.blocker ? styles.error : styles.small }, bound.blocker ? `${t('work.blocker')}: ${bound.blocker}` : t('work.noblocker'))) : null,
          work.session ? h('div', { 'data-testid': 'awr-claims', style: { marginTop: 6 } },
            h('div', { style: styles.heading }, t('work.claim')),
            work.claims?.length ? h('ul', { style: styles.list }, ...work.claims.map((claim, index) => h('li', { key: index, style: styles.mono }, `${claim.work ?? '?'}: ${claim.expires_at ? t('work.expires', { time: when(claim.expires_at) }) : t('work.noexpiry')}`))) : h('div', { style: styles.small }, t('work.noclaim'))) : null,
          h('div', { style: { ...styles.small, marginTop: 6 } }, t('work.counts', { progress: work.in_progress?.length ?? 0, ready: work.ready?.length ?? 0, blocked: work.blocked?.length ?? 0 })),
          work.blocked?.length ? h('div', { style: { marginTop: 4 } }, h('div', { style: styles.heading }, t('work.blockedList')), h('ul', { style: styles.list }, ...work.blocked.slice(0, 6).map((item) => h('li', { key: item.key, style: styles.mono }, `${item.key}${item.blocker ? `: ${item.blocker}` : ''}`)))) : null))
      })()
      const body = []
      if (!view && !error) body.push(h('div', { key: 'load', style: styles.muted }, t('state.loading')))
      if (error && !view) body.push(h('div', { key: 'err', style: styles.error }, t('error.call', { message: error })))
      if (view) {
        body.push(h('div', { key: 'state', 'data-testid': 'awr-state', style: styles.muted }, t(`state.${view.state}`)))
        if (view.projectRoot) body.push(h('div', { key: 'root', style: { ...styles.small, ...styles.mono, marginTop: 2 } }, view.projectRoot))
        if (workNode) body.push(workNode)
        if (view.state === 'not_initialized' || view.state === 'stopped' || view.state === 'failed' || view.state === 'interrupted') {
          if (view.stop) {
            const detail = view.stop.detail
            const location = detail?.path ? `${detail.path}${detail.line ? `:${detail.line}` : ''}${detail.category ? ` (${detail.category})` : ''}` : undefined
            body.push(h('div', { key: 'stop', style: { ...styles.error, marginTop: 8 } }, t('stop.where', { step: t(`step.${view.stop.step}`), reason: view.stop.reason }), h('div', { style: { ...styles.small, marginTop: 2 } }, view.stop.message), location ? h('div', { 'data-testid': 'awr-stop-location', style: { ...styles.small, ...styles.mono, marginTop: 4 } }, t('stop.at', { location })) : null))
          }
          if (view.state === 'not_initialized') body.push(h('div', { key: 'hint', style: { ...styles.small, marginTop: 8 } }, t('takeover.hint')))
          body.push(h('button', { key: 'go', id: 'awr-takeover-start', type: 'button', style: { ...styles.button, opacity: busy ? 0.6 : 1 }, disabled: busy, onClick: start }, busy ? t('takeover.starting') : t(view.state === 'not_initialized' ? 'takeover.start' : 'takeover.retry')))
        }
        if (view.state === 'running' || view.state === 'completed' || view.state === 'stopped' || view.state === 'failed' || view.state === 'interrupted') {
          body.push(h('div', { key: 'steps', style: styles.section }, h('div', { style: styles.heading }, t('steps.title')), h('ul', { style: styles.list }, ...STEPS.map((name) => {
            const step = view.steps.find((item) => item.name === name)
            return h('li', { key: name, 'data-step': name, 'data-status': step?.status, style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, h('span', null, t(`step.${name}`)), h('span', { style: styles.small }, t(`status.${step?.status ?? 'pending'}`)))
          }))))
        }
        const receipt = view.receipt
        if (receipt) {
          const list = (items, render) => (items.length ? h('ul', { style: styles.list }, ...items.map((item, index) => h('li', { key: index, style: styles.mono }, render(item)))) : h('div', { style: styles.small }, t('receipt.nothing')))
          body.push(h('div', { key: 'receipt', 'data-testid': 'awr-receipt', style: styles.section },
            h('div', { style: styles.heading }, t('receipt.title')),
            h('div', null, t('receipt.result', { state: receipt.organization?.state ?? receipt.result, goals: receipt.organization?.goalTotal ?? 0, gaps: receipt.organization?.gapTotal ?? 0 })),
            h('div', { style: { ...styles.heading, marginTop: 8 } }, t('receipt.mapped')),
            list(receipt.mapped?.sources ?? [], (source) => `${source.path} (${source.adapter})`),
            h('div', { style: { ...styles.heading, marginTop: 8 } }, t('receipt.created')),
            list(receipt.created?.writes ?? [], (write) => write.path),
            h('div', { style: { ...styles.heading, marginTop: 8 } }, t('receipt.awaiting')),
            list(receipt.awaitingConfirmation ?? [], (goal) => `${goal.title ?? goal.key} (${goal.status})`),
            h('div', { style: { ...styles.small, marginTop: 8 } }, t('receipt.git'))))
        }
      }
      return h(React.Fragment, null, button, ReactDOM.createPortal(h('div', { ref: panel, role: 'dialog', 'aria-label': t('panel.title'), id: 'awr-panel', style: { ...styles.panel, top: anchor.top, left: anchor.left } }, h('div', { style: styles.title }, t('panel.title')), ...body), document.body))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('awr', { en, zh }), 'dsh-awr: dictionaries')
        const Action = (props) => h(AwrAction, { ...props, __ctx: ctx })
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'awr-takeover', order: 30 }, Action))
      },
    }
  },
})
