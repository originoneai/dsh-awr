// The AWR light in the conversation header and the card it opens.
//
// The light says how the project stands at a glance: an empty ring when AWR does not manage it, a pulsing light while a
// takeover runs, green when all is well, amber when something needs the person, red when a takeover stopped. The card
// answers the next question in plain words and offers the one thing a person can do there. What an agent does on its
// own (claiming work, saving progress notes, ending its record) is not offered as buttons: those are `/awr` commands.

const UPDATE_SPEC = /^github:[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+#[0-9a-f]{40}$/

/** What the header light shows for the project's state. */
function lightOf(data) {
  const view = data?.view
  if (!view) return { state: 'planned' }
  if (view.state === 'running') return { state: 'active', pulse: true }
  if (view.state === 'stopped' || view.state === 'failed') return { state: 'blocked' }
  if (view.state === 'interrupted') return { state: 'waiting' }
  if (view.state === 'initialized' || view.state === 'completed') {
    // Amber when the person has something to do: an obstacle somebody recorded, a project AWR cannot start work in yet,
    // or goals that wait for confirmation. Work that merely is not ready is not the person's to do.
    const work = data.work
    const needs = (work?.blocked ?? []).some((item) => item.blocker) || (work?.counts?.blocked ?? 0) > 0 || work?.organization?.ready === false || (view.receipt?.awaitingConfirmation?.length ?? 0) > 0
    return { state: needs ? 'waiting' : 'good' }
  }
  return { state: 'ready' }
}

/** The step a takeover is at: the first one that is not finished. */
function currentStep(view) {
  const status = (name) => view.steps?.find((step) => step.name === name)?.status
  const index = STEPS.findIndex((name) => !['done', 'skipped'].includes(status(name)))
  return index === -1 ? STEPS.length - 1 : index
}

/** Six segments, one per step: inked when done, lit while running, red where it stopped. */
function Stepper({ view }) {
  const done = STEPS.filter((name) => ['done', 'skipped'].includes(view.steps?.find((step) => step.name === name)?.status)).length
  return h('div', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': STEPS.length, 'aria-valuenow': done, 'data-testid': 'awr-steps', style: { display: 'flex', gap: 3 } },
    ...STEPS.map((name) => {
      const status = view.steps?.find((step) => step.name === name)?.status ?? 'pending'
      const fill = status === 'done' || status === 'skipped' ? C.text : status === 'running' ? C.live : status === 'stopped' || status === 'failed' ? C.bad : C.active
      return h('span', { key: name, 'data-step': name, 'data-status': status, className: status === 'running' ? 'awr-pulse' : undefined, style: { flex: 1, height: 4, borderRadius: 2, background: fill } })
    }))
}

const P = {
  title: { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 500, color: C.text },
  body: { margin: '4px 0 0', fontSize: 13, lineHeight: '20px', color: C.text2 },
  note: { margin: '8px 0 0', fontSize: 12, lineHeight: '18px', color: C.text3 },
  label: { fontSize: 12, lineHeight: '16px', color: C.text3 },
  rule: { height: 0, margin: '12px 0', border: 0, borderTop: `.5px solid ${C.line2}` },
}

/** The takeover not yet done: the offer, the progress, or why it stopped. */
function TakeoverBlock({ view, t, busy, onStart, failure, installer, onRuntime, runtimeBusy }) {
  if (view.state === 'unavailable') {
    return h('div', { 'data-testid': 'awr-none' },
      h('p', { style: P.title }, t('none.title')),
      h('p', { style: P.body }, view.stop?.reason === 'too_broad' ? t('none.broad') : t('none.body')))
  }
  if (view.state === 'running') {
    const index = currentStep(view)
    return h('div', { 'data-testid': 'awr-running' },
      h('p', { style: P.title }, t('run.title')),
      h('div', { style: { margin: '12px 0 8px' } }, h(Stepper, { view })),
      h('p', { style: { ...P.body, margin: 0, color: C.text } }, t('run.step', { n: index + 1, total: STEPS.length, step: t(`step.${STEPS[index]}`) })),
      h('p', { style: P.note }, t('run.body')))
  }
  const stopped = view.state === 'stopped' || view.state === 'failed' || view.state === 'interrupted'
  const reasonKey = `reason.${view.stop?.reason}`
  const detail = view.stop?.detail
  const location = detail?.path ? `${detail.path}${detail.line ? `:${detail.line}` : ''}` : undefined
  // Stopped because there is no usable awr on the machine: the bundled awr (DSH-067) is the way forward,
  // so the install takes the place of the retry that would only stop again.
  const awrMissing = stopped && Boolean(view.awr?.error) && installer && installer.state !== 'unsupported'
  return h('div', { 'data-testid': stopped ? 'awr-stopped' : 'awr-offer' },
    h('p', { style: P.title }, stopped ? t(`stop.title.${view.state}`) : t('start.title')),
    stopped
      ? h(React.Fragment, null,
          h('div', { style: { margin: '12px 0 8px' } }, h(Stepper, { view })),
          h('p', { style: P.body, 'data-testid': 'awr-reason' }, view.state === 'interrupted' && !view.stop ? t('stop.body.interrupted') : t(en[reasonKey] ? reasonKey : 'reason.default')),
          location ? h('p', { style: P.note, 'data-testid': 'awr-stop-location' }, t('stop.location', { location })) : null)
      : h(React.Fragment, null,
          h('p', { style: P.body }, t('start.body')),
          h('p', { style: P.note }, t('start.safe'))),
    h('div', { style: { marginTop: 16 } },
      awrMissing
        ? h('button', { id: 'awr-runtime-install', type: 'button', className: 'awr-btn awr-btn-primary', disabled: busy || runtimeBusy, onClick: () => onRuntime?.() },
            runtimeBusy ? t('runtime.installing') : installer.state === 'installed' ? t('runtime.use', { version: installer.version }) : t('runtime.install'))
        : h('button', { id: 'awr-takeover-start', type: 'button', className: 'awr-btn awr-btn-primary', disabled: busy, onClick: onStart }, busy ? t('start.starting') : stopped ? t('stop.continue') : t('start.button'))),
    failure ? h('p', { style: { ...P.note, color: C.bad }, 'data-testid': 'awr-failure' }, failure) : null)
}

/** A project AWR manages: how it stands, what this conversation is on, and what needs the person. */
function ManagedBlock({ view, work, t }) {
  // AWR lists a few of the work in each queue and counts all of it: the counts are shown, the lists say which.
  const totals = work?.totals ?? {}
  const counts = [['active', totals.active ?? work?.in_progress?.length ?? 0], ['ready', totals.ready ?? work?.ready?.length ?? 0], ['held', totals.blocked ?? work?.blocked?.length ?? 0]]
  const bound = work?.bound_work
  const blocked = work?.blocked ?? []
  // What is recorded as the obstacle is a blocker; the rest of the queue only cannot start yet.
  const stuck = blocked.filter((item) => item.blocker)
  const held = blocked.filter((item) => !item.blocker)
  const setup = work?.organization?.ready === false
  const goals = view.receipt?.awaitingConfirmation?.length ?? 0
  const listed = [
    ...stuck.slice(0, 2).map((item) => ({ key: item.key, state: 'blocked', text: t('managed.needs.blocked', { title: item.title ?? short(item.key) }), detail: item.blocker })),
    // While the project is incomplete nothing can start; one line says so instead of one for each piece of work.
    ...(setup ? [{ key: 'setup', state: 'waiting', text: t('managed.needs.setup', { n: work.organization.gaps }) }]
      : held.slice(0, Math.max(0, 2 - Math.min(stuck.length, 2))).map((item) => ({ key: item.key, state: 'waiting', text: t('managed.needs.held', { title: item.title ?? short(item.key) }) }))),
  ]
  const needs = [...listed, ...(goals > 0 ? [{ key: 'goals', state: 'waiting', text: t('managed.needs.goals', { n: goals }) }] : [])]
  const more = setup ? Math.max(0, stuck.length - 2) : Math.max(0, (totals.blocked ?? blocked.length) - listed.length)
  const receipt = view.state === 'completed' ? view.receipt : undefined
  return h('div', { 'data-testid': 'awr-managed' },
    receipt ? h('p', { style: { ...P.body, margin: '0 0 12px' }, 'data-testid': 'awr-done' }, h('span', { style: { color: C.text, fontWeight: 500 } }, t('done.title')), ' · ', t('done.body', { goals: receipt.organization?.goalTotal ?? 0, gaps: receipt.organization?.gapTotal ?? 0 })) : null,
    work
      ? h('div', { 'data-testid': 'awr-counts', style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' } },
          ...counts.map(([name, value], index) => h('div', { key: name, 'data-count': name, style: { paddingLeft: index ? 12 : 0, borderLeft: index ? `.5px solid ${C.line2}` : 0 } },
            h('div', { style: { fontSize: 20, lineHeight: '24px', fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: value > 0 && name === 'held' && (stuck.length > 0 || (work?.counts?.blocked ?? 0) > 0) ? C.bad : C.text } }, value),
            h('div', { style: P.label }, t(`count.${name}`)))))
      : null,
    bound ? h('div', { 'data-testid': 'awr-bound-work', style: { marginTop: 16 } },
      h('div', { style: P.label }, t('managed.here')),
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 } },
        h('span', { style: { transform: 'translateY(-1px)' } }, h(Light, { state: bound.blocker ? 'blocked' : bound.status === 'completed' ? 'done' : bound.status === 'in_progress' ? 'active' : 'ready' })),
        h('span', { className: 'awr-clamp2', style: { minWidth: 0, color: C.text } }, bound.title ?? short(bound.key))),
      bound.blocker ? h('div', { className: 'awr-clamp2', style: { ...P.note, margin: '2px 0 0 16px', color: C.bad } }, bound.blocker)
        : bound.next_action ? h('div', { className: 'awr-clamp2', style: { ...P.note, margin: '2px 0 0 16px' } }, t('managed.next', { text: bound.next_action })) : null) : null,
    needs.length ? h('div', { 'data-testid': 'awr-needs', style: { marginTop: 16 } },
      h('div', { style: P.label }, t('managed.needs')),
      ...needs.map((item) => h('div', { key: item.key, style: { display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 } },
        h('span', { style: { transform: 'translateY(-1px)' } }, h(Light, { state: item.state })),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'awr-clamp2', style: { color: C.text } }, item.text),
          item.detail ? h('div', { className: 'awr-clamp2', style: { ...P.note, margin: 0 } }, item.detail) : null))),
      more > 0 ? h('div', { style: { ...P.note, margin: '4px 0 0 16px' } }, t('managed.more', { n: more })) : null) : null,
    work && !bound && !needs.length && counts.every(([, value]) => value === 0) ? h('p', { style: { ...P.note, marginTop: 12 } }, t('managed.idle')) : null,
    h('p', { style: { ...P.note, marginTop: 16 } }, t('pop.page')))
}

/** What stays folded: paths, revisions, identifiers, the raw steps and messages of a takeover, the awr in use. */
function TechDetails({ view, work, plugin, t }) {
  const receipt = view.receipt
  const bound = work?.bound_work
  const files = (label, items, render) => (items?.length ? h('div', { style: { marginTop: 8 } },
    h('div', { style: P.label }, label),
    ...items.map((item, index) => h('div', { key: index, style: { fontFamily: C.mono, fontSize: 11.5, lineHeight: '18px', color: C.text2, wordBreak: 'break-all' } }, render(item)))) : null)
  return h('div', { 'data-testid': 'awr-tech', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
    h(Fact, { label: t('tech.project'), value: view.projectRoot }),
    h(Fact, { label: t('tech.revision'), value: work?.project?.revision }),
    work?.session ? h(Fact, { label: t('tech.session'), value: `${work.session.id} (${work.session.status})` }) : null,
    h(Fact, { label: t('tech.work'), value: bound?.key }),
    view.awr?.cli ? h(Fact, { label: t('tech.awr'), value: `${view.awr.version ?? '?'} · ${view.awr.cli}` }) : null,
    view.awr ? h('div', { 'data-testid': 'awr-info', style: { fontSize: 12, lineHeight: '18px', color: view.awr.cli ? C.text3 : C.bad } }, view.awr.cli ? t(`tech.takeover.${view.awr.takeover === 'awr' ? 'awr' : 'plugin'}`) : t('tech.awr.error', { message: view.awr.error ?? '' })) : null,
    plugin?.version ? h(Fact, { label: t('update.version', { version: '' }).trim(), value: [plugin.version, plugin.installed ? plugin.installed.slice(0, 7) : undefined, plugin.repo ? `GitHub ${plugin.repo}` : undefined].filter(Boolean).join(' · ') }) : null,
    plugin?.kind === 'checkout' ? h('div', { style: { fontSize: 12, lineHeight: '18px', color: C.text3 } }, t('update.local')) : plugin?.kind === 'other' ? h('div', { style: { fontSize: 12, lineHeight: '18px', color: C.text3 } }, t('update.other')) : null,
    view.steps?.length ? h('div', { style: { marginTop: 8 } },
      h('div', { style: P.label }, t('tech.steps')),
      ...STEPS.map((name) => {
        const status = view.steps.find((step) => step.name === name)?.status ?? 'pending'
        return h('div', { key: name, style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, lineHeight: '18px', color: C.text2 } }, h('span', null, t(`step.${name}`)), h('span', { style: { color: C.text3 } }, t(`status.${status}`)))
      })) : null,
    view.stop ? h('div', { style: { marginTop: 8 } },
      h(Fact, { label: t('tech.reason'), value: view.stop.reason }),
      h(Fact, { label: t('tech.message'), value: view.stop.message, mono: false })) : null,
    receipt ? h('div', { 'data-testid': 'awr-receipt' },
      files(t('tech.read'), receipt.mapped?.sources, (source) => `${source.path}${source.adapter ? ` (${source.adapter})` : ''}`),
      files(t('tech.created'), receipt.created?.writes, (write) => write.path),
      h('div', { style: { ...P.label, marginTop: 8 } }, t('tech.git'))) : null,
    h('div', { style: { ...P.label, marginTop: 8 } }, t('tech.commands')))
}

/** The plugin's own version, and the update from GitHub when the plugin was installed from there. */
function UpdateLine({ plugin, t, busy, onCheck, onApply, canApply, status: reported }) {
  if (!plugin?.version) return null
  const check = plugin.check
  const github = plugin.kind === 'github'
  // What the host says is installed outranks what this card remembers of its own try: the host loads the updated plugin
  // while the call is still open, so the answer of the call may never arrive (or arrive as a failure) for an update that went through.
  const taken = github && Boolean(check) && check.available === false
  const status = taken && (reported?.phase === 'applying' || reported?.phase === 'failed') ? undefined : reported
  let right = null
  if (status?.phase === 'checking') right = h('span', { style: { color: C.text3 } }, t('update.checking'))
  else if (status?.phase === 'applying') right = h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, color: C.text2 } }, h(Icon, { name: 'refresh', size: 12, className: 'awr-spin' }), t('update.applying'))
  else if (status?.phase === 'done' || status?.phase === 'restart') right = h('span', { style: { color: C.text2 } }, t(`update.${status.phase}`))
  // The files on disk are newer than the code the host loaded (an update was installed): it takes effect at the next start.
  else if (plugin.running && plugin.running !== plugin.version) right = h('span', { 'data-testid': 'awr-update-restart', style: { color: C.text2 } }, t('update.restart'))
  else if (github && check?.available) {
    right = h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, color: C.text } }, h(Light, { state: 'active', size: 6 }), t('update.available')),
      canApply ? h('button', { id: 'awr-update-apply', type: 'button', className: 'awr-btn awr-btn-soft', style: { height: 24, padding: '0 10px', fontSize: 12 }, disabled: busy, onClick: onApply }, t('update.apply')) : null)
  } else if (github) {
    right = h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
      check ? h('span', { style: { color: C.text3 } }, t('update.current')) : null,
      h('button', { id: 'awr-update-check', type: 'button', className: 'awr-btn awr-btn-quiet', style: { height: 24, fontSize: 12, margin: '0 -8px 0 0' }, disabled: busy, onClick: onCheck }, t('update.check')))
  }
  return h('div', { 'data-testid': 'awr-update' },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 24, fontSize: 12, lineHeight: '16px', color: C.text3 } },
      h('span', null, t('update.version', { version: plugin.version })), right),
    status?.phase === 'failed' ? h('p', { style: { ...P.note, margin: '4px 0 0', color: C.bad }, 'data-testid': 'awr-update-failure' }, status.text) : null)
}

/** The bundled awr (DSH-067): its version, and a check and update against the newest originoneai/awr release. */
function RuntimeLine({ installer, t, busy, onCheck, onUpdate, status }) {
  if (!installer || installer.state === 'unsupported') return null
  const check = installer.check
  let right = null
  if (status?.phase === 'checking') right = h('span', { style: { color: C.text3 } }, t('update.checking'))
  else if (status?.phase === 'applying') right = h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, color: C.text2 } }, h(Icon, { name: 'refresh', size: 12, className: 'awr-spin' }), t('update.applying'))
  else if (check?.available) {
    right = h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, color: C.text } }, h(Light, { state: 'active', size: 6 }), t('update.available')),
      h('button', { id: 'awr-runtime-apply', type: 'button', className: 'awr-btn awr-btn-soft', style: { height: 24, padding: '0 10px', fontSize: 12 }, disabled: busy, onClick: onUpdate }, t('update.apply')))
  } else {
    right = h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
      check ? h('span', { style: { color: C.text3 } }, t('update.current')) : null,
      h('button', { id: 'awr-runtime-check', type: 'button', className: 'awr-btn awr-btn-quiet', style: { height: 24, fontSize: 12, margin: '0 -8px 0 0' }, disabled: busy, onClick: onCheck }, t('update.check')))
  }
  return h('div', { 'data-testid': 'awr-runtime' },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 24, fontSize: 12, lineHeight: '16px', color: C.text3 } },
      h('span', null, installer.state === 'installed' ? t('runtime.line', { version: installer.version }) : t('runtime.none')), right),
    status?.phase === 'failed' ? h('p', { style: { ...P.note, margin: '4px 0 0', color: C.bad }, 'data-testid': 'awr-runtime-failure' }, status.text) : null)
}

function AwrChip(props) {
  const ctx = props.__ctx
  const host = props.__host
  const sessionId = props.sessionId
  const t = React.useMemo(() => translator(ctx), [ctx])
  const [open, setOpen] = React.useState(false)
  const [anchor, setAnchor] = React.useState(undefined)
  const [failure, setFailure] = React.useState(undefined)
  const [update, setUpdate] = React.useState(undefined)
  const [runtime, setRuntime] = React.useState(undefined)
  const trigger = React.useRef(null)
  const card = React.useRef(null)
  const project = useProjectState(ctx, sessionId, t, open)
  const { data, error, busy } = project
  const view = data?.view

  React.useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return
      if (event.type === 'mousedown' && (card.current?.contains(event.target) || trigger.current?.contains(event.target))) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  // An update that is on offer may have been taken since (from here, before this card was rebuilt, or by hand): when the
  // card opens on one, the host is asked again, so the card does not offer what is installed already.
  React.useEffect(() => {
    if (open && data?.plugin?.check?.available) project.refresh()
  }, [open])

  const toggle = () => {
    if (!open && trigger.current) {
      const rect = trigger.current.getBoundingClientRect()
      setAnchor({ top: rect.bottom + 6, left: Math.max(12, Math.min(rect.left, window.innerWidth - 352)) })
    }
    setOpen(!open)
  }
  const start = async () => {
    setFailure(undefined)
    try {
      await project.act('/awr takeover')
    } catch (problem) {
      setFailure(String(problem?.message ?? problem))
    }
  }
  const checkUpdate = async () => {
    setUpdate({ phase: 'checking' })
    try {
      await project.act('/awr update check')
      setUpdate(undefined)
    } catch (problem) {
      setUpdate({ phase: 'failed', text: String(problem?.message ?? problem) })
    }
  }
  // The update installs the same repository pinned to the newest commit with DeepSeek Harness's plugin manager, which
  // replaces the dependency in one step and puts the profile back if it fails. Only a spec of that exact shape is sent.
  const applyUpdate = async () => {
    const spec = data?.plugin?.check?.spec
    const manager = host?.manager
    if (!manager || !UPDATE_SPEC.test(String(spec ?? ''))) return
    setUpdate({ phase: 'applying' })
    try {
      const answer = await manager.installBundle(spec, { requestId: `dsh-awr-update-${Date.now()}` })
      if (!answer?.ok) throw new Error(answer?.error?.code ?? 'refused')
      const result = answer.value ?? {}
      if (result.application === 'applied' || result.application === 'overridden') { setUpdate({ phase: 'done' }); project.refresh() }
      else if (result.application === 'restart-required') { setUpdate({ phase: 'restart' }); project.refresh() }
      else {
        const offline = result.failedAt === 'spec-host' || ['network', 'timeout'].includes(result.packageResult?.kind)
        setUpdate({ phase: 'failed', text: offline ? t('update.failed.network') : t('update.failed'), code: result.error?.code ?? result.packageResult?.kind ?? result.application })
        project.refresh()
      }
    } catch (problem) {
      setUpdate({ phase: 'failed', text: t('update.failed'), code: String(problem?.message ?? problem) })
      project.refresh()
    }
  }

  const checkRuntime = async () => {
    setRuntime({ phase: 'checking' })
    try {
      await project.act('/awr runtime check')
      setRuntime(undefined)
    } catch (problem) {
      setRuntime({ phase: 'failed', text: String(problem?.message ?? problem) })
    }
  }
  // The install downloads the platform release, verifies and unpacks it, and with --use also binds this
  // conversation's project to it (the takeover stopped on the missing awr is then retried with the same button).
  const installRuntime = async (use) => {
    setRuntime({ phase: 'applying' })
    try {
      await project.act(`/awr runtime install${use ? ' --use' : ''}`)
      setRuntime(undefined)
    } catch (problem) {
      setRuntime({ phase: 'failed', text: t('runtime.failed') })
    }
  }

  const light = lightOf(data)
  const button = h('button', { ref: trigger, id: 'awr-header-action', type: 'button', className: 'awr-chip', title: t('chip.title'), 'aria-label': t('chip.title'), 'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: toggle },
    h('span', { 'data-testid': 'awr-dot', 'data-state': view?.state ?? (error ? 'unavailable' : 'loading'), style: { display: 'inline-flex' } }, h(Light, { state: light.state, size: 7, pulse: light.pulse })),
    t('chip.label'))
  if (!open || !anchor) return button

  const managed = view && (view.state === 'initialized' || view.state === 'completed')
  const name = managed ? baseName(view.projectRoot) : ''
  const body = []
  if (!view && !error) body.push(h('p', { key: 'load', style: { ...P.body, margin: 0, color: C.text3 } }, t('pop.loading')))
  if (!view && error) {
    body.push(h('div', { key: 'error', 'data-testid': 'awr-error' },
      h('p', { style: P.title }, t('pop.error.title')),
      h('div', { style: { marginTop: 12 } }, h('button', { type: 'button', className: 'awr-btn awr-btn-soft', onClick: project.refresh }, t('pop.error.retry'))),
      h('div', { style: { marginTop: 12 } }, h(Fold, { label: t('tech.title') }, h('div', { style: { fontSize: 12, lineHeight: '18px', color: C.text2, wordBreak: 'break-word' } }, error)))))
  }
  if (view) {
    body.push(managed
      ? h(ManagedBlock, { key: 'managed', view, work: data.work ?? undefined, t })
      : h(TakeoverBlock, { key: 'takeover', view, t, busy, onStart: start, failure, installer: data.installer ?? undefined, onRuntime: () => installRuntime(true), runtimeBusy: runtime?.phase === 'applying' }))
    body.push(h('hr', { key: 'rule', style: P.rule }))
    body.push(h(UpdateLine, { key: 'update', plugin: data.plugin ?? undefined, t, busy: busy || update?.phase === 'applying', onCheck: checkUpdate, onApply: applyUpdate, canApply: Boolean(host?.manager), status: update }))
    body.push(h(RuntimeLine, { key: 'runtime', installer: data.installer ?? undefined, t, busy: busy || runtime?.phase === 'applying', onCheck: checkRuntime, onUpdate: () => installRuntime(false), status: runtime }))
    body.push(h('div', { key: 'tech', style: { marginTop: data.plugin?.version ? 8 : 0 } }, h(Fold, { label: t('tech.title'), testId: 'awr-tech-fold' }, h(TechDetails, { view, work: data.work ?? undefined, plugin: data.plugin ?? undefined, t }))))
  }
  const cardStyle = { position: 'fixed', zIndex: 1000, top: anchor.top, left: anchor.left, width: 340, maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(560px, calc(100vh - 96px))', overflow: 'auto', boxSizing: 'border-box', padding: 16, background: C.menu, color: C.text, border: `.5px solid ${C.line2}`, borderRadius: 'var(--dsw-radius-md, 12px)', boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.12))', backdropFilter: 'saturate(180%) blur(20px)', fontSize: 13, lineHeight: '20px' }
  return h(React.Fragment, null, button, ReactDOM.createPortal(
    h('div', { ref: card, role: 'dialog', 'aria-label': t('chip.title'), id: 'awr-panel', className: 'awr-pop', style: cardStyle },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, margin: '-4px -4px 8px 0', minHeight: 28 } },
        name
          ? h('div', { style: { minWidth: 0 } },
              h('div', { className: 'awr-clamp1', style: { fontSize: 14, lineHeight: '20px', fontWeight: 500 } }, name),
              h('div', { style: P.label }, t('managed.caption')))
          : h('div', { style: P.label }, 'AWR'),
        h('button', { id: 'awr-refresh', type: 'button', className: 'awr-btn awr-btn-icon', title: t('pop.refresh'), 'aria-label': t('pop.refresh'), onClick: project.refresh }, h(Icon, { name: 'refresh', size: 14 }))),
      ...body),
    document.body))
}
