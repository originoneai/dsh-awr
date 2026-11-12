// DeepSeek Harness plugin that connects a conversation to AWR (Agent Work Runtime).
//
// Capabilities are added one work item at a time, using the surfaces recorded in
// docs/dsh-surfaces.md. Loaded so far: binding each conversation to an AWR session (DSH-013).
import { createAwr } from './lib/awr-runtime.js'
import { watchConversations } from './lib/conversation.js'

export const name = 'dsh-awr'

/**
 * Host plugin entry. Resources are registered here through `ctx` so they are removed
 * when the plugin unloads.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // `ctx.logger` is documented for plugins; tolerate a profile that does not provide it.
  ctx.logger?.info?.('dsh-awr loaded')
  watchConversations(ctx, { awr: createAwr() })
}
