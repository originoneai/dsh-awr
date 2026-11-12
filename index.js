// DeepSeek Harness plugin that connects a conversation to AWR (Agent Work Runtime).
//
// Capabilities are added one work item at a time, using the surfaces recorded in
// docs/dsh-surfaces.md. Loaded so far: binding each conversation to an AWR session (DSH-013), the /awr
// command (DSH-015) and the AWR work context in the prompt (DSH-014).
import { appendFileSync } from 'node:fs'
import { createAwr } from './lib/awr-runtime.js'
import { registerAwrCommand, watchConversations } from './lib/conversation.js'
import { registerPromptContext } from './lib/prompt-context.js'

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
  // Setting DSH_AWR_TRACE to a file path appends one JSON line per listener event, which is how
  // to see what a host passed to the plugin. Off by default.
  const file = process.env.DSH_AWR_TRACE
  const trace = file
    ? (entry) => {
        try {
          appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
        } catch {
          // tracing must never affect the conversation
        }
      }
    : undefined
  trace?.({ event: 'apply' })
  const awr = createAwr()
  const bindings = watchConversations(ctx, { awr, trace })
  // DSH_AWR_CONTEXT_BUDGET: the token budget for the AWR context compiled into the prompt (default 5000).
  const budget = Number.parseInt(process.env.DSH_AWR_CONTEXT_BUDGET ?? '', 10)
  const context = registerPromptContext(ctx, { awr, bindings, trace, ...(budget > 0 ? { budget } : {}) })
  registerAwrCommand(ctx, { awr, bindings, context })
}
