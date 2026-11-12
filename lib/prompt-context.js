// Puts the bound AWR work context into the DSH prompt (DSH-014).
//
// How DeepSeek Harness takes it (docs/dsh-surfaces.md, docs/prompt-context.md):
//   - `ctx.systemPrompt.context({ name, order, text, required })` registers a dynamic runtime
//     context. DSH reads `text` again before every model step and appends it to the conversation as
//     a snapshot message only when the rendered text differs from the snapshot it still retains.
//     After a native compaction has replaced that snapshot, the next step appends it again. That is
//     what makes the context survive compaction, with no extra code here.
//   - `text` is synchronous. An awr call cannot run inside it, so the context is compiled ahead of
//     time, in an awaited `agent/pre-step` listener, and `text` returns what was compiled last.
//
// The compiled text is cached by project revision, so an unchanged project costs one `awr status`
// per refresh and no new snapshot message. Nothing is truncated here: `awr context compile` already
// decides what fits in the budget and says what it left out, and when it refuses (`BudgetExceeded`,
// `SourceStale`, or anything else) the conversation gets a notice saying so instead of old content.
import { AwrError, explain } from './awr-runtime.js'
import { describeFork } from './fork.js'

export const CONTEXT_NAME = 'awr:work-context'
/** DSH's own runtime contexts use 100 to 210; this one follows them. */
export const CONTEXT_ORDER = 400
export const DEFAULT_BUDGET = 5000
/** Within a turn, how long a compiled context is trusted without asking awr whether the project moved. */
export const DEFAULT_RECHECK_MS = 30_000
/** The most a refresh may hold up a model step. */
export const DEFAULT_REFRESH_TIMEOUT_MS = 15_000

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

/** The prompt text for a successful compile, or for one AWR marked incomplete but whose sources are current. */
export function renderWorkContext({ projectRoot, sessionId, compiled, incomplete = false, fork }) {
  const work = compiled?.work_context ?? {}
  const identity = work.identity ?? {}
  const completeness = compiled?.completeness ?? {}
  const omitted = (work.omitted_chunks ?? []).length + (compiled?.omitted_refs ?? []).length
  const header = [
    '# AWR work context',
    `This conversation is bound to AWR (Agent Work Runtime) session ${sessionId}: project ${identity.project_key ?? projectRoot}, work ${identity.work_item_key ?? '(unknown)'}, project revision ${compiled?.project_revision ?? identity.project_revision ?? '(unknown)'}.`,
    'AWR records the project\'s work state; the text below is its compiled context for that work. When the project changes, a newer AWR work context supersedes this one. Read and update it with the awr_project_status and awr tools; never edit .awr/state.db*.',
  ]
  const notes = []
  // A fork says what it is: the parent's session may hold progress that this conversation's does not.
  const forked = describeFork(fork)
  if (forked) notes.push(forked)
  if (incomplete) {
    notes.push(`AWR marked this context INCOMPLETE (${completeness.status ?? 'CONTEXT INCOMPLETE'}). Its sources are current, but required facts are missing:`)
    for (const issue of (completeness.issues ?? []).slice(0, 8)) notes.push(`- ${issue.code}: ${oneLine(issue.reason).slice(0, 220)}`)
    notes.push('Work from it, treat what is missing as unknown, and record each gap as an open loop in a checkpoint.')
  } else if (completeness.status && completeness.status !== 'CONTEXT COMPLETE') {
    notes.push(`Context status: ${completeness.status}.`)
  }
  if (omitted > 0) notes.push(`${omitted} optional part(s) did not fit the budget and were left out; AWR still has them.`)
  return [...header, ...notes, '', String(work.rendered_context ?? '').trim()].join('\n').trimEnd()
}

/** The prompt text when AWR could not give a context. Names the cause and what AWR suggests. */
export function renderNotice({ projectRoot, sessionId, reason, suggestion }) {
  return [
    '# AWR work context unavailable',
    `This conversation is bound to AWR${sessionId ? ` session ${sessionId}` : ''} (project ${projectRoot}), but its work context could not be compiled: ${oneLine(reason)}`,
    ...(suggestion ? [`AWR suggests: ${oneLine(suggestion)}`] : []),
    'No AWR context is in this prompt until that is resolved. Do not assume what the next action or the open loops are; tell the user.',
  ].join('\n')
}

/** Reason and suggestion for an error from awr. `BudgetExceeded` and `SourceStale` keep AWR's own words. */
function describeFailure(error) {
  if (error instanceof AwrError) {
    const code = error.details?.code
    if (code === 'BudgetExceeded' || code === 'SourceStale') {
      return { reason: `${code}: ${error.details?.awrMessage ?? error.message}`, suggestion: error.details?.awrDetails?.next_action }
    }
    return { reason: code ? `${code}: ${error.details?.awrMessage ?? error.message}` : explain(error), suggestion: error.details?.awrDetails?.next_action }
  }
  return { reason: `AWR command failed: ${error?.message ?? error}` }
}

/**
 * The per-conversation cache and the refresh that fills it.
 *
 * @param {{ awr: { run: Function }, bindings: { get(id: string): Promise<object> | undefined } }} dependencies
 * @param {{ budget?: number, recheckMs?: number, now?: () => number, trace?: Function, warn?: Function }} [options]
 */
export function createPromptContext({ awr, bindings }, { budget = DEFAULT_BUDGET, recheckMs = DEFAULT_RECHECK_MS, now = Date.now, trace, warn } = {}) {
  /** @type {Map<string, { text: string, kind: 'context' | 'notice' | 'none', sessionId?: string, revision?: string, checkedAt: number, summary: string }>} */
  const cache = new Map()
  const inflight = new Map()

  const none = () => ({ text: '', kind: 'none', checkedAt: now(), summary: 'not injected (this conversation is not bound to AWR work)' })

  async function compute(conversationId, previous, force) {
    const binding = await bindings.get(conversationId)
    if (!binding?.projectRoot) return none()
    const { projectRoot, sessionId } = binding
    if (binding.outcome === 'failed') {
      const text = renderNotice({ projectRoot, reason: binding.message ?? 'binding failed' })
      return { text, kind: 'notice', checkedAt: now(), summary: `unavailable: ${oneLine(binding.message)}` }
    }
    if (!sessionId) return none()
    // Inside the recheck window nothing is asked of awr, unless the caller forces a look.
    if (!force && previous && previous.kind !== 'none' && previous.sessionId === sessionId && now() - previous.checkedAt < recheckMs) return previous
    try {
      const status = await awr.run(projectRoot, ['status'])
      const revision = String(status?.project_revision)
      if (previous?.kind === 'context' && previous.sessionId === sessionId && previous.revision === revision) {
        return { ...previous, checkedAt: now() }
      }
      const compiled = await awr.run(projectRoot, ['context', 'compile', '--session', sessionId, '--budget', String(budget)])
      const text = renderWorkContext({ projectRoot, sessionId, compiled, fork: binding.fork })
      const compiledRevision = String(compiled?.project_revision ?? revision)
      const work = compiled?.work_context?.identity?.work_item_key
      trace?.({ event: 'prompt-context', conversationId, kind: 'context', revision: compiledRevision, chars: text.length })
      return { text, kind: 'context', sessionId, revision: compiledRevision, checkedAt: now(), summary: `injected: ${work ?? 'work'} at project revision ${compiledRevision}, ${text.length} characters` }
    } catch (error) {
      // AWR answers ContextIncomplete with the context it could compile and the gaps. When its sources are
      // current that is what the model needs to go on (a project that was just taken over looks like this); when
      // they are not, the content cannot be trusted and a notice is all there is.
      const document = error instanceof AwrError && error.details?.code === 'ContextIncomplete' ? error.details.awrDocument : undefined
      if (document?.work_context?.rendered_context && document?.completeness?.source_fresh === true) {
        const text = renderWorkContext({ projectRoot, sessionId, compiled: document, incomplete: true, fork: binding.fork })
        const compiledRevision = String(document.project_revision ?? '')
        trace?.({ event: 'prompt-context', conversationId, kind: 'context', incomplete: true, revision: compiledRevision, chars: text.length })
        return { text, kind: 'context', sessionId, revision: compiledRevision, checkedAt: now(), summary: `injected, marked incomplete by AWR: ${document.work_context.identity?.work_item_key ?? 'work'} at project revision ${compiledRevision}, ${text.length} characters` }
      }
      const { reason, suggestion } = describeFailure(error)
      warn?.(`AWR context was not injected: ${reason}`)
      trace?.({ event: 'prompt-context', conversationId, kind: 'notice', reason })
      return { text: renderNotice({ projectRoot, sessionId, reason, suggestion }), kind: 'notice', sessionId, checkedAt: now(), summary: `unavailable: ${oneLine(reason)}` }
    }
  }

  return {
    /** What the prompt carries for a conversation right now. Synchronous, as DSH requires. */
    text(conversationId) {
      return cache.get(conversationId)?.text ?? ''
    },
    /** One line for `/awr status`: what is in the prompt, or why nothing is. */
    describe(conversationId) {
      const entry = cache.get(conversationId)
      return entry ? `AWR context in the prompt: ${entry.summary}` : 'AWR context in the prompt: not compiled yet (it is compiled before the next model step)'
    },
    /**
     * Bring the cache up to date. Never throws. Concurrent refreshes of one conversation share a run.
     * @param {string} conversationId
     * @param {{ force?: boolean }} [options] `force` skips the recheck window, not the revision check
     */
    refresh(conversationId, { force = false } = {}) {
      if (typeof conversationId !== 'string' || !conversationId) return Promise.resolve(undefined)
      const running = inflight.get(conversationId)
      if (running) return running
      const run = compute(conversationId, cache.get(conversationId), force)
        .then((entry) => {
          cache.set(conversationId, entry)
          return entry
        })
        .catch((error) => {
          warn?.(`AWR context refresh failed: ${error?.message ?? error}`)
          return undefined
        })
        .finally(() => inflight.delete(conversationId))
      inflight.set(conversationId, run)
      return run
    },
    forget(conversationId) {
      cache.delete(conversationId)
    },
  }
}

/** Resolves when `promise` settles or after `ms`, whichever comes first. Never rejects. */
function within(promise, ms) {
  let timer
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
  return Promise.race([promise.catch(() => undefined), limit]).finally(() => clearTimeout(timer))
}

/**
 * Register the context on `ctx.systemPrompt` and keep it fresh through `agent/pre-step`.
 *
 * The listener refreshes before the model step and always passes the step on: DSH owns the
 * decision to enter, reject or change it, and a listener that forgot `next()` would stop every
 * conversation. The refresh is bounded by `refreshTimeoutMs` and by the turn's abort signal; when
 * it runs out the step goes ahead with what was compiled before.
 *
 * @param {{ on: Function, inject?: Function, effect?: Function, systemPrompt?: any, logger?: any }} ctx
 * @param {{ awr: { run: Function }, bindings: { get: Function }, budget?: number, recheckMs?: number, refreshTimeoutMs?: number, trace?: Function }} dependencies
 */
export function registerPromptContext(ctx, { awr, bindings, budget, recheckMs, refreshTimeoutMs = DEFAULT_REFRESH_TIMEOUT_MS, trace }) {
  const warn = (message) => ctx.logger?.warn?.(message)
  const provider = createPromptContext({ awr, bindings }, { budget, recheckMs, trace, warn })

  const definition = {
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    // The compiled context may contain `{{...}}`, which DSH would otherwise try to resolve as a variable.
    interpolate: false,
    // Stays in the prompt when DSH suppresses optional runtime context.
    required: true,
    text: (call) => provider.text(call?.agent?.session?.id),
  }
  const mount = (scope) => {
    const register = () => scope.systemPrompt.context(definition)
    return typeof scope.effect === 'function' ? scope.effect(register) : register()
  }
  if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], mount)
  else if (ctx.systemPrompt?.context) mount(ctx)

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const conversationId = payload?.agent?.session?.id
      if (conversationId && !payload?.signal?.aborted) {
        // The first step of a turn always asks awr whether the project moved; later steps of the same turn
        // trust the compiled context for `recheckMs`.
        await within(provider.refresh(conversationId, { force: payload?.step === 1 }), refreshTimeoutMs)
      }
    } catch (error) {
      warn(`AWR context refresh was skipped: ${error?.message ?? error}`)
    }
    return next()
  })

  ctx.on('agent/disposed', (payload) => {
    const conversationId = payload?.agent?.session?.id ?? payload?.session?.id
    if (typeof conversationId === 'string') provider.forget(conversationId)
  })

  return provider
}
