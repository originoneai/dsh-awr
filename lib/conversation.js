// Connects each DSH conversation to AWR when its agent is created.
import { AwrError, explain } from './awr-runtime.js'
import { bindConversation } from './binding.js'
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
 * @returns {{ get(conversationId: string): Promise<object> | undefined }}
 */
export function watchConversations(ctx, { awr, waitMs = 10_000, trace }) {
  /** @type {Map<string, Promise<object>>} */
  const bindings = new Map()
  const warn = (message) => ctx.logger?.warn?.(message)

  /** What the listener saw, for diagnosing a host whose objects differ from the documented ones. */
  const shape = (value) => (value && typeof value === 'object' ? Object.keys(value).slice(0, 24) : typeof value)

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
      const conversationId = agent?.session?.id
      const cwd = agent?.session?.header?.cwd
      if (typeof conversationId !== 'string' || typeof cwd !== 'string') return
      const projectRoot = await findProjectRoot(cwd)
      if (!projectRoot) return
      const pending = bindConversation(awr, { projectRoot, conversationId, model: modelLabel(agent) })
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
      const limit = new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs)
        timer.unref?.()
      })
      await Promise.race([pending, limit])
      clearTimeout(timer)
    } catch (error) {
      warn(`AWR binding was skipped: ${error?.message ?? error}`)
    }
  })

  return {
    /** The binding of a conversation, once it has settled; `undefined` if it was never started. */
    get: (conversationId) => bindings.get(conversationId),
  }
}
