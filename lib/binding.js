// Binds a DeepSeek Harness conversation to an AWR session without taking a claim.
//
// AWR already stores the mapping between a host conversation and its AWR session
// (`awr client bind`, `client generic`), so nothing is persisted on the DSH side: the mapping is
// read back with `awr client show`. What AWR does, and what this module builds on:
//   - `client bind` without `--session` creates an active AWR session for a new external
//     conversation id, or returns the existing one for an id it already knows. It never acquires
//     a claim.
//   - Once that session has ended, the same external id cannot be bound again. The conversation
//     continues under a new external id with `--from-session <ended session>`.
// So a conversation has generations: `dsh:<id>`, then `dsh:<id>#2`, `dsh:<id>#3`, and so on.
//
// A fork (DSH-016) is a new conversation that begins with the parent's history. `--from-session` is the only way
// AWR carries a session's recorded context over, and it is a resume: the predecessor is interrupted and its claims
// are closed (checked against the real awr, docs/binding.md). That is right for a parent whose session has ended and
// wrong for a parent that is still going, so a fork continues the parent's session only when it has ended, and
// otherwise gets its own session and leaves the parent's alone.
import { AwrError, explain } from './awr-runtime.js'

/** Upper bound on generations followed for one conversation, so a bad record cannot loop forever. */
const MAX_GENERATIONS = 20

/** The external session id AWR stores for generation `generation` of a DSH conversation. */
export function externalId(conversationId, generation = 1) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) {
    throw new TypeError('conversationId must be a non-empty string')
  }
  return generation === 1 ? `dsh:${conversationId}` : `dsh:${conversationId}#${generation}`
}

/**
 * The work item a new binding attaches to, from an `awr status` result: work that is already
 * in progress and has no active claim, else the first ready work, else the first blocked work
 * (a freshly initialized project holds only its blocked intake task). This is a policy of the
 * plugin, not of AWR; binding does not claim, so the choice only decides what context is
 * recovered and which work the conversation's checkpoints belong to.
 *
 * @param {{ current?: Array<{ key: string, claims?: unknown[] }>, ready?: Array<{ key: string, claims?: unknown[] }>, blocked?: Array<{ key: string, claims?: unknown[] }> }} status
 * @returns {{ key: string, why: 'in_progress' | 'ready' | 'blocked' } | undefined}
 */
export function chooseWork(status) {
  const free = (item) => item?.key && !(item.claims?.length > 0)
  for (const [list, why] of [['current', 'in_progress'], ['ready', 'ready'], ['blocked', 'blocked']]) {
    const item = (status?.[list] ?? []).find(free)
    if (item) return { key: item.key, why }
  }
  return undefined
}

/**
 * The key of the work a session holds a claim on, from an `awr status` result, or `undefined` when it holds none.
 * A fork binds to its parent's work, which the parent's own claim hides from `chooseWork`.
 *
 * @param {{ current?: any[], ready?: any[], blocked?: any[], waiting?: any[] }} status
 */
export function workClaimedBy(status, sessionId) {
  for (const list of ['current', 'ready', 'blocked', 'waiting']) {
    for (const item of status?.[list] ?? []) {
      if (item?.key && (item.claims ?? []).some((claim) => claim?.session === sessionId)) return item.key
    }
  }
  return undefined
}

/**
 * The newest binding of a conversation across its generations: the AWR session its latest external id is bound to and
 * that session's status, or `undefined` when the conversation was never bound.
 *
 * @param {{ run(root: string, args: string[]): Promise<any> }} awr
 * @returns {Promise<{ externalSession: string, sessionId: string, status?: string } | undefined>}
 */
export async function latestBinding(awr, projectRoot, conversationId) {
  let latest
  for (let generation = 1; generation <= MAX_GENERATIONS; generation++) {
    const externalSession = externalId(conversationId, generation)
    const shown = await awr.run(projectRoot, ['client', 'show', '--client', 'generic', '--external-session', externalSession])
    const bound = shown?.binding
    if (!bound) break
    const detail = await awr.run(projectRoot, ['session', 'show', bound.session_id])
    latest = { externalSession, sessionId: bound.session_id, status: (detail?.session ?? detail)?.status }
  }
  return latest
}

/**
 * Bind one DSH conversation to an AWR session.
 *
 * Returns one of:
 *   - `{ outcome: 'existing', sessionId, externalSession }`: an active session is already bound
 *     (a resumed conversation);
 *   - `{ outcome: 'created', sessionId, externalSession, work, successorOf?, fork? }`, where `fork` is
 *     `{ parentConversation, parentSession?, mode, reason? }` for a conversation that was forked from a bound one;
 *   - `{ outcome: 'skipped', reason }` when there is nothing to bind to.
 * Errors from awr are thrown as `AwrError` by the runner; this function never claims work.
 *
 * `forkOf` is asked only when the conversation has no binding yet: it resolves to `{ conversationId }` of the
 * conversation this one was forked from, or to nothing. A parent that was never bound, or a resolver that fails,
 * leaves the conversation bound as a new one.
 *
 * @param {{ run(root: string, args: string[]): Promise<any> }} awr the runner from `createAwr()`
 * @param {{ projectRoot: string, conversationId: string, model?: string, workKey?: string, forkOf?: () => Promise<{ conversationId: string } | undefined> }} request
 */
export async function bindConversation(awr, { projectRoot, conversationId, model, workKey, forkOf }) {
  let previous
  for (let generation = 1; generation <= MAX_GENERATIONS; generation++) {
    const externalSession = externalId(conversationId, generation)
    const shown = await awr.run(projectRoot, ['client', 'show', '--client', 'generic', '--external-session', externalSession])
    const bound = shown?.binding
    if (!bound) {
      if (generation === 1 && forkOf) return createFork(awr, { projectRoot, externalSession, model, workKey, forkOf })
      return create(awr, { projectRoot, externalSession, model, workKey, previous })
    }
    const detail = await awr.run(projectRoot, ['session', 'show', bound.session_id])
    const status = (detail?.session ?? detail)?.status
    if (status === 'active') {
      return { outcome: 'existing', sessionId: bound.session_id, externalSession }
    }
    // That session ended; the conversation continues in the next generation.
    previous = bound.session_id
  }
  return { outcome: 'skipped', reason: `more than ${MAX_GENERATIONS} generations for one conversation` }
}

async function createFork(awr, { projectRoot, externalSession, model, workKey, forkOf }) {
  const plain = () => create(awr, { projectRoot, externalSession, model, workKey })
  let parent
  try {
    parent = await forkOf()
  } catch {
    parent = undefined
  }
  if (!parent?.conversationId) return plain()

  const fork = { parentConversation: parent.conversationId }
  const note = (created, extra) => (created.outcome === 'created' ? { ...created, fork: { ...fork, ...extra } } : created)
  let latest
  try {
    latest = await latestBinding(awr, projectRoot, parent.conversationId)
  } catch (error) {
    if (!(error instanceof AwrError)) throw error
    return note(await plain(), { mode: 'lookup_failed', reason: explain(error).slice(0, 200) })
  }
  if (!latest) return note(await plain(), { mode: 'parent_unbound' })
  fork.parentSession = latest.sessionId
  // The work the parent is on, when its session holds a claim: `chooseWork` skips claimed work, so a project whose
  // only work is the parent's would leave the fork unbound.
  let status
  try {
    status = await awr.run(projectRoot, ['status'])
  } catch (error) {
    if (!(error instanceof AwrError)) throw error
  }
  const parentWork = workKey ? undefined : workClaimedBy(status, latest.sessionId)
  const bound = { projectRoot, externalSession, model, workKey: workKey ?? parentWork, workWhy: parentWork ? 'parent_claim' : undefined, status }
  // The parent is still going: resuming from its session would interrupt it. The fork gets its own.
  if (latest.status === 'active') return note(await create(awr, bound), { mode: 'parent_active' })
  try {
    return note(await create(awr, { ...bound, previous: latest.sessionId }), { mode: 'continued' })
  } catch (error) {
    if (!(error instanceof AwrError)) throw error
    // The continuation is a convenience on top of binding; failing it must not leave the fork unbound.
    return note(await create(awr, bound), { mode: 'continuation_failed', reason: explain(error).slice(0, 200) })
  }
}

async function create(awr, { projectRoot, externalSession, model, workKey, workWhy = 'requested', previous, status }) {
  let work = workKey ? { key: workKey, why: workWhy ?? 'requested' } : undefined
  if (!work) {
    work = chooseWork(status ?? (await awr.run(projectRoot, ['status'])))
    if (!work) return { outcome: 'skipped', reason: 'the project has no work to bind to' }
  }
  const args = ['client', 'bind', '--client', 'generic', '--external-session', externalSession, '--work', work.key]
  if (model) args.push('--model', model)
  if (previous) args.push('--from-session', previous)
  const result = await awr.run(projectRoot, args)
  const sessionId = result?.binding?.session_id
  if (!sessionId) {
    return { outcome: 'skipped', reason: 'awr returned no session for the binding' }
  }
  return { outcome: 'created', sessionId, externalSession, work, ...(previous ? { successorOf: previous } : {}) }
}
