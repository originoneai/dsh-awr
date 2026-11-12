// The /awr slash command (DSH-015): status, claim, checkpoint and end for the conversation's
// AWR session. A command runs directly against the agent and creates no model message.
//
// Every command that writes first reads the project's current revision and sends it as
// --expected-revision. A revision conflict is reported as it is; nothing is retried, because
// retrying with a fresh revision would apply a write the user has not seen the state for.
import { AwrError, explain } from './awr-runtime.js'
import { describeFork } from './fork.js'
import { buildStateView, formatStateView } from './state-view.js'
import { panelText } from './panel-text.js'
import { formatRun } from './takeover-host.js'

const USAGE = [
  '/awr                          show the project status',
  '/awr status                   the same',
  '/awr claim [WORK]             claim WORK (default: the work this conversation is bound to)',
  '/awr checkpoint DIGEST :: NEXT   save a checkpoint with a progress digest and the next action',
  '/awr end [ended|interrupted|incomplete]   end this conversation\'s AWR session (default: ended)',
  '/awr evidence [dismiss]       finished test runs and commits seen in this conversation that could be registered as evidence (suggestions only), or clear them',
  '/awr state [--json]           the work this conversation is bound to, its claims and their expiry, blockers and the project\'s counts',
  '/awr takeover                 take this project over for AWR in the background (organizes its goals and work)',
  '/awr takeover status [--json] the state and receipt of that takeover',
].join('\n')

const OUTCOMES = new Set(['ended', 'interrupted', 'incomplete'])
const ok = (text) => ({ kind: 'success', text })
const fail = (text) => ({ kind: 'error', text })

/** Plain text for `awr status`. `contextLine` says what AWR context the prompt carries (DSH-014). */
export function formatStatus(status, binding, contextLine) {
  const lines = [`Project ${status.project_id ?? '(unknown)'}, revision ${status.project_revision}`]
  const counts = ['current', 'ready', 'blocked'].map((key) => `${(status[key] ?? []).length} ${key === 'current' ? 'in progress' : key}`)
  lines.push(counts.join(', '))
  const current = (status.current ?? [])[0]
  if (current) lines.push(`In progress: ${current.key}${current.next_action ? `, next: ${current.next_action}` : ''}`)
  else if (typeof status.next_action === 'string') lines.push(`Next: ${status.next_action}`)
  if (binding?.sessionId) lines.push(`This conversation is bound to AWR session ${binding.sessionId}${binding.work ? ` (work ${binding.work.key})` : ''}`)
  else lines.push('This conversation is not bound to an AWR session.')
  const fork = describeFork(binding?.fork)
  if (fork) lines.push(fork)
  if (contextLine) lines.push(contextLine)
  return lines.join('\n')
}

/** What the user sees for an error from awr. */
function describe(error) {
  if (error instanceof AwrError) {
    if (error.details?.code === 'RevisionConflict') {
      return `The project changed while the command was being prepared (${error.details.awrMessage}). Nothing was written; look at /awr status and run the command again.`
    }
    return explain(error)
  }
  return `AWR command failed: ${error?.message ?? error}`
}

/** `/awr takeover` starts the takeover of the conversation's project; `/awr takeover status [--json]` reports it. */
async function takeoverCommand(takeover, agent, rest) {
  if (!takeover) return fail('The takeover is not available in this DeepSeek Harness profile.')
  try {
    if (rest[0] === 'status') {
      const view = await takeover.status(agent)
      return ok(rest.includes('--json') ? JSON.stringify(view) : formatRun(view))
    }
    if (rest.length > 0) return fail(`Unknown takeover option "${rest[0]}".\n${USAGE}`)
    const started = await takeover.start(agent)
    return started.started ? ok(started.message) : fail(started.message)
  } catch (error) {
    return fail(`The takeover could not be started: ${error?.message ?? error}`)
  }
}

/**
 * `/awr panel [zh|en]`, the panel's own query (not listed in the usage: nobody types it). The answer is a sentence a
 * person can read and, after it, the data the panel draws from in a comment (lib/panel-text.js). The conversation
 * shows a row for every command, so this is what keeps the panel's questions from showing as JSON there.
 */
async function panelCommand({ takeover, awr, bindings, agent, language }) {
  try {
    const view = takeover ? await takeover.status(agent) : { projectRoot: null, state: 'unavailable', steps: [], stop: null, receipt: null }
    let work
    if (view.state === 'initialized' || view.state === 'completed') {
      const conversationId = agent?.session?.id
      const binding = conversationId ? await bindings.get(conversationId) : undefined
      if (binding?.projectRoot) work = await buildStateView(awr, binding).catch(() => undefined)
    }
    return ok(panelText(view, work, language === 'zh' ? 'zh' : 'en'))
  } catch (error) {
    return fail(`AWR panel: ${error?.message ?? error}`)
  }
}

/** `/awr evidence [dismiss]`: the finished test runs and commits the plugin suggests as evidence (DSH-050). Reads no AWR state. */
function evidenceCommand(evidence, agent, rest) {
  if (!evidence) return fail('Evidence suggestions are turned off in this DeepSeek Harness profile (DSH_AWR_EVIDENCE_SUGGESTIONS=0).')
  const conversationId = agent?.session?.id
  if (typeof conversationId !== 'string') return fail('This command needs a conversation.')
  if (rest.length === 0) return ok(evidence.describe(conversationId))
  if (rest.length === 1 && rest[0] === 'dismiss') {
    const count = evidence.dismiss(conversationId)
    return ok(count > 0 ? `Dismissed ${count} evidence candidate(s). Nothing was registered.` : 'There were no evidence candidates to dismiss.')
  }
  return fail(`Unknown evidence option "${rest.join(' ')}".\n${USAGE}`)
}

/**
 * Build the handler for `ctx.commands.register({ name: 'awr', handler })`.
 *
 * @param {{ awr: { run: Function }, bindings: { get(conversationId: string): Promise<object> | undefined }, context?: { describe(conversationId: string): string } }} dependencies
 * @returns {(call: { agent: any, rawInput?: string }) => Promise<{ kind: 'success' | 'error', text: string }>}
 */
export function createAwrCommand({ awr, bindings, context, takeover, evidence }) {
  return async ({ agent, rawInput = '' }) => {
    const [subcommand = 'status', ...rest] = rawInput.trim().split(/\s+/).filter(Boolean)
    const argument = rawInput.trim().slice(subcommand.length).trim()
    if (subcommand === 'help' || subcommand === '--help') return ok(USAGE)
    if (!['status', 'state', 'claim', 'checkpoint', 'end', 'evidence', 'takeover', 'panel'].includes(subcommand)) {
      return fail(`Unknown subcommand "${subcommand}".\n${USAGE}`)
    }
    if (subcommand === 'takeover') return takeoverCommand(takeover, agent, rest)
    if (subcommand === 'panel') return panelCommand({ takeover, awr, bindings, agent, language: rest[0] })
    if (subcommand === 'evidence') return evidenceCommand(evidence, agent, rest)
    const conversationId = agent?.session?.id
    const binding = conversationId ? await bindings.get(conversationId) : undefined
    if (!binding?.projectRoot) {
      return fail('This conversation is not inside an AWR project, so there is nothing for /awr to work on.')
    }
    const { projectRoot } = binding
    try {
      if (subcommand === 'state') {
        const view = await buildStateView(awr, binding)
        return ok(rest.includes('--json') ? JSON.stringify(view) : formatStateView(view))
      }
      const status = await awr.run(projectRoot, ['status'])
      if (subcommand === 'status') return ok(formatStatus(status, binding, context?.describe(conversationId)))
      if (!binding.sessionId) {
        return fail(`This conversation has no AWR session${binding.message ? `: ${binding.message}` : binding.reason ? `: ${binding.reason}` : ''}.`)
      }
      const revision = String(status.project_revision)

      if (subcommand === 'claim') {
        const work = rest[0] ?? binding.work?.key
        if (!work) return fail('Name the work to claim: /awr claim WORK')
        const result = await awr.run(projectRoot, ['work', 'claim', work, '--session', binding.sessionId, '--expected-revision', revision])
        return ok(`Claimed ${work} for AWR session ${binding.sessionId} (project revision ${result?.project_revision ?? 'unknown'}).`)
      }

      if (subcommand === 'checkpoint') {
        const [digest, next] = argument.split('::').map((part) => part.trim())
        if (!digest || !next) return fail('A checkpoint needs a progress digest and the next action: /awr checkpoint DIGEST :: NEXT')
        // The session knows its work, so a resumed conversation (whose binding carries no work key) can checkpoint too.
        const compiled = await awr.run(projectRoot, ['context', 'compile', '--session', binding.sessionId, '--budget', '5000'])
        const hash = compiled?.work_context?.context_hash
        if (!hash) return fail('awr returned no context hash for this work, so no checkpoint was saved.')
        const saved = await awr.run(projectRoot, ['session', 'checkpoint', '--session', binding.sessionId, '--context-hash', hash, '--digest', digest, '--next-action', next, '--expected-revision', String((await awr.run(projectRoot, ['status'])).project_revision)])
        return ok(`Checkpoint saved for AWR session ${binding.sessionId}${saved?.checkpoint?.id ? ` (${saved.checkpoint.id})` : ''}.`)
      }

      // end
      const outcome = rest[0] ?? 'ended'
      if (!OUTCOMES.has(outcome)) return fail(`The outcome must be one of ${[...OUTCOMES].join(', ')}.`)
      await awr.run(projectRoot, ['session', 'end', '--session', binding.sessionId, '--outcome', outcome, '--expected-revision', revision])
      return ok(`Ended AWR session ${binding.sessionId} as ${outcome}. Work is not completed by ending a session.`)
    } catch (error) {
      return fail(describe(error))
    }
  }
}

export { USAGE as commandUsage }
