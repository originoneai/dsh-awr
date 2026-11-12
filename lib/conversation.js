// Connects each DSH conversation to AWR when its agent is created.
import { AwrError, explain } from './awr-runtime.js'
import { bindConversation } from './binding.js'
import { createAwrCommand } from './commands.js'
import { findForkParent, inheritedLength } from './fork.js'
import { findProjectRoot } from './project.js'

/** A short label for the model of an agent, or undefined when it cannot be read. */
function modelLabel(agent) {
  try {
    const selection = agent?.model?.current?.()
    return selection?.model ? String(selection.model) : undefined
  } catch {
    return undefined
  }
}

/**
 * What finds the parent of a fork, for `bindConversation`'s `forkOf`: nothing for a conversation that is not a fork
 * or a host without the session query service, so those are bound as before and nothing is read for them.
 */
function forkResolver(ctx, agent, { trace, warn }) {
  const session = agent?.session
  if (!inheritedLength(session)) return undefined
  let sessionQuery
  try {
    sessionQuery = ctx.get?.('sessionQuery') ?? ctx.sessionQuery
  } catch {
    sessionQuery = undefined
  }
  if (typeof sessionQuery?.listSessions !== 'function' || typeof sessionQuery?.observeSession !== 'function') return undefined
  return async () => {
    try {
      const parent = await findForkParent(sessionQuery, session)
      trace?.({ event: 'fork-parent', conversationId: session.id, inherited: inheritedLength(session), parent: parent?.conversationId, examined: parent?.examined })
      return parent
    } catch (error) {
      warn?.(`The parent of fork ${session.id} could not be looked up: ${error?.message ?? error}`)
      trace?.({ event: 'fork-parent', conversationId: session.id, error: String(error?.message ?? error).slice(0, 200) })
      return undefined
    }
  }
}

/**
 * Listen for `agent/created` and bind the conversation to an AWR session (DSH-013).
 *
 * The listener never throws, because a throw in an `agent/created` listener fails the creation
 * of the agent. It waits for the binding so that what runs next (context injection, the /awr
 * commands) can rely on it, but for at most `waitMs`: a slow awr must not hold a conversation
 * back, so after that the binding finishes in the background and `get()` still resolves it.
 * The outcome is kept in memory per conversation; AWR itself is the durable record.
 *
 * @param {{ on: Function, logger?: any }} ctx
 * @param {{ awr: { run: Function }, waitMs?: number, trace?: (entry: object) => void }} dependencies
 * @returns {{ get(conversationId: string): Promise<object> | undefined, rebind(agent: any): Promise<object | undefined> }}
 */
export function watchConversations(ctx, { awr, waitMs = 10_000, trace }) {
  /** @type {Map<string, Promise<object>>} */
  const bindings = new Map()
  const warn = (message) => ctx.logger?.warn?.(message)

  /** What the listener saw, for diagnosing a host whose objects differ from the documented ones. */
  const shape = (value) => (value && typeof value === 'object' ? Object.keys(value).slice(0, 24) : typeof value)

  /**
   * Bind one agent's conversation, if its working directory is inside an AWR project. Waits for the binding
   * for at most `limit` ms (the binding goes on in the background after that; `get()` still resolves it).
   * Resolves to the binding if it settled in time, else `undefined`.
   */
  async function bind(agent, { limit = waitMs } = {}) {
    const conversationId = agent?.session?.id
    const cwd = agent?.session?.header?.cwd
    if (typeof conversationId !== 'string' || typeof cwd !== 'string') return undefined
    const projectRoot = await findProjectRoot(cwd)
    if (!projectRoot) return undefined
    const pending = bindConversation(awr, { projectRoot, conversationId, model: modelLabel(agent), forkOf: forkResolver(ctx, agent, { trace, warn }) })
      .then((result) => {
        trace?.({ event: 'bound', conversationId, projectRoot, ...result })
        return { projectRoot, ...result }
      })
      .catch((error) => {
        const failure = { outcome: 'failed', projectRoot, message: error instanceof AwrError ? explain(error) : `AWR binding failed: ${error?.message ?? error}` }
        warn(failure.message)
        trace?.({ event: 'failed', conversationId, ...failure })
        return failure
      })
    bindings.set(conversationId, pending)
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), limit)
      timer.unref?.()
    })
    try {
      return await Promise.race([pending, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  ctx.on('agent/created', async (payload) => {
    try {
      const { agent } = payload ?? {}
      trace?.({
        event: 'agent/created',
        payload: shape(payload),
        source: payload?.source,
        agent: shape(agent),
        session: shape(agent?.session),
        header: shape(agent?.session?.header),
        conversationId: agent?.session?.id,
        cwd: agent?.session?.header?.cwd,
      })
      await bind(agent)
    } catch (error) {
      warn(`AWR binding was skipped: ${error?.message ?? error}`)
    }
  })

  return {
    /** The binding of a conversation, once it has settled; `undefined` if it was never started. */
    get: (conversationId) => bindings.get(conversationId),
    /**
     * Bind a conversation again, for one that was opened before its project had AWR (after a takeover).
     * Resolves to the binding, or `undefined` when the project still has no AWR runtime.
     */
    rebind: (agent) => bind(agent, { limit: 0 }),
  }
}

/**
 * Register `/awr` on the human-command registry (`ctx.commands`, DSH-015). The registry is an
 * optional service: a profile without it (the headless one) loads the plugin without the
 * command, and the registration is removed again if the service goes away.
 *
 * @param {{ inject?: Function, effect?: Function, commands?: any }} ctx
 * @param {{ awr: { run: Function }, bindings: { get: Function }, context?: { describe(conversationId: string): string } }} dependencies
 */
export function registerAwrCommand(ctx, { awr, bindings, context, takeover, evidence, panel }) {
  const definition = {
    name: 'awr',
    description: 'Show the AWR project status, or claim work, save a checkpoint or end this conversation\'s AWR session',
    input: { hint: '[status | state | claim [WORK] | checkpoint DIGEST :: NEXT | end [OUTCOME] | evidence [dismiss] | takeover [status [--json]]]' },
    handler: createAwrCommand({ awr, bindings, context, takeover, evidence, panel }),
  }
  const mount = (scope) => {
    const register = () => {
      const dispose = scope.commands.register(definition)
      // The periodic writing of the panel's data ends with the command that asks for it (plugin unload).
      return typeof dispose === 'function' ? () => { panel?.stop?.(); return dispose() } : dispose
    }
    return typeof scope.effect === 'function' ? scope.effect(register) : register()
  }
  if (typeof ctx.inject === 'function') ctx.inject(['commands'], mount)
  else if (ctx.commands?.register) mount(ctx)
}
