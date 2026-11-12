// Asks the model for an AWR checkpoint at the end of a meaningful turn (DSH-030).
//
// DSH has no hook before a compaction, so work is checkpointed ahead of it, at turn boundaries. `agent/turn-stopping`
// is serial and awaited before a turn closes; a listener that wants more work done calls `agent.steer(message)` and
// the loop runs another step. That is all this does: it adds one user message that asks the model to save a
// checkpoint with the `awr` tool. The digest, the next action and the open loops are the model's, written from the
// conversation; nothing is generated here, awr is not run here, and nothing here ends a session or completes work.
//
// A turn is meaningful when it changed or ran something (a write, an edit, a shell command) or made at least
// `minTools` tool calls other than awr's own. It is not asked about when the model already saved a checkpoint during
// the turn or within `cooldownMs`, when the turn was already asked (the checkpoint step is part of the same turn),
// or when the conversation is not bound to an AWR session.
import { randomUUID } from 'node:crypto'

export const MUTATING_TOOLS = new Set(['write', 'edit', 'bash', 'apply_patch'])
export const AWR_TOOLS = new Set(['awr', 'awr_project_status'])
export const DEFAULT_MIN_TOOLS = 3
export const DEFAULT_COOLDOWN_MS = 5 * 60_000
export const SOURCE_KIND = 'dsh-awr'

/** The words of the request. Only instructions: no checkpoint content is written for the model. */
export function checkpointRequest({ sessionId }) {
  return [
    'AWR checkpoint request.',
    `This turn did real work and this conversation's AWR session is ${sessionId}. Before you stop, save a checkpoint with the awr tool:`,
    `1. \`context compile --session ${sessionId} --budget 5000\` and keep its work_context.context_hash and project_revision.`,
    `2. \`session checkpoint --session ${sessionId} --context-hash <that hash> --digest "<what was done>" --next-action "<what comes next>" --open-loop "<anything unfinished>" --expected-project-revision <that revision>\` (one --open-loop per item; none if nothing is open).`,
    'Write the digest, the next action and the open loops yourself, from what happened in this conversation: concrete and true, with no pass, review or acceptance that did not happen. If a revision conflict comes back, read `status` again and retry once. Do not complete or end anything. Then stop; do not summarize this request to the user.',
  ].join('\n')
}

/** A user message in the shape DSH's `createUserMessage` makes (that function is internal to DSH). */
export function requestMessage(text) {
  return Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: SOURCE_KIND } })
}

/**
 * @param {{ bindings: { get(conversationId: string): Promise<object> | undefined } }} dependencies
 * @param {{ minTools?: number, cooldownMs?: number, now?: () => number, trace?: Function, warn?: Function }} [options]
 */
export function createCheckpointPrompter({ bindings }, { minTools = DEFAULT_MIN_TOOLS, cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now, trace, warn } = {}) {
  /** @type {Map<string, { tools: number, mutating: boolean, checkpointed: boolean, lastCheckpointAt: number, askedTurn: number }>} */
  const states = new Map()
  const stateOf = (id) => {
    if (!states.has(id)) states.set(id, { tools: 0, mutating: false, checkpointed: false, lastCheckpointAt: 0, askedTurn: -1 })
    return states.get(id)
  }

  return {
    /** `tools/result`: what the turn has done so far. Never throws. */
    observe(exec, result) {
      try {
        const id = exec?.agent?.session?.id
        if (typeof id !== 'string') return
        const state = stateOf(id)
        if (AWR_TOOLS.has(exec.name)) {
          const args = exec.arguments?.args
          if (exec.name === 'awr' && Array.isArray(args) && args[0] === 'session' && args[1] === 'checkpoint' && result?.isError !== true) {
            state.checkpointed = true
            state.lastCheckpointAt = now()
          }
          return
        }
        state.tools += 1
        if (MUTATING_TOOLS.has(exec.name)) state.mutating = true
      } catch {
        // observing must never affect a turn
      }
    },

    /**
     * `agent/turn-stopping`: ask for a checkpoint, or not. Never throws, because a throw here would end the turn badly.
     * Returns what it did, for the trace: `asked`, or the reason it did not.
     */
    async stopping({ agent, turn } = {}) {
      try {
        const id = agent?.session?.id
        if (typeof id !== 'string') return 'no_agent'
        const state = stateOf(id)
        const meaningful = state.mutating || state.tools >= minTools
        const checkpointed = state.checkpointed
        const sameTurn = state.askedTurn === turn
        const recent = state.lastCheckpointAt > 0 && now() - state.lastCheckpointAt < cooldownMs
        // The counters belong to one turn. The checkpoint step of an asked turn is part of that turn, so its
        // second stop is the end of the turn: the counters start again after it.
        state.tools = 0
        state.mutating = false
        state.checkpointed = false
        if (sameTurn) return 'already_asked'
        if (!meaningful) return 'not_meaningful'
        if (checkpointed) return 'checkpointed_in_turn'
        if (recent) return 'checkpointed_recently'
        const binding = await bindings.get(id)
        if (!binding?.sessionId || binding.outcome === 'failed') return 'not_bound'
        if (typeof agent.steer !== 'function') return 'cannot_steer'
        state.askedTurn = turn
        agent.steer(requestMessage(checkpointRequest({ sessionId: binding.sessionId })))
        trace?.({ event: 'checkpoint-requested', conversationId: id, turn, sessionId: binding.sessionId })
        return 'asked'
      } catch (error) {
        warn?.(`The AWR checkpoint request was skipped: ${error?.message ?? error}`)
        return 'error'
      }
    },

    forget: (id) => states.delete(id),
  }
}

/**
 * Listen to `tools/result` and `agent/turn-stopping`.
 *
 * @param {{ on: Function, logger?: any }} ctx
 * @param {{ bindings: object, enabled?: boolean, minTools?: number, cooldownMs?: number, trace?: Function }} dependencies
 */
export function registerCheckpointPrompts(ctx, { bindings, enabled = true, minTools, cooldownMs, trace }) {
  if (!enabled) return undefined
  const warn = (message) => ctx.logger?.warn?.(message)
  const prompter = createCheckpointPrompter({ bindings }, { minTools, cooldownMs, trace, warn })
  ctx.on('tools/result', (exec, result) => prompter.observe(exec, result))
  // A conversation going away only drops what is remembered about it. It does not touch the AWR session: nothing in
  // this plugin ends a session or completes work except what the user or the model asks for.
  ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.session?.id ?? payload?.session?.id
    if (typeof id === 'string') prompter.forget(id)
  })
  ctx.on('agent/turn-stopping', async (payload) => {
    const outcome = await prompter.stopping(payload)
    trace?.({ event: 'checkpoint-decision', outcome, turn: payload?.turn })
  })
  return prompter
}
