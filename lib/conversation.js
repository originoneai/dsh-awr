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
 * of the agent, and it does not wait for AWR: binding runs in the background so the first
 * model step is not held. The outcome is kept in memory per conversation for the capabilities
 * that need the session (context injection, the /awr commands); AWR itself is the durable record.
 *
 * @param {{ on: Function, logger?: any }} ctx
 * @param {{ awr: { run: Function } }} dependencies
 * @returns {{ get(conversationId: string): Promise<object> | undefined }}
 */
export function watchConversations(ctx, { awr }) {
  /** @type {Map<string, Promise<object>>} */
  const bindings = new Map()
  const warn = (message) => ctx.logger?.warn?.(message)

  ctx.on('agent/created', async (payload) => {
    try {
      const { agent } = payload ?? {}
      const conversationId = agent?.session?.id
      const cwd = agent?.session?.header?.cwd
      if (typeof conversationId !== 'string' || typeof cwd !== 'string') return
      const projectRoot = await findProjectRoot(cwd)
      if (!projectRoot) return
      const pending = bindConversation(awr, { projectRoot, conversationId, model: modelLabel(agent) })
        .then((result) => ({ projectRoot, ...result }))
        .catch((error) => {
          const failure = { outcome: 'failed', projectRoot, message: error instanceof AwrError ? explain(error) : `AWR binding failed: ${error?.message ?? error}` }
          warn(failure.message)
          return failure
        })
      bindings.set(conversationId, pending)
    } catch (error) {
      warn(`AWR binding was skipped: ${error?.message ?? error}`)
    }
  })

  return {
    /** The binding of a conversation, once it has settled; `undefined` if it was never started. */
    get: (conversationId) => bindings.get(conversationId),
  }
}
