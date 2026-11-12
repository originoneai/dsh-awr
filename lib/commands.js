// The /awr slash command (DSH-015): status, claim, checkpoint and end for the conversation's
// AWR session. A command runs directly against the agent and creates no model message.
//
// Every command that writes first reads the project's current revision and sends it as
// --expected-revision. A revision conflict is reported as it is; nothing is retried, because
// retrying with a fresh revision would apply a write the user has not seen the state for.
import { AwrError, explain } from './awr-runtime.js'
import { bindingFor } from './binding.js'
import { describeFork } from './fork.js'
import { collectPanel } from './panel-snapshot.js'
import { panelSentence } from './panel-text.js'
import { boundWorkKey, buildStateView, formatStateView } from './state-view.js'
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
  '/awr update [check]           ask GitHub whether this plugin has a newer version',
].join('\n')

const OUTCOMES = new Set(['ended', 'interrupted', 'incomplete'])
const ok = (text) => ({ kind: 'success', text })
const fail = (text) => ({ kind: 'error', text })

/**
 * What a command says. The first line is for a person: what happened, in plain words, in the language of the interface
 * (`--ui zh` or `--ui en`, which the panel adds; English otherwise). The lines after it are the technical details
 * (identifiers, revisions), which the conversation folds away until someone opens them.
 */
const compose = (first, ...details) => [first, ...details.filter(Boolean)].join('\n')
const say = (ui, en, zh) => (ui?.language === 'zh' ? zh : en)
const UI_FLAG = /(?:^|\s)--ui(?:\s+(zh|en))?(?=\s|$)/

/** The `--ui` flag of a command line, and the line without it. */
export function splitUi(rawInput) {
  const found = UI_FLAG.exec(rawInput)
  if (!found) return { rawInput, ui: { language: 'en', fromPanel: false } }
  return { rawInput: rawInput.replace(UI_FLAG, ' ').replace(/\s+/g, ' ').trim(), ui: { language: found[1] ?? 'en', fromPanel: true } }
}

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

/** The gaps of a context AWR marked incomplete, each as the text of an open loop (at most 20, 300 characters each). */
function gapLoops(completeness) {
  const loops = [...(completeness?.issues ?? []), ...(completeness?.evidence_gaps ?? [])]
    .map((gap) => `${gap.code ?? 'gap'}: ${String(gap.reason ?? '').replace(/\s+/g, ' ').trim()}`.slice(0, 300))
  return [...new Set(loops)].slice(0, 20)
}

/**
 * The context hash a checkpoint needs, and the open loops it must carry. AWR answers a context it could compile but
 * calls incomplete (a project that was just taken over looks like this) with ContextIncomplete, and says in the same
 * answer that an incomplete checkpoint is allowed: it is saved with each gap as an open loop. That is done only when AWR
 * says so and its sources are current; any other refusal is passed on.
 */
async function contextForCheckpoint(awr, projectRoot, sessionId) {
  try {
    const compiled = await awr.run(projectRoot, ['context', 'compile', '--session', sessionId, '--budget', '5000'])
    return { hash: compiled?.work_context?.context_hash, loops: [] }
  } catch (error) {
    const document = error instanceof AwrError && error.details?.code === 'ContextIncomplete' ? error.details.awrDocument : undefined
    const allowed = (document?.error?.details ?? error?.details?.awrDetails)?.incomplete_checkpoint_allowed === true
    if (document?.work_context?.context_hash && allowed && document.completeness?.source_fresh === true) {
      return { hash: document.work_context.context_hash, loops: gapLoops(document.completeness) }
    }
    throw error
  }
}

/** `/awr takeover` starts the takeover of the conversation's project; `/awr takeover status [--json]` reports it. */
async function takeoverCommand(takeover, agent, rest, ui) {
  if (!takeover) return fail(say(ui, 'The takeover is not available in this DeepSeek Harness profile.', '这个 DeepSeek Harness 配置里没有接管功能。'))
  try {
    if (rest[0] === 'status') {
      const view = await takeover.status(agent)
      return ok(rest.includes('--json') ? JSON.stringify(view) : formatRun(view))
    }
    if (rest.length > 0) return fail(`Unknown takeover option "${rest[0]}".\n${USAGE}`)
    const started = await takeover.start(agent)
    if (started.started) {
      return ok(compose(say(ui, 'Started taking the project over. It runs in the background; you can keep working.', '已开始接管这个项目。AWR 在后台整理目标和待办，你可以继续工作。'), started.message))
    }
    const first = {
      running: say(ui, 'The takeover is already running.', '接管正在进行中。'),
      already_initialized: say(ui, 'AWR already manages this project.', '这个项目已经由 AWR 管理了。'),
      too_broad: say(ui, 'This folder is too broad to take over as one project.', '这个目录范围太大，不适合整体接管。'),
    }[started.reason] ?? say(ui, 'The takeover could not be started.', '无法开始接管。')
    return fail(compose(first, started.message))
  } catch (error) {
    return fail(compose(say(ui, 'The takeover could not be started.', '无法开始接管。'), error?.message ?? String(error)))
  }
}

/**
 * `/awr panel [zh|en]`, the panel's own query (not listed in the usage: nobody types it). It writes the data the panel
 * draws from into its file (lib/panel-snapshot.js) and answers with one sentence a person can read, which is all the
 * conversation shows for it.
 */
async function panelCommand({ takeover, awr, bindings, panel, agent, language }) {
  try {
    const { view, work } = panel ? await panel.publish(agent) : await collectPanel({ takeover, awr, bindings, agent })
    return ok(panelSentence(view, work, language === 'zh' ? 'zh' : 'en'))
  } catch (error) {
    return fail(`AWR panel: ${error?.message ?? error}`)
  }
}

const short = (sha) => String(sha ?? '').slice(0, 7)

/** `/awr update [check]`: asks GitHub for the newest commit of the branch the plugin follows and says so in one sentence. */
async function updateCommand(updater, rest, ui) {
  if (!updater) return fail(say(ui, 'The plugin cannot check for updates in this DeepSeek Harness profile.', '这个配置下插件无法检查更新。'))
  if (rest.length > 0 && !(rest.length === 1 && rest[0] === 'check')) return fail(`Unknown update option "${rest.join(' ')}".\n${USAGE}`)
  try {
    const answer = await updater.check()
    if (answer.kind === 'checkout') return ok(say(ui, 'This plugin runs from a local folder, so it is updated with git, not from here.', '这个插件运行在本地文件夹里，请用 git 更新，不能在这里更新。'))
    if (answer.kind !== 'github') return ok(say(ui, 'This plugin was not installed from GitHub, so it cannot update itself; update it where it was installed from.', '这个插件不是从 GitHub 安装的，无法自己更新；请到安装它的地方更新。'))
    const { check, installed, repo } = answer
    const where = `${repo.owner}/${repo.repo}`
    const details = `${where} · ${installed ? `installed ${short(installed)}, ` : ''}newest ${short(check.latest)} (${check.ref})`
    if (!check.available) return ok(compose(say(ui, 'The plugin is up to date.', '插件已是最新版本。'), details))
    return ok(compose(say(ui, 'A newer version of the plugin is available on GitHub. Press Update to install it.', 'GitHub 上有新版本的插件，点「更新」即可安装。'), details))
  } catch (error) {
    return fail(compose(say(ui, 'Could not check for updates.', '无法检查更新。'), error?.message ?? String(error)))
  }
}

/** `/awr progress [refresh]`: writes the data of the progress page (lib/progress.js) and says in one sentence how the project stands. */
async function progressCommand(progress, agent, rest, ui) {
  if (!progress) return fail(say(ui, 'The progress page is not available in this DeepSeek Harness profile.', '这个配置下没有项目进展页。'))
  try {
    const view = await progress.publish(agent, { refresh: rest[0] === 'refresh' })
    if (!view.ok) {
      const reason = {
        not_managed: say(ui, 'AWR does not manage this project yet.', 'AWR 还没有接管这个项目。'),
        unsupported: say(ui, 'The installed awr is too old for the progress page.', '已安装的 awr 版本太旧，不支持项目进展页。'),
        no_graph: say(ui, 'AWR returned no work to draw.', 'AWR 没有返回可以绘制的工作。'),
      }[view.reason] ?? say(ui, 'The progress could not be read.', '读取不到项目进展。')
      return ok(compose(reason, view.message))
    }
    const { counts } = view
    return ok(compose(say(ui, `Progress updated: ${counts.total} work items, ${counts.active} in progress, ${counts.blocked} blocked.`, `项目进展已更新：${counts.total} 项工作，${counts.active} 项进行中，${counts.blocked} 项受阻。`)))
  } catch (error) {
    return fail(compose(say(ui, 'The progress could not be read.', '读取不到项目进展。'), error?.message ?? String(error)))
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
export function createAwrCommand({ awr, bindings, context, takeover, evidence, panel, updater, progress }) {
  const handle = async ({ agent, rawInput = '' }, ui) => {
    const [subcommand = 'status', ...rest] = rawInput.trim().split(/\s+/).filter(Boolean)
    const argument = rawInput.trim().slice(subcommand.length).trim()
    if (subcommand === 'help' || subcommand === '--help') return ok(USAGE)
    if (!['status', 'state', 'claim', 'checkpoint', 'end', 'evidence', 'takeover', 'panel', 'update', 'progress'].includes(subcommand)) {
      return fail(`Unknown subcommand "${subcommand}".\n${USAGE}`)
    }
    if (subcommand === 'takeover') return takeoverCommand(takeover, agent, rest, ui)
    if (subcommand === 'panel') return panelCommand({ takeover, awr, bindings, panel, agent, language: rest[0] ?? ui.language })
    if (subcommand === 'evidence') return evidenceCommand(evidence, agent, rest)
    if (subcommand === 'update') return updateCommand(updater, rest, ui)
    if (subcommand === 'progress') return progressCommand(progress, agent, rest, ui)
    const conversationId = agent?.session?.id
    const binding = conversationId ? await bindingFor(bindings, agent) : undefined
    if (!binding?.projectRoot) {
      return fail(compose(say(ui, 'AWR does not manage this project, so there is nothing to do here.', '这个项目不在 AWR 管理之下，这里没有可做的事。'), 'This conversation is not inside an AWR project, so there is nothing for /awr to work on.'))
    }
    const { projectRoot } = binding
    try {
      if (subcommand === 'state') {
        const view = await buildStateView(awr, binding)
        return ok(rest.includes('--json') ? JSON.stringify(view) : formatStateView(view))
      }
      const status = await awr.run(projectRoot, ['status'])
      if (subcommand === 'status') {
        // The queues hold a sample of the work; the totals say how much there is.
        const counts = [['current', 'current_total'], ['ready', 'ready_count'], ['blocked', 'blocked_count']].map(([key, total]) => (Number.isInteger(status[total]) ? status[total] : (status[key] ?? []).length))
        return ok(compose(say(ui, `${counts[0]} in progress, ${counts[1]} ready, ${counts[2]} blocked`, `${counts[0]} 项进行中，${counts[1]} 项可开始，${counts[2]} 项受阻`), formatStatus(status, binding, context?.describe(conversationId))))
      }
      if (!binding.sessionId) {
        return fail(compose(say(ui, 'This conversation has no AWR work record yet.', '这个会话还没有 AWR 工作记录。'), `This conversation has no AWR session${binding.message ? `: ${binding.message}` : binding.reason ? `: ${binding.reason}` : ''}.`))
      }
      const revision = String(status.project_revision)

      if (subcommand === 'claim') {
        // The session knows its work, so a conversation whose binding names none (a takeover made it) can claim it too.
        const work = rest[0] ?? await boundWorkKey(awr, binding)
        if (!work) return fail(compose(say(ui, 'This conversation has no work to claim.', '这个会话没有可认领的工作。'), 'This conversation\'s AWR session has no work to claim. Name the work: /awr claim WORK'))
        const result = await awr.run(projectRoot, ['work', 'claim', work, '--session', binding.sessionId, '--expected-revision', revision])
        const title = (await awr.run(projectRoot, ['work', 'show', work]).catch(() => undefined))?.work?.title
        return ok(compose(
          title ? say(ui, `Claimed “${title}” for this conversation.`, `已认领「${title}」，这个会话开始负责这项工作。`) : say(ui, 'Claimed the work for this conversation.', '已认领这项工作，这个会话开始负责它。'),
          `Claimed ${work} for AWR session ${binding.sessionId} (project revision ${result?.project_revision ?? 'unknown'}).`,
        ))
      }

      if (subcommand === 'checkpoint') {
        const [digest, next] = argument.split('::').map((part) => part.trim())
        if (!digest || !next) return fail(compose(say(ui, 'A progress note needs what was done and what comes next.', '进度记录需要写明做了什么、接下来做什么。'), 'A checkpoint needs a progress digest and the next action: /awr checkpoint DIGEST :: NEXT'))
        // The session knows its work, so a resumed conversation (whose binding carries no work key) can checkpoint too.
        const { hash, loops } = await contextForCheckpoint(awr, projectRoot, binding.sessionId)
        if (!hash) return fail(compose(say(ui, 'The progress note was not saved.', '没有保存进度记录。'), 'awr returned no context hash for this work, so no checkpoint was saved.'))
        const saved = await awr.run(projectRoot, ['session', 'checkpoint', '--session', binding.sessionId, '--context-hash', hash, '--digest', digest, '--next-action', next, ...loops.flatMap((loop) => ['--open-loop', loop]), '--expected-revision', String((await awr.run(projectRoot, ['status'])).project_revision)])
        return ok(compose(
          loops.length ? say(ui, 'Saved a progress note. Some information about the work is still missing; that was noted too.', '已保存进度记录。这项工作还有些信息没补全，也一并记下了。') : say(ui, 'Saved a progress note for this conversation.', '已保存这个会话的进度记录。'),
          `Checkpoint saved for AWR session ${binding.sessionId}${saved?.checkpoint?.id ? ` (${saved.checkpoint.id})` : ''}${loops.length ? `, marked incomplete: the context of the work has ${loops.length} gap(s), kept as open loops` : ''}.`,
        ))
      }

      // end
      const outcome = rest[0] ?? 'ended'
      if (!OUTCOMES.has(outcome)) return fail(`The outcome must be one of ${[...OUTCOMES].join(', ')}.`)
      await awr.run(projectRoot, ['session', 'end', '--session', binding.sessionId, '--outcome', outcome, '--expected-revision', revision])
      return ok(compose(
        say(ui, 'Ended this conversation\'s work record. The work itself is not marked complete.', '已结束这个会话的工作记录；工作本身不会因此算作完成。'),
        `Ended AWR session ${binding.sessionId} as ${outcome}. Work is not completed by ending a session.`,
      ))
    } catch (error) {
      return fail(compose(say(ui, 'AWR could not do that.', 'AWR 没能完成这个操作。'), describe(error)))
    }
  }

  // A command that changes what the panel shows (a claim, a checkpoint, the end of a session, the start of a takeover)
  // writes the panel's data again before it answers, so the panel reads the new state without asking the host anything.
  // Failing to write it never changes the answer; the panel's Refresh asks the host to write it.
  const CHANGES = new Set(['claim', 'checkpoint', 'end', 'takeover', 'update'])
  return async (call) => {
    const { rawInput, ui } = splitUi(String(call?.rawInput ?? ''))
    const result = await handle({ ...call, rawInput }, ui)
    const [subcommand, second] = rawInput.trim().split(/\s+/)
    if (panel && CHANGES.has(subcommand) && !(subcommand === 'takeover' && second === 'status')) {
      await panel.publish(call.agent).catch(() => {})
    }
    // The progress page shows the work, so it is written again too, but only for a page that was opened.
    if (progress && ['claim', 'checkpoint', 'end', 'takeover'].includes(subcommand) && !(subcommand === 'takeover' && second === 'status')) {
      await progress.publish(call.agent, { onlyIfWatched: true }).catch(() => {})
    }
    return result
  }
}

export { USAGE as commandUsage }
