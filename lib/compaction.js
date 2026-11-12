// Reports DSH's native compactions to AWR (DSH-031) through its context-continuity protocol
// (`awr session compaction observe`, docs/integrations/context-continuity.md in the AWR repository).
//
// What DSH gives, read from the session events of real compactions (docs/compaction.md):
//   compaction/start    { compactionId, turn }
//   compaction/summary  { compactionId, shadowedTokenCount, shadowedRange, usage: { inputTokens, outputTokens },
//                         provider, model, maxTokens, summary, ... }
//   compaction/end      { compactionId, turn }
// `shadowedTokenCount` is DSH's own count of the history span that was condensed: history only (not the request
// that is sent), the span and not all of the history, and measured by DSH's token meter, not reported by the model
// provider. `usage` is the provider's report for the summarizing call. DSH gives no request footprint before or
// after a compaction, no context window, and does not say whether the user or the pressure policy started it.
//
// So what is reported is exactly that, with its labels: `measurement_scope: history_only`,
// `measurement_basis: estimated`, `before_tokens` = the condensed span (the source text says so), no
// `after_tokens`, no `context_window_tokens`, so AWR computes no occupancy percentage and gives no threshold advice
// from it. The trigger is `manual` when a `/compact` command was running when the compaction started and
// `automatic` otherwise, the two values AWR accepts. Nothing is inferred from the length of the summary, from
// cumulative billing or from AWR's own context estimate.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AwrError, explain } from './awr-runtime.js'

const COMPACT_COMMAND = 'compact'
const MAX_SOURCE_CHARS = 240

const finite = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined)

/**
 * The observation for one completed compaction, from the three events and what is known about its start.
 * Pure, so the mapping can be tested without awr or DSH.
 *
 * @param {{ start?: { time?: number }, summary?: object, end?: { time?: number }, trigger: 'manual' | 'automatic', sequence: number, compactionId: string }} compaction
 */
export function buildObservation({ compactionId, sequence, trigger, start, summary, end }) {
  const data = summary ?? {}
  const condensed = finite(data.shadowedTokenCount)
  const duration = finite((end?.time ?? NaN) - (start?.time ?? NaN))
  const input = finite(data.usage?.inputTokens)
  const output = finite(data.usage?.outputTokens)
  const source = [
    `DeepSeek Harness session events compaction/start, compaction/summary and compaction/end for ${compactionId}.`,
    condensed === undefined ? 'DSH reported no token count for the condensed history.' : `before_tokens is DSH's own estimate of the history span that was condensed (history only, not the request, not all of the history).`,
    'No request size after compaction and no context window were reported.',
  ].join(' ').slice(0, MAX_SOURCE_CHARS * 2)
  return {
    compaction_id: compactionId,
    sequence,
    observed_at: finite(end?.time) ?? Date.now(),
    trigger,
    ...(typeof data.model === 'string' && data.model ? { model: data.model } : {}),
    source,
    measurement_scope: 'history_only',
    measurement_basis: 'estimated',
    ...(condensed === undefined ? {} : { before_tokens: condensed }),
    ...(duration === undefined ? {} : { duration_ms: duration }),
    ...(input === undefined && output === undefined ? {} : { usage: { ...(input === undefined ? {} : { input_tokens: input }), ...(output === undefined ? {} : { output_tokens: output }) } }),
  }
}

/**
 * @param {{ awr: { run: Function }, bindings: { get(conversationId: string): Promise<object> | undefined } }} dependencies
 * @param {{ trace?: Function, warn?: Function, scratchDir?: string }} [options]
 */
export function createCompactionReporter({ awr, bindings }, { trace, warn, scratchDir = tmpdir() } = {}) {
  /** @type {Map<string, { commands: Map<string, string>, open: Map<string, { start: object, summary?: object, trigger: 'manual' | 'automatic' }>, sequence?: number, queue: Promise<void> }>} */
  const states = new Map()
  const stateOf = (id) => {
    if (!states.has(id)) states.set(id, { commands: new Map(), open: new Map(), queue: Promise.resolve() })
    return states.get(id)
  }

  /** The sequence AWR holds for this conversation's session, so that a restart of DSH continues it. */
  async function lastSequence(root, sessionId) {
    try {
      const inspected = await awr.run(root, ['session', 'compaction', 'inspect', '--session', sessionId, '--include-observation'])
      const found = inspected?.observation?.sequence ?? inspected?.native_compaction_observation?.sequence ?? inspected?.latest_observation?.sequence
      return Number.isInteger(found) ? found : 0
    } catch {
      return 0
    }
  }

  async function report(conversationId, compactionId, compaction) {
    const binding = await bindings.get(conversationId)
    if (!binding?.projectRoot || !binding.sessionId || binding.outcome === 'failed') {
      trace?.({ event: 'compaction-not-reported', conversationId, compactionId, reason: 'not_bound' })
      return { reported: false, reason: 'not_bound' }
    }
    const state = stateOf(conversationId)
    if (state.sequence === undefined) state.sequence = await lastSequence(binding.projectRoot, binding.sessionId)
    const sequence = state.sequence + 1
    const observation = buildObservation({ compactionId, sequence, ...compaction })
    const dir = await mkdtemp(join(scratchDir, 'dsh-awr-compaction-'))
    try {
      const status = await awr.run(binding.projectRoot, ['status'])
      const input = join(dir, 'observation.json')
      await writeFile(input, JSON.stringify({ session: binding.sessionId, expected_revision: Number(status.project_revision), observation }))
      const result = await awr.run(binding.projectRoot, ['session', 'compaction', 'observe', '--input', input])
      state.sequence = sequence
      trace?.({ event: 'compaction-reported', conversationId, compactionId, sequence, trigger: observation.trigger, observation_event_id: result?.observation_event_id, already_recorded: result?.already_recorded })
      return { reported: true, sequence, result, observation }
    } catch (error) {
      const message = error instanceof AwrError ? explain(error) : String(error?.message ?? error)
      warn?.(`DSH compaction ${compactionId} was not reported to AWR: ${message}`)
      trace?.({ event: 'compaction-not-reported', conversationId, compactionId, reason: message.slice(0, 200) })
      return { reported: false, reason: message }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return {
    /**
     * `session/event`: follows the compaction events and the `/compact` command of every session. Never throws.
     * Returns a promise for the report that this event completed, if any (for tests).
     */
    onEvent(session, event) {
      try {
        const id = session?.id
        if (typeof id !== 'string' || typeof event?.type !== 'string') return undefined
        const state = stateOf(id)
        const data = event.data ?? {}
        if (event.type === 'command/run') {
          if (data.name === COMPACT_COMMAND && typeof data.commandId === 'string') state.commands.set(data.commandId, COMPACT_COMMAND)
          return undefined
        }
        if (event.type === 'command/done') {
          state.commands.delete(data.commandId)
          return undefined
        }
        if (!event.type.startsWith('compaction/') || typeof data.compactionId !== 'string') return undefined
        if (event.type === 'compaction/start') {
          state.open.set(data.compactionId, { start: event, trigger: state.commands.size > 0 ? 'manual' : 'automatic' })
          return undefined
        }
        const open = state.open.get(data.compactionId)
        if (!open) return undefined
        if (event.type === 'compaction/summary') {
          open.summary = data
          return undefined
        }
        if (event.type === 'compaction/end') {
          state.open.delete(data.compactionId)
          // One at a time per conversation, in the order the compactions ended: the sequence must grow.
          const done = state.queue.then(() => report(id, data.compactionId, { trigger: open.trigger, start: open.start, summary: open.summary, end: event }))
          state.queue = done.then(() => undefined, () => undefined)
          return done
        }
        return undefined
      } catch (error) {
        warn?.(`A DSH compaction event was skipped: ${error?.message ?? error}`)
        return undefined
      }
    },
    forget: (id) => states.delete(id),
  }
}

/**
 * Listen to the session events of every conversation.
 *
 * @param {{ on: Function, logger?: any }} ctx
 * @param {{ awr: object, bindings: object, trace?: Function }} dependencies
 */
export function registerCompactionReports(ctx, { awr, bindings, trace }) {
  const reporter = createCompactionReporter({ awr, bindings }, { trace, warn: (message) => ctx.logger?.warn?.(message) })
  ctx.on('session/event', (session, event) => {
    reporter.onEvent(session, event)
  })
  return reporter
}
