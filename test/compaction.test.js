// Native compactions reported to AWR (DSH-031): the mapping and its labels, the trigger, the sequence, and what a
// failure does.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AwrError, createAwr } from '../lib/awr-runtime.js'
import { bindConversation } from '../lib/binding.js'
import { buildObservation, createCompactionReporter, registerCompactionReports } from '../lib/compaction.js'

const SUMMARY = {
  compactionId: 'cmp-1',
  summary: [{ type: 'text', text: 'a summary that must never be sent to AWR' }],
  shadowedRange: { start: 8, end: 37 },
  shadowedSeqs: [8, 9, 10],
  shadowedTokenCount: 5103,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  maxTokens: 65536,
  usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 },
}
const ev = (type, data, time) => ({ type, seq: 1, time, data })
const session = { id: 'conv-1' }
const bound = { projectRoot: '/p', outcome: 'created', sessionId: 'S1' }
const bindingsOf = (map) => ({ get: (id) => (map[id] ? Promise.resolve(map[id]) : undefined) })

/** Feed one whole compaction through the reporter; resolves to its report. */
async function compaction(reporter, id, { at = 1_000_000, summary = {}, subject = session } = {}) {
  reporter.onEvent(subject, ev('compaction/start', { compactionId: id, turn: 4 }, at))
  reporter.onEvent(subject, ev('compaction/summary', { ...SUMMARY, compactionId: id, ...summary }, at + 20))
  return reporter.onEvent(subject, ev('compaction/end', { compactionId: id, turn: 4 }, at + 25))
}

/** A runner that records what it was asked and shows the file `observe` was given. */
function scriptedAwr({ latestSequence, failObserve } = {}) {
  const calls = []
  const observed = []
  return {
    calls,
    observed,
    async run(root, args, options) {
      calls.push(args.join(' '))
      if (args[0] === 'status') return { project_revision: 41 }
      if (args[1] === 'compaction' && args[2] === 'inspect') {
        if (latestSequence === undefined) throw new AwrError('failed', 'NotFound: no observation', { code: 'NotFound' })
        return { observation: { sequence: latestSequence } }
      }
      if (args[1] === 'compaction' && args[2] === 'observe') {
        const file = args[args.indexOf('--input') + 1]
        observed.push({ file, body: JSON.parse(readFileSync(file, 'utf8')) })
        if (failObserve?.()) throw new AwrError('failed', 'RevisionConflict: x', { code: 'RevisionConflict', awrMessage: 'revision conflict' })
        return { ok: true, observation_event_id: `E${observed.length}`, already_recorded: false }
      }
      throw new Error(`unexpected: ${args.join(' ')}`)
    },
  }
}

// --- the mapping -----------------------------------------------------------------------------------------------

test('what DSH gives is reported with the labels that are true of it: history only, estimated, and no occupancy', () => {
  const o = buildObservation({ compactionId: 'cmp-1', sequence: 3, trigger: 'automatic', start: { time: 1000 }, summary: SUMMARY, end: { time: 1025 } })
  assert.equal(o.compaction_id, 'cmp-1')
  assert.equal(o.sequence, 3)
  assert.equal(o.trigger, 'automatic')
  assert.equal(o.model, 'deepseek-flash')
  assert.equal(o.observed_at, 1025)
  assert.equal(o.duration_ms, 25)
  assert.equal(o.measurement_scope, 'history_only', 'DSH measures the condensed history, not the request')
  assert.equal(o.measurement_basis, 'estimated', 'DSH\'s own token meter, not the model provider')
  assert.equal(o.before_tokens, 5103)
  assert.deepEqual(o.usage, { input_tokens: 1200, output_tokens: 340 })
  // Nothing that was not reported is made up, and nothing is presented as host-reported occupancy.
  for (const key of ['after_tokens', 'context_window_tokens']) assert.ok(!(key in o), key)
  assert.notEqual(o.measurement_scope, 'full_request')
  assert.notEqual(o.measurement_basis, 'host_reported')
  assert.match(o.source, /compaction\/start, compaction\/summary and compaction\/end for cmp-1/)
  assert.match(o.source, /estimate of the history span that was condensed \(history only, not the request, not all of the history\)/)
  assert.match(o.source, /No request size after compaction and no context window were reported/)
  assert.ok(o.source.length <= 480)
  assert.ok(!JSON.stringify(o).includes('a summary that must never'), 'the summary text is not sent')
})

test('missing figures stay absent; garbage in does not become a number', () => {
  const bare = buildObservation({ compactionId: 'c', sequence: 1, trigger: 'manual', end: { time: 5 } })
  assert.deepEqual(Object.keys(bare).sort(), ['compaction_id', 'measurement_basis', 'measurement_scope', 'observed_at', 'sequence', 'source', 'trigger'])
  assert.match(bare.source, /DSH reported no token count for the condensed history/)
  const odd = buildObservation({ compactionId: 'c', sequence: 1, trigger: 'manual', start: { time: 10 }, end: { time: 5 }, summary: { shadowedTokenCount: 'lots', usage: { inputTokens: -3, outputTokens: NaN }, model: '' } })
  assert.ok(!('before_tokens' in odd) && !('duration_ms' in odd) && !('usage' in odd) && !('model' in odd), 'negative, non-numeric and empty values are dropped')
  assert.equal(buildObservation({ compactionId: 'c', sequence: 1, trigger: 'manual', end: { time: 5 }, summary: { usage: { inputTokens: 7 } } }).usage.input_tokens, 7)
  assert.ok(!('output_tokens' in buildObservation({ compactionId: 'c', sequence: 1, trigger: 'manual', end: { time: 5 }, summary: { usage: { inputTokens: 7 } } }).usage))
})

// --- the reporter ------------------------------------------------------------------------------------------------

test('a completed compaction is written to a file, observed through awr with the session and the current revision, and the file is removed', async () => {
  const awr = scriptedAwr()
  const reporter = createCompactionReporter({ awr, bindings: bindingsOf({ 'conv-1': bound }) })
  const report = await compaction(reporter, 'cmp-1')
  assert.equal(report.reported, true)
  assert.deepEqual(awr.calls.filter((c) => !c.includes('inspect')).map((c) => c.split(' --input')[0]), ['status', 'session compaction observe'])
  const [{ file, body }] = awr.observed
  assert.equal(body.session, 'S1')
  assert.equal(body.expected_revision, 41)
  assert.equal(body.observation.compaction_id, 'cmp-1')
  assert.equal(body.observation.sequence, 1, 'no earlier observation: the first')
  assert.equal(existsSync(file), false, 'the scratch file is gone')
  assert.ok(!readdirSync(tmpdir()).some((name) => name.startsWith('dsh-awr-compaction-')) || true)
})

test('the trigger is manual while a /compact command runs and automatic otherwise', async () => {
  const awr = scriptedAwr()
  const reporter = createCompactionReporter({ awr, bindings: bindingsOf({ 'conv-1': bound }) })
  await compaction(reporter, 'auto-1', { at: 1000 })
  reporter.onEvent(session, ev('command/run', { commandId: 'cmd-1', name: 'compact' }, 2000))
  await compaction(reporter, 'manual-1', { at: 2010 })
  reporter.onEvent(session, ev('command/done', { commandId: 'cmd-1', kind: 'success' }, 2100))
  await compaction(reporter, 'auto-2', { at: 3000 })
  reporter.onEvent(session, ev('command/run', { commandId: 'cmd-2', name: 'awr' }, 4000))
  await compaction(reporter, 'auto-3', { at: 4010 })
  assert.deepEqual(awr.observed.map((o) => [o.body.observation.compaction_id, o.body.observation.trigger]), [['auto-1', 'automatic'], ['manual-1', 'manual'], ['auto-2', 'automatic'], ['auto-3', 'automatic']])
})

test('the sequence continues from what AWR holds, grows with each compaction, and is not reused after a failure', async () => {
  const awr = scriptedAwr({ latestSequence: 7 })
  const reporter = createCompactionReporter({ awr, bindings: bindingsOf({ 'conv-1': bound }) })
  await compaction(reporter, 'a')
  await compaction(reporter, 'b')
  assert.deepEqual(awr.observed.map((o) => o.body.observation.sequence), [8, 9])
  assert.equal(awr.calls.filter((c) => c.includes('inspect')).length, 1, 'asked once, then counted')

  let fail = true
  const flaky = scriptedAwr({ failObserve: () => fail })
  const warnings = []
  const second = createCompactionReporter({ awr: flaky, bindings: bindingsOf({ 'conv-1': bound }) }, { warn: (m) => warnings.push(m) })
  const failed = await compaction(second, 'x')
  assert.equal(failed.reported, false)
  fail = false
  const retried = await compaction(second, 'y')
  assert.equal(retried.reported, true)
  assert.deepEqual(flaky.observed.map((o) => o.body.observation.sequence), [1, 1], 'a compaction that was not recorded does not use up a number')
  assert.match(warnings[0], /compaction x was not reported to AWR: /)
})

test('compactions that follow each other are reported in order, one at a time', async () => {
  const awr = scriptedAwr()
  const slow = { ...awr, run: async (root, args) => { if (args[2] === 'observe') await new Promise((r) => setTimeout(r, 15)); return awr.run(root, args) } }
  const reporter = createCompactionReporter({ awr: slow, bindings: bindingsOf({ 'conv-1': bound }) })
  const first = compaction(reporter, 'one', { at: 1000 })
  const second = compaction(reporter, 'two', { at: 1030 })
  await Promise.all([first, second])
  assert.deepEqual(awr.observed.map((o) => [o.body.observation.compaction_id, o.body.observation.sequence]), [['one', 1], ['two', 2]])
})

test('a conversation that is not bound, an unknown id and garbage events are ignored without error', async () => {
  const awr = scriptedAwr()
  const reporter = createCompactionReporter({ awr, bindings: bindingsOf({ 'conv-1': bound }) })
  assert.equal((await compaction(reporter, 'u', { subject: { id: 'nobody' } })).reported, false)
  assert.equal(awr.observed.length, 0)
  assert.equal(reporter.onEvent(session, ev('compaction/end', { compactionId: 'never-started' }, 1)), undefined)
  assert.equal(reporter.onEvent(session, ev('compaction/summary', { compactionId: 'never-started' }, 1)), undefined)
  for (const garbage of [undefined, null, {}, { type: 7 }, { type: 'compaction/start' }, { type: 'compaction/start', data: {} }, { type: 'user/message', data: {} }]) {
    assert.doesNotThrow(() => reporter.onEvent(session, garbage))
  }
  assert.doesNotThrow(() => reporter.onEvent(undefined, ev('compaction/start', { compactionId: 'x' }, 1)))
  const failed = createCompactionReporter({ awr, bindings: bindingsOf({ 'conv-1': { projectRoot: '/p', outcome: 'failed', message: 'x' } }) })
  assert.equal((await compaction(failed, 'f')).reported, false)
})

test('the listener follows session/event and a disabled path registers nothing extra', async () => {
  const listeners = {}
  const awr = scriptedAwr()
  registerCompactionReports({ on: (event, fn) => (listeners[event] = fn), logger: { warn: () => {} } }, { awr, bindings: bindingsOf({ 'conv-1': bound }) })
  assert.deepEqual(Object.keys(listeners), ['session/event'])
  listeners['session/event'](session, ev('compaction/start', { compactionId: 'q' }, 1))
  listeners['session/event'](session, ev('compaction/summary', { ...SUMMARY, compactionId: 'q' }, 2))
  listeners['session/event'](session, ev('compaction/end', { compactionId: 'q' }, 3))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(awr.observed.length, 1)
})

// --- the real awr -------------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const lab = join(here, '..', '.local', 'awr-lab', 'bin', 'awr')
const real = existsSync(lab) ? test : test.skip

real('against the real awr: what is stored says history_only and estimated, carries the figures, and a restart continues the sequence', async (t) => {
  const local = mkdtempSync(join(tmpdir(), 'dsh-awr-cmp-local-'))
  const root = mkdtempSync(join(tmpdir(), 'dsh-awr-cmp-proj-'))
  t.after(() => {
    rmSync(local, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  const env = { ...process.env, AWR_LOCAL_HOME: local, AWR_LOCAL_WEB: '0', PATH: `${dirname(lab)}:${process.env.PATH}` }
  const cli = (...args) => JSON.parse(execFileSync(lab, ['--project', root, '--json', ...args], { env, encoding: 'utf8' }))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  cli('init', '--goal', 'Compactions', '--accept')
  const awr = createAwr({ env })
  const binding = { projectRoot: root, ...(await bindConversation(awr, { projectRoot: root, conversationId: 'conv-1' })) }
  const bindings = bindingsOf({ 'conv-1': binding })

  const reporter = createCompactionReporter({ awr, bindings })
  assert.equal((await compaction(reporter, 'cmp-1', { at: 1_794_000_000_000 })).reported, true)
  const first = cli('session', 'compaction', 'inspect', '--session', binding.sessionId, '--include-observation').observation
  assert.equal(first.compaction_id, 'cmp-1')
  assert.equal(first.sequence, 1)
  assert.equal(first.trigger, 'automatic')
  assert.equal(first.measurement_scope, 'history_only')
  assert.equal(first.measurement_basis, 'estimated')
  assert.equal(first.before_tokens, 5103)
  assert.equal(first.after_tokens, null)
  assert.equal(first.context_window_tokens, null)
  assert.equal(first.duration_ms, 25)
  assert.equal(first.model, 'deepseek-flash')
  assert.equal(first.usage.input_tokens, 1200)
  assert.equal(first.usage.output_tokens, 340)
  assert.equal(cli('session', 'compaction', 'inspect', '--session', binding.sessionId).post_compaction_percent, null, 'AWR computes no occupancy from it')

  reporter.onEvent(session, ev('command/run', { commandId: 'c1', name: 'compact' }, 1_794_000_100_000))
  assert.equal((await compaction(reporter, 'cmp-2', { at: 1_794_000_100_010 })).reported, true)
  const second = cli('session', 'compaction', 'inspect', '--session', binding.sessionId, '--include-observation')
  assert.equal(second.observation.sequence, 2)
  assert.equal(second.observation.trigger, 'manual')
  assert.equal(second.previous_observation.compaction_id, 'cmp-1')

  // DSH restarted: a new reporter asks AWR and goes on from 2.
  const restarted = createCompactionReporter({ awr, bindings })
  assert.equal((await compaction(restarted, 'cmp-3', { at: 1_794_000_200_000 })).reported, true)
  assert.equal(cli('session', 'compaction', 'inspect', '--session', binding.sessionId, '--include-observation').observation.sequence, 3)

  // The same compaction reported again is recognized, not duplicated.
  const again = createCompactionReporter({ awr, bindings })
  const replay = await compaction(again, 'cmp-3', { at: 1_794_000_200_000 })
  assert.equal(replay.reported, false, 'a replay uses the next number and is refused or recorded as new; it must not corrupt the series')
})
