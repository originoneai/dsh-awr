// The AWR state of a conversation's project, for the panel (DSH-051): the work this conversation is bound
// to, the claims of its session with their expiry, the blockers, and the counts and lists of `awr status`.
//
// Everything comes from awr (`status`, `session show`, `work show`) and is passed on as awr gave it; nothing
// is derived or cached here, so the panel cannot disagree with `awr status` for the same project.

const item = (work, sessionId) => ({
  key: work.key ?? work.external_key,
  title: work.title ?? null,
  status: work.status ?? work.raw_status ?? null,
  ...(work.next_action ? { next_action: work.next_action } : {}),
  ...(work.blocker ? { blocker: work.blocker } : {}),
  ...(Array.isArray(work.claims) && work.claims.length > 0 ? { claimed_by: work.claims.map((claim) => ({ agent: claim.agent, session: claim.session, this_conversation: claim.session === sessionId })) } : {}),
})

/**
 * The key of the work a conversation's AWR session is bound to. A binding made in this conversation knows its key; one
 * resumed from an earlier run, or made by a takeover, does not, and the compiled context of the session names it (also
 * when AWR calls that context incomplete). Undefined when the session has no work.
 *
 * @param {{ run(root: string, args: string[]): Promise<any> }} awr
 * @param {{ projectRoot: string, sessionId?: string, work?: { key: string } }} binding
 */
export async function boundWorkKey(awr, binding) {
  if (binding.work?.key) return binding.work.key
  if (!binding.sessionId) return undefined
  try {
    return (await awr.run(binding.projectRoot, ['context', 'compile', '--session', binding.sessionId, '--budget', '5000']))?.work_context?.identity?.work_item_key
  } catch (error) {
    return error?.details?.awrDocument?.work_context?.identity?.work_item_key
  }
}

/**
 * @param {{ run(root: string, args: string[]): Promise<any> }} awr the runner from `createAwr()`
 * @param {{ projectRoot: string, sessionId?: string, work?: { key: string } }} binding
 */
export async function buildStateView(awr, binding) {
  const { projectRoot, sessionId } = binding
  const status = await awr.run(projectRoot, ['status'])
  const lists = {
    in_progress: (status.current ?? []).map((work) => item(work, sessionId)),
    ready: (status.ready ?? []).map((work) => item(work, sessionId)),
    blocked: (status.blocked ?? []).map((work) => item(work, sessionId)),
    waiting: (status.waiting ?? []).map((work) => item(work, sessionId)),
  }
  const view = {
    project: { name: status.project ?? null, id: status.project_id ?? null, root: projectRoot, revision: status.project_revision ?? null },
    counts: status.counts ?? {},
    ...lists,
    ...(typeof status.next_action === 'string' ? { next_action: status.next_action } : {}),
    session: null,
    bound_work: null,
    claims: [],
  }
  if (!sessionId) return view

  const shown = await awr.run(projectRoot, ['session', 'show', sessionId])
  const session = shown?.session ?? {}
  view.session = { id: sessionId, status: session.status ?? null, started_at: session.started_at ?? null, ended_at: session.ended_at ?? null }

  const readWork = (key) => awr.run(projectRoot, ['work', 'show', key]).then((answer) => answer?.work).catch(() => undefined)

  const boundKey = await boundWorkKey(awr, binding)
  const bound = boundKey ? await readWork(boundKey) : undefined
  if (bound) {
    view.bound_work = {
      key: bound.external_key ?? boundKey,
      title: bound.title ?? null,
      status: bound.status ?? bound.raw_status ?? null,
      next_action: bound.next_action ?? null,
      blocker: bound.blocker ?? null,
      ready: bound.ready ?? null,
    }
  } else if (boundKey) {
    view.bound_work = { key: boundKey, title: null, status: null, next_action: null, blocker: null, ready: null }
  }

  // The claims of this session: `status` says which work they are on, `work show` gives the expiry.
  const claimed = [...new Set([...view.in_progress, ...view.ready, ...view.blocked, ...view.waiting].filter((work) => (work.claimed_by ?? []).some((claim) => claim.this_conversation)).map((work) => work.key))]
  const sessionClaims = (shown?.claims ?? []).filter((claim) => claim.status === 'active')
  for (const key of claimed) {
    const work = await readWork(key)
    const mine = (work?.active_claims ?? []).find((claim) => claim.session_id === sessionId)
    const acquired = sessionClaims.find((claim) => claim.work_item_id === work?.id)?.acquired_at ?? null
    view.claims.push({ work: key, acquired_at: acquired, expires_at: mine?.expires_at ?? null, this_session: true })
  }
  return view
}

/** The same, in words (for `/awr state` without `--json`). */
export function formatStateView(view) {
  const lines = [`Project ${view.project.name ?? view.project.id ?? '(unknown)'}, revision ${view.project.revision}`]
  lines.push(`${view.in_progress.length} in progress, ${view.ready.length} ready, ${view.blocked.length} blocked, ${view.waiting.length} waiting`)
  if (view.session) {
    lines.push(`This conversation: AWR session ${view.session.id} (${view.session.status})`)
    if (view.bound_work) lines.push(`Bound work: ${view.bound_work.key}${view.bound_work.title ? ` ${view.bound_work.title}` : ''} [${view.bound_work.status}]${view.bound_work.next_action ? `; next: ${view.bound_work.next_action}` : ''}${view.bound_work.blocker ? `; blocked: ${view.bound_work.blocker}` : ''}`)
    for (const claim of view.claims) lines.push(`Claim on ${claim.work ?? '(unknown work)'}: ${claim.expires_at ? `expires ${new Date(claim.expires_at).toISOString()}` : 'no expiry'}`)
    if (view.claims.length === 0) lines.push('This session holds no claim.')
  } else {
    lines.push('This conversation is not bound to an AWR session.')
  }
  for (const work of view.blocked) lines.push(`Blocked: ${work.key}${work.blocker ? `: ${work.blocker}` : ''}`)
  return lines.join('\n')
}
