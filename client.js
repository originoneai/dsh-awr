// The browser half of the plugin (DSH-021): an "AWR" action in the conversation header with a panel that
// offers the one-click takeover of the project and shows its progress and receipt. It holds no logic of its
// own: it runs `/awr` commands on the host (`ctx.remote.commands`) for what the user does, and draws the data the
// host writes into a file it reads (`ctx.remote.workspaceFiles`, lib/panel-snapshot.js), which keeps data out of the
// conversation. Plain JS against the module table's React, as DSH's plugin guide prescribes.
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
      'receipt.state.needs_organization': 'the goals still need to be organized',
      'receipt.state.ready': 'ready',
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
      'action.title': 'Manage this session',
      'action.claim': 'Claim {work}',
      'action.checkpoint': 'Save a checkpoint',
      'action.end': 'End the session',
      'action.digest': 'What was done so far',
      'action.next': 'What comes next',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'action.confirmEnd': 'End it',
      'action.outcome': 'Outcome',
      'action.outcome.ended': 'ended',
      'action.outcome.interrupted': 'interrupted',
      'action.outcome.incomplete': 'incomplete',
      'action.endNote': 'Ending a session does not complete its work.',
      'action.invalid': 'Fill in both fields, and leave out "::".',
      'action.working': 'Working…',
      'panel.refresh': 'Refresh',
      'awr.info': 'awr {version} · {where}',
      'awr.takeover.awr': 'The takeover runs through awr takeover.',
      'awr.takeover.plugin': 'The takeover runs in the plugin (this awr has no awr takeover).',
      'awr.error': 'awr: {message}',
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
      'receipt.state.needs_organization': '目标还需要整理',
      'receipt.state.ready': '已就绪',
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
      'action.title': '管理本会话',
      'action.claim': '认领 {work}',
      'action.checkpoint': '保存检查点',
      'action.end': '结束会话',
      'action.digest': '目前完成了什么',
      'action.next': '接下来做什么',
      'action.save': '保存',
      'action.cancel': '取消',
      'action.confirmEnd': '确认结束',
      'action.outcome': '结果',
      'action.outcome.ended': '已结束',
      'action.outcome.interrupted': '被中断',
      'action.outcome.incomplete': '未完成',
      'action.endNote': '结束会话不会完成其中的工作。',
      'action.invalid': '两项都要填写，且不能含 "::"。',
      'action.working': '处理中…',
      'panel.refresh': '刷新',
      'awr.info': 'awr {version} · {where}',
      'awr.takeover.awr': '接管通过 awr takeover 运行。',
      'awr.takeover.plugin': '接管由插件自己运行（这个 awr 没有 awr takeover）。',
      'awr.error': 'awr：{message}',
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
      action: { marginTop: 6, marginRight: 6, padding: '4px 10px', border: '0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.4))', borderRadius: 'var(--dsw-radius-sm, 6px)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
      input: { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '4px 6px', border: '0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.4))', borderRadius: 'var(--dsw-radius-sm, 6px)', background: 'transparent', color: 'inherit', fontSize: 12 },
    }

    /** One line of text for a `/awr` command: whitespace collapsed, so a pasted newline cannot start a second command. */
    const single = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
    /** `/awr checkpoint DIGEST :: NEXT`, or undefined when a field is empty or holds the `::` that separates them. */
    function checkpointLine(digest, next) {
      const left = single(digest)
      const right = single(next)
      if (!left || !right || left.includes('::') || right.includes('::')) return undefined
      return `/awr checkpoint ${left} :: ${right}`
    }
    /** A work key as a button label: AWR's own keys can be a 50-character hash, which does not fit in the panel. */
    const shortKey = (key) => (String(key).length > 24 ? `${String(key).slice(0, 12)}…${String(key).slice(-6)}` : String(key))
    const RECEIPT_STATES = new Set(['needs_organization', 'ready'])
    const OUTCOMES = ['ended', 'interrupted', 'incomplete']
    const FINISHED = new Set(['completed', 'closed_without_completion'])

    /**
     * Where the host writes the data of the panel (lib/panel-snapshot.js): below its home directory, with the conversation
     * id made safe. The same path the host builds, because the panel cannot see the host's environment.
     */
    function snapshotPath(home, sessionId) {
      const separator = home.includes('\\') && !home.includes('/') ? '\\' : '/'
      return [home, '.local', 'state', 'dsh-awr', 'panel', `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`].join(separator)
    }
    /**
     * The data of the panel, read from the file the host writes. Reading it adds nothing to the conversation, unlike a
     * command, which DeepSeek Harness records as a row. Returns `{ updatedAt, view, work }` or throws why it cannot.
     */
    async function readSnapshot(ctx, sessionId) {
      const home = ctx.remote?.hostFacts?.home
      if (typeof home !== 'string' || !home) throw new Error('the host did not say where its home directory is')
      const files = ctx.remote?.workspaceFiles
      if (!files) throw new Error('this DeepSeek Harness has no file service for the panel')
      const answer = await files.read(sessionId, snapshotPath(home, sessionId), {})
      if (!answer?.ok) throw new Error(answer?.error?.code ?? 'the host could not read the panel data')
      if (answer.value?.eof === false) throw new Error('the panel data is longer than one read')
      const payload = JSON.parse(String(answer.value?.text ?? ''))
      if (!payload?.view) throw new Error('the panel data has no view')
      return payload
    }
    /** The language of the sentence the host writes into the conversation: Chinese for a Chinese interface. */
    const panelLanguage = () => (typeof navigator !== 'undefined' && String(navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en')

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
      // The session actions: which form is open, what it holds, and what the last command answered.
      const [form, setForm] = React.useState(undefined)
      const [digest, setDigest] = React.useState('')
      const [next, setNext] = React.useState('')
      const [outcome, setOutcome] = React.useState('ended')
      const [acting, setActing] = React.useState(false)
      const [note, setNote] = React.useState(undefined)
      // What the panel shows is read from a file the host writes (see readSnapshot), which adds nothing to the
      // conversation. A command does: DeepSeek Harness records every command as a row. So the panel runs one only when
      // the file cannot do it: the host is asked to write it (`/awr panel`, whose row is one readable sentence) when the
      // file is missing or old, when someone presses Refresh, and when a takeover that should be moving has stopped
      // changing it. An action's own command already made the host write the file again.
      const apply = React.useCallback((payload) => {
        setView(payload.view)
        setWork(payload.work ?? undefined)
        setError(undefined)
      }, [])
      // Ask the host to write the file, then read it.
      const refresh = React.useCallback(async () => {
        try {
          await runCommand(ctx, sessionId, `/awr panel ${panelLanguage()}`)
          apply(await readSnapshot(ctx, sessionId))
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [ctx, sessionId, apply])
      // Read the file; ask the host to write it first when it is missing, or older than `since` (on this machine), or
      // older than `maxAge`.
      const reload = React.useCallback(async ({ since, maxAge } = {}) => {
        let payload
        try {
          payload = await readSnapshot(ctx, sessionId)
        } catch {
          payload = undefined
        }
        const age = payload ? Date.now() - payload.updatedAt : 0
        const local = ctx.remote?.hostFacts?.isLoopback === true
        const old = payload && ((local && since !== undefined && payload.updatedAt < since) || (local && maxAge !== undefined && age > maxAge))
        if (!payload || old) return refresh()
        apply(payload)
        return undefined
      }, [ctx, sessionId, apply, refresh])

      // The dot shows what the file says as soon as the header is there, without asking the host anything.
      React.useEffect(() => {
        let live = true
        readSnapshot(ctx, sessionId).then((payload) => { if (live) apply(payload) }, () => {})
        return () => { live = false }
      }, [ctx, sessionId, apply])

      // While the panel is open and a takeover runs, read the file again every 2.5 s: the host writes it as the steps
      // finish. A file that has not changed for 12 s means the host stopped writing (it was restarted, say), so the
      // host is asked once, and then the panel goes on reading.
      const seen = React.useRef({ at: undefined, same: 0 })
      React.useEffect(() => {
        if (!open || view?.state !== 'running') return undefined
        let live = true
        let timer
        const poll = async () => {
          try {
            const payload = await readSnapshot(ctx, sessionId)
            if (!live) return
            seen.current.same = payload.updatedAt === seen.current.at ? seen.current.same + 1 : 0
            seen.current.at = payload.updatedAt
            if (seen.current.same >= 5) {
              seen.current.same = 0
              await refresh()
            } else {
              apply(payload)
            }
          } catch (failure) {
            if (live) setError(String(failure?.message ?? failure))
          }
          if (live) timer = setTimeout(poll, 2500)
        }
        timer = setTimeout(poll, 2500)
        return () => {
          live = false
          clearTimeout(timer)
        }
      }, [open, view?.state, ctx, sessionId, apply, refresh])

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
        // A file written a moment ago is current; an older one, or none, makes the host write it.
        if (!open) reload({ maxAge: 30000 })
      }

      const start = async () => {
        setBusy(true)
        try {
          const since = Date.now()
          await runCommand(ctx, sessionId, '/awr takeover')
          await reload({ since })
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      // Each action is the `/awr` command of the same name, so the panel and the conversation do the same thing and
      // a conflict or a refusal reads the same in both. Nothing is retried; the answer is shown as it came.
      const act = async (line) => {
        setActing(true)
        setNote(undefined)
        try {
          const since = Date.now()
          const text = await runCommand(ctx, sessionId, line)
          setNote({ ok: true, text })
          setForm(undefined)
          setDigest('')
          setNext('')
          await reload({ since })
        } catch (failure) {
          setNote({ ok: false, text: String(failure?.message ?? failure) })
        } finally {
          setActing(false)
        }
      }
      const saveCheckpoint = () => {
        const line = checkpointLine(digest, next)
        if (!line) setNote({ ok: false, text: t('action.invalid') })
        else act(line)
      }

      const state = view?.state ?? (error ? 'unavailable' : undefined)
      const dot =h('span', { 'data-testid': 'awr-dot', 'data-state': state ?? 'loading', style: { width: 7, height: 7, borderRadius: '50%', background: DOT[state] ?? '#8a8f98', display: 'inline-block' } })
      const button = h('button', { ref: trigger, id: 'awr-header-action', type: 'button', style: styles.trigger, title: t('trigger.title'), 'aria-label': t('trigger.title'), 'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: toggle }, dot, t('trigger.label'))
      if (!open || !anchor) return button

      const workNode = !(work && (view?.state === 'initialized' || view?.state === 'completed')) ? null : (() => {
        const bound = work.bound_work
        const when = (ms) => new Date(ms).toLocaleString()
        const canClaim = bound && !work.claims?.length && !FINISHED.has(bound.status)
        const flip = (name) => () => setForm(form === name ? undefined : name)
        const manage = work.session?.status !== 'active' ? null : h('div', { key: 'actions', 'data-testid': 'awr-actions', style: { marginTop: 8 } },
          h('div', { style: styles.heading }, t('action.title')),
          h('div', null,
            canClaim ? h('button', { id: 'awr-claim', type: 'button', title: bound.key, style: styles.action, disabled: acting, onClick: () => act('/awr claim') }, t('action.claim', { work: shortKey(bound.key) })) : null,
            h('button', { id: 'awr-checkpoint-open', type: 'button', style: styles.action, disabled: acting, onClick: flip('checkpoint') }, t('action.checkpoint')),
            h('button', { id: 'awr-end-open', type: 'button', style: styles.action, disabled: acting, onClick: flip('end') }, t('action.end'))),
          form === 'checkpoint' ? h('div', { 'data-testid': 'awr-checkpoint-form', style: { marginTop: 4 } },
            h('input', { id: 'awr-checkpoint-digest', type: 'text', value: digest, placeholder: t('action.digest'), 'aria-label': t('action.digest'), style: styles.input, onChange: (event) => setDigest(event.target.value) }),
            h('input', { id: 'awr-checkpoint-next', type: 'text', value: next, placeholder: t('action.next'), 'aria-label': t('action.next'), style: styles.input, onChange: (event) => setNext(event.target.value) }),
            h('button', { id: 'awr-checkpoint-save', type: 'button', style: styles.action, disabled: acting, onClick: saveCheckpoint }, t('action.save')),
            h('button', { id: 'awr-checkpoint-cancel', type: 'button', style: styles.action, disabled: acting, onClick: () => setForm(undefined) }, t('action.cancel'))) : null,
          form === 'end' ? h('div', { 'data-testid': 'awr-end-form', style: { marginTop: 4 } },
            h('div', { style: styles.small }, t('action.endNote')),
            h('select', { id: 'awr-end-outcome', value: outcome, 'aria-label': t('action.outcome'), style: styles.input, onChange: (event) => setOutcome(event.target.value) }, ...OUTCOMES.map((name) => h('option', { key: name, value: name }, t(`action.outcome.${name}`)))),
            h('button', { id: 'awr-end-confirm', type: 'button', style: styles.action, disabled: acting, onClick: () => act(`/awr end ${OUTCOMES.includes(outcome) ? outcome : 'ended'}`) }, t('action.confirmEnd')),
            h('button', { id: 'awr-end-cancel', type: 'button', style: styles.action, disabled: acting, onClick: () => setForm(undefined) }, t('action.cancel'))) : null)
        const noteNode = acting ? h('div', { key: 'working', style: { ...styles.small, marginTop: 6 } }, t('action.working'))
          : note ? h('div', { key: 'note', 'data-testid': 'awr-action-result', style: { ...(note.ok ? styles.small : styles.error), marginTop: 6 } }, note.text) : null
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
          work.blocked?.length ? h('div', { style: { marginTop: 4 } }, h('div', { style: styles.heading }, t('work.blockedList')), h('ul', { style: styles.list }, ...work.blocked.slice(0, 6).map((item) => h('li', { key: item.key, style: styles.mono }, `${item.key}${item.blocker ? `: ${item.blocker}` : ''}`)))) : null,
          manage,
          noteNode))
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
            h('div', null, t('receipt.result', { state: (() => { const state = receipt.organization?.state ?? receipt.result; return RECEIPT_STATES.has(state) ? t(`receipt.state.${state}`) : state })(), goals: receipt.organization?.goalTotal ?? 0, gaps: receipt.organization?.gapTotal ?? 0 })),
            h('div', { style: { ...styles.heading, marginTop: 8 } }, t('receipt.mapped')),
            list(receipt.mapped?.sources ?? [], (source) => `${source.path} (${source.adapter})`),
            h('div', { style: { ...styles.heading, marginTop: 8 } }, t('receipt.created')),
            list(receipt.created?.writes ?? [], (write) => write.path),
            h('div', { style: { ...styles.heading, marginTop: 8 } }, t('receipt.awaiting')),
            list(receipt.awaitingConfirmation ?? [], (goal) => `${goal.title ?? goal.key} (${goal.status})`),
            h('div', { style: { ...styles.small, marginTop: 8 } }, t('receipt.git'))))
        }
      }
      if (view?.awr) {
        body.push(view.awr.cli
          ? h('div', { key: 'awr', 'data-testid': 'awr-info', style: { ...styles.small, marginTop: 10 } }, h('div', { style: styles.mono }, t('awr.info', { version: view.awr.version ?? '?', where: view.awr.cli })), h('div', null, t(`awr.takeover.${view.awr.takeover === 'awr' ? 'awr' : 'plugin'}`)))
          : h('div', { key: 'awr', 'data-testid': 'awr-info', style: { ...styles.small, ...styles.error, marginTop: 10 } }, t('awr.error', { message: view.awr.error ?? '' })))
      }
      return h(React.Fragment, null, button, ReactDOM.createPortal(h('div', { ref: panel, role: 'dialog', 'aria-label': t('panel.title'), id: 'awr-panel', style: { ...styles.panel, top: anchor.top, left: anchor.left } }, h('div', { style: { ...styles.title, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, t('panel.title'), h('button', { id: 'awr-refresh', type: 'button', style: { ...styles.action, margin: 0, padding: '2px 8px' }, onClick: refresh }, t('panel.refresh'))), ...body), document.body))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'remote.workspaceFiles'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('awr', { en, zh }), 'dsh-awr: dictionaries')
        const Action = (props) => h(AwrAction, { ...props, __ctx: ctx })
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'awr-takeover', order: 30 }, Action))
      },
    }
  },
})
