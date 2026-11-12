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
 * Bind one DSH conversation to an AWR session.
 *
 * Returns one of:
 *   - `{ outcome: 'existing', sessionId, externalSession }`: an active session is already bound
 *     (a resumed conversation);
 *   - `{ outcome: 'created', sessionId, externalSession, work, successorOf? }`;
 *   - `{ outcome: 'skipped', reason }` when there is nothing to bind to.
 * Errors from awr are thrown as `AwrError` by the runner; this function never claims work.
 *
 * @param {{ run(root: string, args: string[]): Promise<any> }} awr the runner from `createAwr()`
 * @param {{ projectRoot: string, conversationId: string, model?: string, workKey?: string }} request
 */
export async function bindConversation(awr, { projectRoot, conversationId, model, workKey }) {
  let previous
  for (let generation = 1; generation <= MAX_GENERATIONS; generation++) {
    const externalSession = externalId(conversationId, generation)
    const shown = await awr.run(projectRoot, ['client', 'show', '--client', 'generic', '--external-session', externalSession])
    const bound = shown?.binding
    if (!bound) {
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

async function create(awr, { projectRoot, externalSession, model, workKey, previous }) {
  let work = workKey ? { key: workKey, why: 'requested' } : undefined
  if (!work) {
    work = chooseWork(await awr.run(projectRoot, ['status']))
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
