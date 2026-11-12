// DeepSeek Harness plugin that connects a conversation to AWR (Agent Work Runtime).
//
// This is the skeleton (DSH-010): it loads and does nothing else. Each capability is
// added by its own work item, using the surfaces recorded in docs/dsh-surfaces.md.

export const name = 'dsh-awr'

/**
 * Host plugin entry. Resources are registered here through `ctx` so they are removed
 * when the plugin unloads; nothing is registered yet.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // `ctx.logger` is documented for plugins; tolerate a profile that does not provide it.
  ctx.logger?.info?.('dsh-awr loaded')
}
