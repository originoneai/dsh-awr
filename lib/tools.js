// AWR tools for the model (DSH-012).
//
// The tools are registered once, for every conversation, and are offered only to a conversation that
// is bound to an AWR session. What they run is decided by the conversation, never by the model:
// the project root comes from the conversation's binding, so two conversations on different
// projects cannot reach each other's project, whatever the model asks for.
//
//   awr_project_status  no arguments; the project's identity, counts, work in progress, next action
//   awr                 `args`: any awr command for this project, for example ["work", "show", "W-1"]
//
// Both go through the runner in awr-runtime.js, so they use the pinned binary, stop on an
// incompatible runtime, and never run migrate, restore, recover or downgrade.
import { AwrError, explain } from './awr-runtime.js'
import { bindingFor } from './binding.js'

export const STATUS_TOOL = 'awr_project_status'
export const RUN_TOOL = 'awr'

const MAX_ARGS = 40
const MAX_ARG_CHARS = 4000
export const MAX_OUTPUT_CHARS = 60_000
const TOOL_TIMEOUT_MS = 120_000
const AWR_TIMEOUT_MS = 100_000
/** How long the offer of the tools may wait for a binding that is still being made. */
const BINDING_WAIT_MS = 5000

/**
 * Command groups the tool does not run. `overview` lists other projects, which would let a
 * conversation see projects it is not bound to; `workspace`, `remote` and `team` talk to other
 * machines and hold endpoint credentials. They stay available to the user in a terminal.
 */
export const NOT_THROUGH_THE_TOOL = new Set(['overview', 'workspace', 'remote', 'team'])
const RESERVED_FLAG = /^--(project|json)(=|$)/

/** The arguments of a tool call, or an Error saying what to change. */
export function checkArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('args must be a non-empty array of strings: the awr command and its arguments, for example ["work", "show", "W-1"]')
  }
  if (args.length > MAX_ARGS) throw new Error(`args has ${args.length} entries; at most ${MAX_ARGS} are accepted`)
  if (args.some((arg) => arg.length > MAX_ARG_CHARS)) throw new Error(`an argument is longer than ${MAX_ARG_CHARS} characters; put long text in a file and pass its path`)
  if (args[0] === 'awr') throw new Error('args starts after the program name: use ["status"], not ["awr", "status"]')
  const reserved = args.find((arg) => RESERVED_FLAG.test(arg))
  if (reserved !== undefined) {
    throw new Error(`${reserved} is set by the tool: the project is this conversation's project and the output is always JSON`)
  }
  if (NOT_THROUGH_THE_TOOL.has(args[0])) {
    throw new Error(`"awr ${args[0]}" is not run through this tool: it reaches other projects or other machines. Ask the user to run it in a terminal.`)
  }
  return args
}

/** The identity and state of the project, from an `awr status` result. */
export function summarizeStatus(status, binding) {
  const list = (key) => (Array.isArray(status?.[key]) ? status[key] : [])
  const item = (work) => ({ key: work.key, ...(work.next_action ? { next_action: work.next_action } : {}), ...((work.claims ?? []).length > 0 ? { claimed: true } : {}) })
  return {
    project: { name: status?.project ?? null, id: status?.project_id ?? null, root: binding.projectRoot, revision: status?.project_revision ?? null },
    session: { id: binding.sessionId, ...(binding.work?.key ? { work: binding.work.key } : {}) },
    counts: { in_progress: list('current').length, ready: list('ready').length, blocked: list('blocked').length },
    in_progress: list('current').map(item),
    ready: list('ready').slice(0, 10).map(item),
    ...(typeof status?.next_action === 'string' ? { next_action: status.next_action } : {}),
  }
}

/** Text for the model: JSON, cut at a stated limit. */
export function render(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… output cut after ${MAX_OUTPUT_CHARS} of ${text.length} characters; run a narrower command (for example work show <KEY> instead of status --view full)`
}

/** An error from awr or from the plugin, worded for the model. */
function failure(error) {
  if (error instanceof AwrError) {
    const code = error.details?.code
    const detail = error.details?.awrDetails?.next_action
    return new Error(`${code ? `${code}: ${error.details?.awrMessage ?? error.message}` : explain(error)}${detail ? `\nAWR suggests: ${detail}` : ''}`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * The two tool definitions and the condition that offers them.
 *
 * @param {{ awr: { run: Function }, bindings: { get(conversationId: string): Promise<object> | undefined } }} dependencies
 * @param {{ bindingWaitMs?: number }} [options]
 */
export function createAwrTools({ awr, bindings, onRun }, { bindingWaitMs = BINDING_WAIT_MS } = {}) {
  const bindingOf = async (agent) => {
    const pending = bindingFor(bindings, agent)
    if (!pending) return undefined
    let timer
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), bindingWaitMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([pending.catch(() => undefined), limit])
    } finally {
      clearTimeout(timer)
    }
  }
  const bound = async (agent) => {
    const binding = await bindingOf(agent)
    if (!binding?.projectRoot || !binding.sessionId) throw new Error('This conversation is not bound to an AWR session, so there is no project for the awr tools.')
    return binding
  }

  const textResult = (value) => [{ type: 'text', text: render(value) }]
  const object = { type: 'object' }

  const status = {
    name: STATUS_TOOL,
    description: 'The AWR project this conversation works on: its name, id, root and revision, the AWR session bound to this conversation, counts of work in progress, ready and blocked, and the next action. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: object, render: (_args, value) => textResult(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(_args, exec) {
      const binding = await bound(exec?.agent)
      try {
        return summarizeStatus(await awr.run(binding.projectRoot, ['status'], { timeoutMs: AWR_TIMEOUT_MS }), binding)
      } catch (error) {
        throw failure(error)
      }
    },
  }

  const run = {
    name: RUN_TOOL,
    description: [
      'Run an awr command for this conversation\'s project and get its JSON result.',
      'args is the command after "awr", for example ["work", "show", "W-1"], ["session", "checkpoint", "--session", "<id>", ...] or ["status"].',
      'The project and JSON output are fixed; --project and --json are refused. Add --help (or use ["help"]) to read a command\'s options as text.',
      'Writes need --expected-revision from the project\'s current revision. Commands that reach other projects or machines (overview, workspace, remote, team) and migrate, restore, recover and downgrade are not run.',
      'This conversation\'s AWR session id is in the "AWR work context" of the prompt.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: { args: { type: 'array', items: { type: 'string' }, description: 'The awr command and its arguments, without "awr" itself.' } },
      required: ['args'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => textResult(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const words = checkArgs(args?.args)
      const binding = await bound(exec?.agent)
      const wantsText = words.includes('--help') || words.includes('-h') || words[0] === 'help'
      try {
        return await awr.run(binding.projectRoot, words, { timeoutMs: AWR_TIMEOUT_MS, ...(wantsText ? { text: true } : {}) })
      } catch (error) {
        // awr answers some failures with the result it could produce (ContextIncomplete: the context, its hash and the
        // gaps) and exit code 1; its document says `ok: false` and carries the error, so passing it on loses nothing,
        // and without it the model has no context hash to checkpoint an incomplete context with.
        if (error instanceof AwrError && error.details?.code === 'ContextIncomplete' && error.details.awrDocument) return error.details.awrDocument
        throw failure(error)
      } finally {
        // What the agent ran may have changed the work; whoever shows it (the header light, the progress page) is told.
        if (!wantsText) {
          try {
            onRun?.(exec?.agent, words)
          } catch {
            // telling the interface never affects the tool
          }
        }
      }
    },
  }

  /** `when` for `ctx.tools.register`: offered to a conversation that has an AWR session. */
  const when = async ({ agent }) => {
    const binding = await bindingOf(agent)
    return Boolean(binding?.projectRoot && binding.sessionId)
  }

  return { status, run, when }
}

/**
 * Register the tools on `ctx.tools`. The service is optional: a profile without it loads the plugin
 * without the tools, and the registration goes when the service does.
 *
 * @param {{ inject?: Function, effect?: Function, tools?: any }} ctx
 * @param {{ awr: { run: Function }, bindings: { get: Function }, onRun?: (agent: any, words: string[]) => void }} dependencies
 */
export function registerAwrTools(ctx, { awr, bindings, onRun }) {
  const { status, run, when } = createAwrTools({ awr, bindings, onRun })
  const mount = (scope) => {
    const register = () => {
      const disposers = [scope.tools.register(status, { when }), scope.tools.register(run, { when })]
      return () => disposers.forEach((dispose) => typeof dispose === 'function' && dispose())
    }
    return typeof scope.effect === 'function' ? scope.effect(register) : register()
  }
  if (typeof ctx.inject === 'function') ctx.inject(['tools'], mount)
  else if (ctx.tools?.register) mount(ctx)
}
