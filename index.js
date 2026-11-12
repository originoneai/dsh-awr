// DeepSeek Harness plugin that connects a conversation to AWR (Agent Work Runtime).
//
// Capabilities are added one work item at a time, using the surfaces recorded in
// docs/dsh-surfaces.md. Loaded so far: binding each conversation to an AWR session (DSH-013), the /awr
// command (DSH-015), the AWR work context in the prompt (DSH-014), the AWR tools for the model (DSH-012) and
// the one-click takeover (DSH-021, with the header button in client.js) and the skill that teaches the AWR
// workflow (DSH-032), the end-of-turn checkpoint request (DSH-030), the report of native compactions (DSH-031), forks bound to
// their parent's session (DSH-016) and the evidence candidates (DSH-050).
import { appendFileSync } from 'node:fs'
import { createAwr } from './lib/awr-runtime.js'
import { registerCheckpointPrompts } from './lib/checkpoint-prompt.js'
import { registerCompactionReports } from './lib/compaction.js'
import { registerAwrCommand, watchConversations } from './lib/conversation.js'
import { registerEvidenceSuggestions } from './lib/evidence-candidates.js'
import { createPanelPublisher, refreshAfterAgent } from './lib/panel-snapshot.js'
import { createPluginUpdater } from './lib/plugin-update.js'
import { createProgress } from './lib/progress.js'
import { registerPromptContext } from './lib/prompt-context.js'
import { createReviewerPolicy, createTakeoverController } from './lib/takeover-host.js'
import { registerAwrSkill } from './lib/skill.js'
import { registerAwrTools } from './lib/tools.js'

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
  // The one-click takeover (DSH-021): started by `/awr takeover` or the header button, reviewed by a subagent
  // that can only read inside the project.
  const policy = createReviewerPolicy()
  const takeover = createTakeoverController({
    awr,
    policy,
    getSubagents: () => ctx.get?.('subagents'),
    rebind: (agent) => bindings.rebind(agent),
    trace,
    warn: (message) => ctx.logger?.warn?.(message),
  })
  ctx.on('agent/created', ({ agent } = {}) => {
    try {
      policy.restrict(agent)
    } catch (error) {
      // A reviewer that could not be restricted must not run unrestricted: refuse its first step.
      ctx.logger?.warn?.(`The takeover reviewer could not be restricted: ${error?.message ?? error}`)
      throw error
    }
  })
  const guardMount = (scope) => {
    const register = () => scope.tools.guard(policy.guard)
    return typeof scope.effect === 'function' ? scope.effect(register) : register()
  }
  if (typeof ctx.inject === 'function') ctx.inject(['tools'], guardMount)
  else if (ctx.tools?.guard) guardMount(ctx)
  // DSH_AWR_EVIDENCE_SUGGESTIONS=0 turns off the list of finished test runs and commits offered as evidence
  // candidates (DSH-050). The list only suggests; nothing is registered by the plugin.
  const evidence = registerEvidenceSuggestions(ctx, { bindings, enabled: process.env.DSH_AWR_EVIDENCE_SUGGESTIONS !== '0', trace })
  // The panel reads its data from a file the host writes (lib/panel-snapshot.js), so asking for it adds nothing to the conversation.
  const updater = createPluginUpdater()
  const progress = createProgress({ awr, takeover })
  // A takeover that finishes changes what the progress page shows, so its data is written again (if the page was opened).
  const panel = createPanelPublisher({ takeover, awr, bindings, updater, warn: (message) => ctx.logger?.warn?.(message), onSettled: (agent) => { progress.publish(agent, { onlyIfWatched: true }).catch(() => {}) } })
  registerAwrCommand(ctx, { awr, bindings, context, takeover, evidence, panel, updater, progress })
  // When the agent itself changes the work through the awr tool, the light and the progress page follow.
  registerAwrTools(ctx, { awr, bindings, onRun: refreshAfterAgent({ panel, progress }) })
  registerAwrSkill(ctx)
  // DSH_AWR_CHECKPOINT_PROMPTS=0 turns the end-of-turn checkpoint request off; _MIN_TOOLS (default 3) and
  // _COOLDOWN_MS (default 300000) tune when a turn is worth one.
  const number = (name) => {
    const value = Number.parseInt(process.env[name] ?? '', 10)
    return Number.isFinite(value) && value >= 0 ? value : undefined
  }
  registerCompactionReports(ctx, { awr, bindings, trace })
  registerCheckpointPrompts(ctx, { bindings, enabled: process.env.DSH_AWR_CHECKPOINT_PROMPTS !== '0', minTools: number('DSH_AWR_CHECKPOINT_MIN_TOOLS'), cooldownMs: number('DSH_AWR_CHECKPOINT_COOLDOWN_MS'), trace })
}
