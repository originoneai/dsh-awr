// The AWR work context in the DSH prompt (DSH-014): what it holds, when it is recompiled, and what
// the conversation gets when AWR cannot compile it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AwrError, createAwr } from '../lib/awr-runtime.js'
import { bindConversation } from '../lib/binding.js'
import { createAwrCommand } from '../lib/commands.js'
import {
  CONTEXT_NAME,
  CONTEXT_ORDER,
  DEFAULT_BUDGET,
  createPromptContext,
  registerPromptContext,
  renderNotice,
  renderWorkContext,
} from '../lib/prompt-context.js'

const bound = { projectRoot: '/p', outcome: 'created', sessionId: 'S1', work: { key: 'W-1', why: 'ready' } }
const bindingsOf = (map) => ({ get: (id) => (map[id] ? Promise.resolve(map[id]) : undefined) })
const REVISION_TEXT = 'Next Action:\nDraft the release note\nCheckpoint Open Loops:\ndecide the license\nask the owner'

/** What `awr context compile --json` returns, reduced to the fields the plugin reads. */
function compiled(revision, text = REVISION_TEXT, extra = {}) {
  return {
    project_revision: revision,
    completeness: { status: 'CONTEXT COMPLETE' },
    omitted_refs: [],
    work_context: { identity: { project_key: 'proj', work_item_key: 'W-1', project_revision: revision }, rendered_context: text, omitted_chunks: [] },
    ...extra,
  }
}

/** A scripted runner. `state.revision` is what `status` reports; `state.compile` is what compile does. */
function scripted(state = {}) {
  const calls = []
  state.revision ??= 5
  state.compile ??= () => compiled(state.revision)
  return {
    calls,
    state,
    async run(root, args) {
      calls.push(args)
      if (args[0] === 'status') return { project_id: 'P1', project_revision: state.revision }
      if (args[0] === 'context' && args[1] === 'compile') return state.compile(args)
      throw new Error(`unexpected command: ${args.join(' ')}`)
    },
  }
}
const names = (awr) => awr.calls.map((args) => args.slice(0, 2).join(' '))

function budgetError() {
  return new AwrError('failed', 'BudgetExceeded: context budget exceeded: required 783, budget 100', {
    code: 'BudgetExceeded',
    awrMessage: 'context budget exceeded: required 783, budget 100',
    awrDetails: { budget: 100, required: 783, next_action: 'awr context compile --session S1 --intent work --budget 783' },
  })
}
function staleError() {
  return new AwrError('failed', 'SourceStale: source changed during compile', {
    code: 'SourceStale',
    awrMessage: 'source changed during compile',
    awrDetails: { next_action: 'awr source reindex' },
  })
}

// --- what the prompt holds ----------------------------------------------------------------------

test('the context holds the next action, the open loops and the compiled text, and names the session, work and revision', () => {
  const text = renderWorkContext({ projectRoot: '/p', sessionId: 'S1', compiled: compiled(9) })
  assert.match(text, /^# AWR work context/)
  assert.match(text, /session S1: project proj, work W-1, project revision 9/)
  assert.match(text, /Next Action:\nDraft the release note/)
  assert.match(text, /decide the license\nask the owner/)
  assert.match(text, /Never edit \.awr\/state\.db\*/)
})

test('an incomplete or trimmed context says so', () => {
  const text = renderWorkContext({
    projectRoot: '/p',
    sessionId: 'S1',
    compiled: compiled(9, 'body', { completeness: { status: 'CONTEXT INCOMPLETE' }, omitted_refs: ['a'], work_context: { identity: { work_item_key: 'W-1' }, rendered_context: 'body', omitted_chunks: ['b', 'c'] } }),
  })
  assert.match(text, /Context status: CONTEXT INCOMPLETE/)
  assert.match(text, /3 optional part\(s\) did not fit the budget/)
})

test('the notice names the cause and what AWR suggests, and tells the model not to guess', () => {
  const text = renderNotice({ projectRoot: '/p', sessionId: 'S1', reason: 'BudgetExceeded: required 783, budget 100', suggestion: 'awr context compile --budget 783' })
  assert.match(text, /^# AWR work context unavailable/)
  assert.match(text, /BudgetExceeded: required 783, budget 100/)
  assert.match(text, /AWR suggests: awr context compile --budget 783/)
  assert.match(text, /Do not assume what the next action or the open loops are/)
})

// --- compile and cache ---------------------------------------------------------------------------

test('a refresh compiles for the bound session with the configured budget, and the text is available synchronously', async () => {
  const awr = scripted()
  const prompt = createPromptContext({ awr, bindings: bindingsOf({ c1: bound }) }, { budget: 3000 })
  assert.equal(prompt.text('c1'), '', 'nothing before the first refresh')
  const entry = await prompt.refresh('c1')
  assert.equal(entry.kind, 'context')
  const compile = awr.calls.find((args) => args[0] === 'context')
  assert.deepEqual(compile, ['context', 'compile', '--session', 'S1', '--budget', '3000'])
  assert.match(prompt.text('c1'), /decide the license/)
  assert.equal(typeof prompt.text('c1'), 'string')
})

test('the default budget is 5000 and the plugin never raises it', async () => {
  const awr = scripted()
  const prompt = createPromptContext({ awr, bindings: bindingsOf({ c1: bound }) })
  await prompt.refresh('c1')
  assert.equal(DEFAULT_BUDGET, 5000)
  assert.equal(awr.calls.find((args) => args[0] === 'context').at(-1), '5000')
})

test('an unchanged project revision is not compiled again, so the prompt text stays identical', async () => {
  const awr = scripted()
  const prompt = createPromptContext({ awr, bindings: bindingsOf({ c1: bound }) })
  await prompt.refresh('c1', { force: true })
  const first = prompt.text('c1')
  await prompt.refresh('c1', { force: true })
  await prompt.refresh('c1', { force: true })
  assert.deepEqual(names(awr), ['status', 'context compile', 'status', 'status'])
  assert.equal(prompt.text('c1'), first)
})

test('a changed project revision is compiled again and replaces the text', async () => {
  const awr = scripted()
  const prompt = createPromptContext({ awr, bindings: bindingsOf({ c1: bound }) })
  await prompt.refresh('c1', { force: true })
  awr.state.revision = 6
  awr.state.compile = () => compiled(6, 'Next Action:\nShip it')
  await prompt.refresh('c1', { force: true })
  assert.match(prompt.text('c1'), /Ship it/)
  assert.doesNotMatch(prompt.text('c1'), /Draft the release note/)
  assert.match(prompt.text('c1'), /project revision 6/)
})

test('inside the recheck window nothing is asked of awr unless the refresh is forced', async () => {
  let clock = 1000
  const awr = scripted()
  const prompt = createPromptContext({ awr, bindings: bindingsOf({ c1: bound }) }, { recheckMs: 30_000, now: () => clock })
  await prompt.refresh('c1')
  const after = awr.calls.length
  clock += 10_000
  await prompt.refresh('c1')
  assert.equal(awr.calls.length, after, 'trusted inside the window')
  await prompt.refresh('c1', { force: true })
  assert.equal(awr.calls.length, after + 1, 'forced: asks awr whether the project moved')
  clock += 31_000
  await prompt.refresh('c1')
  assert.equal(awr.calls.length, after + 2, 'outside the window: asks again')
})

test('conversations keep their own context', async () => {
  const awr = scripted({ compile: (args) => compiled(5, `for ${args[3]}`) })
  const prompt = createPromptContext({ awr, bindings: bindingsOf({ c1: bound, c2: { ...bound, sessionId: 'S2' } }) })
  await prompt.refresh('c1')
  await prompt.refresh('c2')
  assert.match(prompt.text('c1'), /for S1/)
  assert.match(prompt.text('c2'), /for S2/)
  assert.equal(prompt.text('unknown'), '')
  prompt.forget('c1')
  assert.equal(prompt.text('c1'), '')
})

test('a resumed conversation that moves to a new session is compiled for that session', async () => {
  const awr = scripted()
  const map = { c1: bound }
  const prompt = createPromptContext({ awr, bindings: bindingsOf(map) })
  await prompt.refresh('c1', { force: true })
  map.c1 = { ...bound, sessionId: 'S9' }
  await prompt.refresh('c1', { force: true })
  assert.deepEqual(awr.calls.filter((args) => args[0] === 'context').map((args) => args[3]), ['S1', 'S9'])
})

test('concurrent refreshes of one conversation share one run', async () => {
  const awr = scripted()
  const prompt = createPromptContext({ awr, bindings: bindingsOf({ c1: bound }) })
  await Promise.all([prompt.refresh('c1'), prompt.refresh('c1'), prompt.refresh('c1')])
  assert.deepEqual(names(awr), ['status', 'context compile'])
})

// --- when AWR cannot compile ---------------------------------------------------------------------

test('BudgetExceeded is surfaced with AWR\'s numbers and suggestion, and nothing is truncated to fit', async () => {
  const awr = scripted({ compile: () => { throw budgetError() } })
  const warnings = []
  const prompt = createPromptContext({ awr, bindings: bindingsOf({ c1: bound }) }, { warn: (message) => warnings.push(message) })
  await prompt.refresh('c1')
  const text = prompt.text('c1')
  assert.match(text, /^# AWR work context unavailable/)
  assert.match(text, /BudgetExceeded: context budget exceeded: required 783, budget 100/)
  assert.match(text, /awr context compile --session S1 --intent work --budget 783/)
  assert.doesNotMatch(text, /Draft the release note/)
  assert.equal(warnings.length, 1)
  assert.match(prompt.describe('c1'), /unavailable: BudgetExceeded/)
})

test('SourceStale is surfaced the same way', async () => {
  const awr = scripted({ compile: () => { throw staleError() } })
  const prompt = createPromptContext({ awr, bindings: bindingsOf({ c1: bound }) })
  await prompt.refresh('c1')
  assert.match(prompt.text('c1'), /SourceStale: source changed during compile/)
  assert.match(prompt.text('c1'), /AWR suggests: awr source reindex/)
})

test('after a failure the old compiled text is not served again, and a later success replaces the notice', async () => {
  const awr = scripted()
  const prompt = createPromptContext({ awr, bindings: bindingsOf({ c1: bound }) })
  await prompt.refresh('c1', { force: true })
  assert.match(prompt.text('c1'), /decide the license/)
  awr.state.revision = 6
  awr.state.compile = () => { throw staleError() }
  await prompt.refresh('c1', { force: true })
  assert.doesNotMatch(prompt.text('c1'), /decide the license/)
  assert.match(prompt.text('c1'), /unavailable/)
  awr.state.compile = () => compiled(6, 'Next Action:\nRecovered')
  await prompt.refresh('c1', { force: true })
  assert.match(prompt.text('c1'), /Recovered/)
  assert.doesNotMatch(prompt.text('c1'), /unavailable/)
})

test('an awr that is missing or incompatible gives a notice in AWR\'s own words', async () => {
  const awr = { async run() { throw new AwrError('missing', 'awr was not found') } }
  const prompt = createPromptContext({ awr, bindings: bindingsOf({ c1: bound }) })
  await prompt.refresh('c1')
  assert.match(prompt.text('c1'), /AWR work context unavailable/)
  assert.match(prompt.text('c1'), /awr/i)
})

test('a conversation whose binding failed gets a notice; one with nothing to bind to gets nothing', async () => {
  const awr = scripted()
  const prompt = createPromptContext({
    awr,
    bindings: bindingsOf({
      failed: { projectRoot: '/p', outcome: 'failed', message: 'AWR schema 14 does not match the project (13)' },
      skipped: { projectRoot: '/p', outcome: 'skipped', reason: 'the project has no work to bind to' },
    }),
  })
  await prompt.refresh('failed')
  await prompt.refresh('skipped')
  await prompt.refresh('outside')
  assert.match(prompt.text('failed'), /schema 14 does not match/)
  assert.equal(prompt.text('skipped'), '')
  assert.equal(prompt.text('outside'), '')
  assert.deepEqual(awr.calls, [], 'awr is not run for a conversation that has no session')
})

test('a refresh never throws, even when the binding lookup does', async () => {
  const prompt = createPromptContext({ awr: scripted(), bindings: { get: () => Promise.reject(new Error('lost')) } }, { warn: () => {} })
  assert.equal(await prompt.refresh('c1'), undefined)
  assert.equal(prompt.text('c1'), '')
})

// --- /awr status ----------------------------------------------------------------------------------

test('/awr status says what AWR context the prompt carries', async () => {
  const awr = scripted()
  const bindings = bindingsOf({ 'conv-1': bound })
  const prompt = createPromptContext({ awr, bindings })
  const command = createAwrCommand({ awr, bindings, context: prompt })
  const before = await command({ agent: { session: { id: 'conv-1' } }, rawInput: 'status' })
  assert.match(before.text, /not compiled yet/)
  await prompt.refresh('conv-1')
  const after = await command({ agent: { session: { id: 'conv-1' } }, rawInput: 'status' })
  assert.match(after.text, /AWR context in the prompt: injected: W-1 at project revision 5/)
})

// --- the DSH wiring --------------------------------------------------------------------------------

/** A stand-in for the plugin context: records what is registered and the listeners. */
function fakeContext() {
  const registered = []
  const listeners = {}
  const ctx = {
    systemPrompt: { context: (definition) => (registered.push(definition), () => {}) },
    inject: (services, mount) => (services.includes('systemPrompt') ? mount(ctx) : undefined),
    on: (event, listener) => (listeners[event] = listener),
    logger: { warn: () => {} },
  }
  return { ctx, registered, listeners }
}
const agentOf = (id) => ({ session: { id } })

test('the context is registered as required, literal and after DSH\'s own contexts', () => {
  const { ctx, registered } = fakeContext()
  registerPromptContext(ctx, { awr: scripted(), bindings: bindingsOf({}) })
  assert.equal(registered.length, 1)
  const [definition] = registered
  assert.equal(definition.name, CONTEXT_NAME)
  assert.equal(definition.order, CONTEXT_ORDER)
  assert.ok(definition.order > 210, 'after the working directory, sandbox, approval, source and web contexts')
  assert.equal(definition.required, true, 'stays when optional runtime context is suppressed')
  assert.equal(definition.interpolate, false, 'compiled text may hold {{...}} that DSH must not resolve')
  assert.equal(typeof definition.text, 'function')
})

test('registration works on a plugin context without inject, and does nothing without the service', () => {
  const registered = []
  registerPromptContext({ systemPrompt: { context: (d) => registered.push(d) }, on: () => {} }, { awr: scripted(), bindings: bindingsOf({}) })
  assert.equal(registered.length, 1)
  assert.doesNotThrow(() => registerPromptContext({ on: () => {} }, { awr: scripted(), bindings: bindingsOf({}) }))
})

test('the registered text is read per agent and carries compiled content that holds braces literally', async () => {
  const { ctx, registered, listeners } = fakeContext()
  const awr = scripted({ compile: () => compiled(5, 'Next Action:\nkeep {{this}} and {{that}} as written') })
  registerPromptContext(ctx, { awr, bindings: bindingsOf({ c1: bound }) })
  await listeners['agent/pre-step']({ agent: agentOf('c1'), step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter' }))
  assert.match(registered[0].text({ agent: agentOf('c1') }), /keep \{\{this\}\} and \{\{that\}\} as written/)
  assert.equal(registered[0].text({ agent: agentOf('other') }), '')
  assert.equal(registered[0].text({}), '')
  assert.equal(registered[0].text(undefined), '')
})

test('agent/pre-step refreshes first, then passes the step on and returns its decision', async () => {
  const { ctx, listeners } = fakeContext()
  const awr = scripted()
  registerPromptContext(ctx, { awr, bindings: bindingsOf({ c1: bound }) })
  const order = []
  const decision = { kind: 'enter', messages: [] }
  const result = await listeners['agent/pre-step'](
    { agent: agentOf('c1'), step: 1, signal: new AbortController().signal },
    async () => (order.push(`next after ${awr.calls.length} awr calls`), decision),
  )
  assert.equal(result, decision)
  assert.deepEqual(order, ['next after 2 awr calls'])
})

test('agent/pre-step always passes the step on, whatever goes wrong in the refresh', async () => {
  for (const failure of [
    { name: 'awr throws something unexpected', awr: { run: () => Promise.reject(new Error('boom')) } },
    { name: 'awr is missing', awr: { run: () => Promise.reject(new AwrError('missing', 'no awr')) } },
    { name: 'binding lookup throws', awr: scripted(), bindings: { get: () => { throw new Error('sync boom') } } },
  ]) {
    const { ctx, listeners } = fakeContext()
    registerPromptContext(ctx, { awr: failure.awr, bindings: failure.bindings ?? bindingsOf({ c1: bound }) })
    let nexts = 0
    await listeners['agent/pre-step']({ agent: agentOf('c1'), step: 1, signal: new AbortController().signal }, async () => (nexts++, { kind: 'enter' }))
    assert.equal(nexts, 1, failure.name)
  }
})

test('agent/pre-step does not run awr for an aborted turn or an agent without a session id', async () => {
  const { ctx, listeners } = fakeContext()
  const awr = scripted()
  registerPromptContext(ctx, { awr, bindings: bindingsOf({ c1: bound }) })
  const aborted = new AbortController()
  aborted.abort()
  let nexts = 0
  const next = async () => (nexts++, { kind: 'enter' })
  await listeners['agent/pre-step']({ agent: agentOf('c1'), step: 1, signal: aborted.signal }, next)
  await listeners['agent/pre-step']({ agent: {}, step: 1 }, next)
  await listeners['agent/pre-step']({}, next)
  assert.equal(nexts, 3)
  assert.deepEqual(awr.calls, [])
})

test('the first step of a turn looks again, later steps of the same turn trust the recheck window', async () => {
  let clock = 0
  const { ctx, listeners } = fakeContext()
  const awr = scripted()
  const prompt = registerPromptContext(ctx, { awr, bindings: bindingsOf({ c1: bound }), recheckMs: 30_000 })
  const step = (n) => listeners['agent/pre-step']({ agent: agentOf('c1'), step: n, signal: new AbortController().signal }, async () => ({ kind: 'enter' }))
  await step(1)
  assert.deepEqual(names(awr), ['status', 'context compile'])
  await step(2)
  await step(3)
  assert.equal(awr.calls.length, 2, 'steps 2 and 3 are inside the window')
  await step(1)
  assert.deepEqual(names(awr), ['status', 'context compile', 'status'], 'the next turn asks whether the project moved')
  assert.ok(prompt)
  void clock
})

test('a slow awr holds a model step up for no longer than the refresh timeout, and the step goes ahead', async () => {
  const { ctx, listeners } = fakeContext()
  const awr = { run: () => new Promise(() => {}) }
  registerPromptContext(ctx, { awr, bindings: bindingsOf({ c1: bound }), refreshTimeoutMs: 40 })
  // The plugin's own timer is unref'd (it must not keep a host alive), so the test keeps the loop running.
  const keepAlive = setTimeout(() => {}, 10_000)
  try {
    const started = Date.now()
    let nexts = 0
    await listeners['agent/pre-step']({ agent: agentOf('c1'), step: 1, signal: new AbortController().signal }, async () => (nexts++, { kind: 'enter' }))
    assert.equal(nexts, 1)
    assert.ok(Date.now() - started < 2000)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('agent/disposed drops the cache of that conversation', async () => {
  const { ctx, registered, listeners } = fakeContext()
  registerPromptContext(ctx, { awr: scripted(), bindings: bindingsOf({ c1: bound }) })
  await listeners['agent/pre-step']({ agent: agentOf('c1'), step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter' }))
  assert.notEqual(registered[0].text({ agent: agentOf('c1') }), '')
  listeners['agent/disposed']({ agent: agentOf('c1') })
  assert.equal(registered[0].text({ agent: agentOf('c1') }), '')
  assert.doesNotThrow(() => listeners['agent/disposed'](undefined))
})

// --- the real awr -----------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const lab = join(here, '..', '.local', 'awr-lab', 'bin', 'awr')
const real = existsSync(lab) ? test : test.skip

real('against the real awr: the prompt gets the next action, then the open loops of a new checkpoint, and notices BudgetExceeded', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-awr-ctx-state-'))
  const root = mkdtempSync(join(tmpdir(), 'dsh-awr-ctx-proj-'))
  t.after(() => {
    rmSync(state, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  const env = { ...process.env, AWR_LOCAL_HOME: state, AWR_LOCAL_WEB: '0', PATH: `${dirname(lab)}:${process.env.PATH}` }
  const cli = (...args) => JSON.parse(execFileSync(lab, ['--project', root, '--json', ...args], { env, encoding: 'utf8' }))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  cli('init', '--goal', 'Check the prompt context against a real awr', '--accept')
  const awr = createAwr({ env })
  const binding = { projectRoot: root, ...(await bindConversation(awr, { projectRoot: root, conversationId: 'conv-1' })) }
  assert.equal(binding.outcome, 'created')

  const prompt = createPromptContext({ awr, bindings: bindingsOf({ 'conv-1': binding }) })
  await prompt.refresh('conv-1', { force: true })
  const first = prompt.text('conv-1')
  assert.match(first, /^# AWR work context/)
  assert.match(first, new RegExp(`session ${binding.sessionId}`))
  assert.match(first, /Next Action:\nRun awr intake inspect/, 'the work\'s own next action')

  // Unchanged project: the same text, so DSH adds no new snapshot message.
  await prompt.refresh('conv-1', { force: true })
  assert.equal(prompt.text('conv-1'), first)

  // A checkpoint with open loops changes the project; the next refresh carries them.
  const compiledNow = cli('context', 'compile', '--session', binding.sessionId, '--budget', '5000')
  const revision = cli('status').project_revision
  cli('session', 'checkpoint', '--session', binding.sessionId, '--context-hash', compiledNow.work_context.context_hash, '--digest', 'Read the intake gaps', '--next-action', 'Add goal references', '--open-loop', 'decide the milestone names', '--open-loop', 'ask the owner for access', '--expected-project-revision', String(revision))
  await prompt.refresh('conv-1', { force: true })
  const second = prompt.text('conv-1')
  assert.notEqual(second, first)
  assert.match(second, /Add goal references/)
  assert.match(second, /decide the milestone names/)
  assert.match(second, /ask the owner for access/)

  // A ledger AWR cannot read gives a notice in AWR's words, never a partial context, and the context returns once it is fixed.
  const ledger = join(root, '.awr', 'intake', 'work-ledger.yaml')
  const original = readFileSync(ledger, 'utf8')
  writeFileSync(ledger, `${original}\n  : : broken: [\n`)
  await prompt.refresh('conv-1', { force: true })
  assert.match(prompt.text('conv-1'), /^# AWR work context unavailable/)
  assert.match(prompt.text('conv-1'), /ContextIncomplete: context incomplete/)
  assert.doesNotMatch(prompt.text('conv-1'), /Add goal references/, 'the old context is not served while the project cannot be read')
  writeFileSync(ledger, original)
  await prompt.refresh('conv-1', { force: true })
  assert.match(prompt.text('conv-1'), /^# AWR work context\n/)
  assert.match(prompt.text('conv-1'), /decide the milestone names/)

  // A budget AWR cannot meet is reported, not worked around.
  const tight = createPromptContext({ awr, bindings: bindingsOf({ 'conv-1': binding }) }, { budget: 50 })
  await tight.refresh('conv-1', { force: true })
  assert.match(tight.text('conv-1'), /^# AWR work context unavailable/)
  assert.match(tight.text('conv-1'), /BudgetExceeded: context budget exceeded: required \d+, budget 50/)
  assert.match(tight.text('conv-1'), /AWR suggests: awr context compile --session \S+ --intent work --budget \d+/)
})
