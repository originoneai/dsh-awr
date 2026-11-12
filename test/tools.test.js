// The AWR tools for the model (DSH-012): what they run, for which project, and what they refuse.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AwrError, createAwr } from '../lib/awr-runtime.js'
import { bindConversation } from '../lib/binding.js'
import { MAX_OUTPUT_CHARS, NOT_THROUGH_THE_TOOL, RUN_TOOL, STATUS_TOOL, checkArgs, createAwrTools, registerAwrTools, render, summarizeStatus } from '../lib/tools.js'

const bindingOf = (extra = {}) => ({ projectRoot: '/proj/a', outcome: 'created', sessionId: 'S1', work: { key: 'W-1', why: 'ready' }, ...extra })
const bindingsOf = (map) => ({ get: (id) => (map[id] ? Promise.resolve(map[id]) : undefined) })
const agentOf = (id) => ({ session: { id } })

const STATUS = {
  project: 'proj-a',
  project_id: 'P-A',
  project_revision: 12,
  current: [{ key: 'W-1', next_action: 'Draft it', claims: [{ id: 'c' }] }],
  ready: [{ key: 'W-2', next_action: 'Then this', claims: [] }],
  blocked: [],
  next_action: 'Draft it',
}

function scripted(handlers = {}) {
  const calls = []
  return {
    calls,
    async run(root, args, options) {
      calls.push({ root, args, options })
      const handler = handlers[args[0]] ?? handlers[args.slice(0, 2).join(' ')]
      if (!handler) throw new Error(`unexpected command: ${args.join(' ')}`)
      return handler(args, root, options)
    },
  }
}

// --- arguments ------------------------------------------------------------------------------------

test('checkArgs accepts a command and refuses what would change the project or reach beyond it', () => {
  assert.deepEqual(checkArgs(['work', 'show', 'W-1']), ['work', 'show', 'W-1'])
  for (const bad of [undefined, null, 'status', [], [1], ['status', 2], [['status']]]) assert.throws(() => checkArgs(bad), /non-empty array of strings/)
  assert.throws(() => checkArgs(['awr', 'status']), /not \["awr", "status"\]/)
  for (const flag of ['--project', '--json', '--project=/other', '--json=true']) {
    assert.throws(() => checkArgs(['status', flag, '/other']), /is set by the tool/, flag)
  }
  for (const group of NOT_THROUGH_THE_TOOL) assert.throws(() => checkArgs([group, 'projects']), /not run through this tool/, group)
  assert.throws(() => checkArgs(Array(41).fill('x')), /at most 40/)
  assert.throws(() => checkArgs(['x'.repeat(4001)]), /longer than 4000/)
  assert.ok(NOT_THROUGH_THE_TOOL.has('overview'), 'a project list would show the model projects it is not bound to')
})

test('render keeps short output whole and says how much a long one was cut', () => {
  assert.equal(render({ a: 1 }), '{\n  "a": 1\n}')
  assert.equal(render('plain'), 'plain')
  const long = render({ text: 'x'.repeat(MAX_OUTPUT_CHARS) })
  assert.match(long, /output cut after 60000 of \d+ characters; run a narrower command/)
  assert.ok(long.length < MAX_OUTPUT_CHARS + 300)
})

test('summarizeStatus names the project, the session and what is in progress', () => {
  const summary = summarizeStatus(STATUS, bindingOf())
  assert.deepEqual(summary.project, { name: 'proj-a', id: 'P-A', root: '/proj/a', revision: 12 })
  assert.deepEqual(summary.session, { id: 'S1', work: 'W-1' })
  assert.deepEqual(summary.counts, { in_progress: 1, ready: 1, blocked: 0 })
  assert.deepEqual(summary.in_progress, [{ key: 'W-1', next_action: 'Draft it', claimed: true }])
  assert.equal(summary.next_action, 'Draft it')
  assert.doesNotThrow(() => summarizeStatus({}, { projectRoot: '/p', sessionId: 'S' }))
})

// --- the tools ---------------------------------------------------------------------------------------

test('awr_project_status returns the identity of the conversation\'s own project', async () => {
  const awr = scripted({ status: () => STATUS })
  const { status } = createAwrTools({ awr, bindings: bindingsOf({ c1: bindingOf() }) })
  assert.equal(status.name, STATUS_TOOL)
  const result = await status.execute({}, { agent: agentOf('c1') })
  assert.equal(result.project.id, 'P-A')
  assert.equal(result.project.root, '/proj/a')
  assert.equal(awr.calls[0].root, '/proj/a')
  assert.deepEqual(awr.calls[0].args, ['status'])
  assert.match(status.output.render({}, result)[0].text, /"id": "P-A"/)
})

test('two conversations on different projects each reach only their own, whatever the model passes', async () => {
  const awr = scripted({ status: (_args, root) => ({ ...STATUS, project: root, project_id: `id-of-${root}` }), work: () => ({ ok: true }) })
  const { status, run } = createAwrTools({
    awr,
    bindings: bindingsOf({ a: bindingOf({ projectRoot: '/proj/a', sessionId: 'SA' }), b: bindingOf({ projectRoot: '/proj/b', sessionId: 'SB' }) }),
  })
  assert.equal((await status.execute({}, { agent: agentOf('a') })).project.root, '/proj/a')
  assert.equal((await status.execute({}, { agent: agentOf('b') })).project.root, '/proj/b')
  await run.execute({ args: ['work', 'show', 'W-1'] }, { agent: agentOf('b') })
  assert.equal(awr.calls.at(-1).root, '/proj/b')
  // The model cannot name another project: there is no parameter for it and the flag is refused.
  assert.equal(Object.keys(run.parameters.properties).join(), 'args')
  await assert.rejects(run.execute({ args: ['status', '--project', '/proj/a'] }, { agent: agentOf('b') }), /is set by the tool/)
  await assert.rejects(run.execute({ args: ['overview', 'projects'] }, { agent: agentOf('b') }), /not run through this tool/)
  assert.ok(awr.calls.every((call) => call.root === '/proj/a' || call.root === '/proj/b'))
  assert.equal(awr.calls.filter((call) => call.root === '/proj/a').length, 1, 'conversation b never ran anything in project a')
})

test('the awr tool passes the command through and asks for text only for help', async () => {
  const awr = scripted({ work: () => ({ ok: true }), help: () => ({ output: 'Usage: awr' }) })
  const { run } = createAwrTools({ awr, bindings: bindingsOf({ c1: bindingOf() }) })
  assert.equal(run.name, RUN_TOOL)
  assert.deepEqual(await run.execute({ args: ['work', 'show', 'W-1'] }, { agent: agentOf('c1') }), { ok: true })
  assert.deepEqual(awr.calls.at(-1).args, ['work', 'show', 'W-1'])
  assert.equal(awr.calls.at(-1).options.text, undefined)
  await run.execute({ args: ['help'] }, { agent: agentOf('c1') })
  assert.equal(awr.calls.at(-1).options.text, true)
  await run.execute({ args: ['work', 'prepare', '--help'] }, { agent: agentOf('c1') })
  assert.equal(awr.calls.at(-1).options.text, true)
  assert.ok(awr.calls.every((call) => call.options.timeoutMs < 120_000), 'awr gives up before DSH does')
})

test('whoever shows the work is told after the agent ran a command, also a failed one, never for help, and telling never breaks the tool', async () => {
  const told = []
  const awr = scripted({ work: () => ({ ok: true }), session: () => { throw new AwrError('failed', 'RuleViolation: no', { code: 'RuleViolation', awrMessage: 'no' }) }, help: () => ({ output: 'Usage' }) })
  const { run } = createAwrTools({ awr, bindings: bindingsOf({ c1: bindingOf() }), onRun: (agent, words) => told.push([agent.session.id, words.join(' ')]) })
  await run.execute({ args: ['work', 'claim', 'W-1'] }, { agent: agentOf('c1') })
  await assert.rejects(() => run.execute({ args: ['session', 'end'] }, { agent: agentOf('c1') }))
  await run.execute({ args: ['help'] }, { agent: agentOf('c1') })
  await run.execute({ args: ['work', 'show', '--help'] }, { agent: agentOf('c1') })
  assert.deepEqual(told, [['c1', 'work claim W-1'], ['c1', 'session end']])
  const throwing = createAwrTools({ awr, bindings: bindingsOf({ c1: bindingOf() }), onRun: () => { throw new Error('the interface broke') } })
  assert.deepEqual(await throwing.run.execute({ args: ['work', 'show', 'W-1'] }, { agent: agentOf('c1') }), { ok: true })
})

test('errors from awr reach the model with their code and AWR\'s own suggestion', async () => {
  const conflict = new AwrError('failed', 'RevisionConflict: revision conflict: expected 5, actual 9', { code: 'RevisionConflict', awrMessage: 'revision conflict: expected 5, actual 9' })
  const budget = new AwrError('failed', 'BudgetExceeded: x', { code: 'BudgetExceeded', awrMessage: 'context budget exceeded: required 783, budget 100', awrDetails: { next_action: 'awr context compile --budget 783' } })
  const stopped = new AwrError('schema_mismatch', 'The AWR database is newer than this awr.', { project: '/proj/a' })
  const awr = scripted({ work: () => { throw conflict }, context: () => { throw budget }, session: () => { throw stopped } })
  const { run } = createAwrTools({ awr, bindings: bindingsOf({ c1: bindingOf() }) })
  await assert.rejects(run.execute({ args: ['work', 'progress', 'W-1'] }, { agent: agentOf('c1') }), /RevisionConflict: revision conflict: expected 5, actual 9/)
  await assert.rejects(run.execute({ args: ['context', 'compile'] }, { agent: agentOf('c1') }), /BudgetExceeded: context budget exceeded: required 783, budget 100\nAWR suggests: awr context compile --budget 783/)
  await assert.rejects(run.execute({ args: ['session', 'end'] }, { agent: agentOf('c1') }), /AWR|database|schema/i)
})

test('a ContextIncomplete answer reaches the model as the document awr gave, so it can checkpoint with the hash in it', async () => {
  const document = { ok: false, error: { code: 'ContextIncomplete', message: 'context incomplete' }, project_revision: 7, work_context: { context_hash: 'abc123' }, completeness: { status: 'CONTEXT INCOMPLETE' } }
  const incomplete = new AwrError('failed', 'ContextIncomplete: context incomplete', { code: 'ContextIncomplete', awrMessage: 'context incomplete', awrDocument: document })
  const bare = new AwrError('failed', 'ContextIncomplete: context incomplete', { code: 'ContextIncomplete', awrMessage: 'context incomplete' })
  const awr = scripted({ context: (args) => { throw args.includes('--bare') ? bare : incomplete } })
  const { run } = createAwrTools({ awr, bindings: bindingsOf({ c1: bindingOf() }) })
  assert.deepEqual(await run.execute({ args: ['context', 'compile', '--session', 'S1'] }, { agent: agentOf('c1') }), document)
  await assert.rejects(run.execute({ args: ['context', 'compile', '--bare'] }, { agent: agentOf('c1') }), /ContextIncomplete/, 'without a document it is an error as before')
})

test('a conversation without an AWR session gets no tools and cannot run them', async () => {
  const awr = scripted({ status: () => STATUS })
  const { status, run, when } = createAwrTools({
    awr,
    bindings: bindingsOf({ bound: bindingOf(), failed: { projectRoot: '/proj/x', outcome: 'failed', message: 'x' }, skipped: { projectRoot: '/proj/x', outcome: 'skipped', reason: 'y' } }),
  })
  assert.equal(await when({ agent: agentOf('bound') }), true)
  for (const id of ['failed', 'skipped', 'outside']) assert.equal(await when({ agent: agentOf(id) }), false, id)
  assert.equal(await when({ agent: {} }), false)
  assert.equal(await when({}), false)
  for (const id of ['failed', 'outside']) {
    await assert.rejects(status.execute({}, { agent: agentOf(id) }), /not bound to an AWR session/)
    await assert.rejects(run.execute({ args: ['status'] }, { agent: agentOf(id) }), /not bound to an AWR session/)
  }
  await assert.rejects(status.execute({}, {}), /not bound/)
  assert.equal(awr.calls.length, 0, 'awr is not run for such a conversation')
})

test('a binding that never settles does not hold a model step up for long', async () => {
  const awr = scripted({ status: () => STATUS })
  const { when } = createAwrTools({ awr, bindings: { get: () => new Promise(() => {}) } }, { bindingWaitMs: 30 })
  const keepAlive = setTimeout(() => {}, 10_000)
  try {
    const started = Date.now()
    assert.equal(await when({ agent: agentOf('c1') }), false)
    assert.ok(Date.now() - started < 2000)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('the tool definitions have the shape DSH registers', () => {
  const { status, run } = createAwrTools({ awr: scripted(), bindings: bindingsOf({}) })
  for (const tool of [status, run]) {
    assert.match(tool.name, /^[a-z_]+$/)
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.ok(tool.timeoutMs > 0)
  }
  assert.deepEqual(run.parameters.required, ['args'])
  assert.match(run.description, /--project and --json are refused/)
  assert.match(run.description, /overview, workspace, remote, team/)
})

// --- registration ---------------------------------------------------------------------------------------

test('both tools are registered with the condition, and the registrations go when the service does', () => {
  const registered = []
  const disposed = []
  const tools = { register: (definition, options) => (registered.push({ definition, options }), () => disposed.push(definition.name)) }
  let dispose
  const ctx = { tools, effect: (fn) => ((dispose = fn()), dispose), inject: (services, mount) => (services.includes('tools') ? mount(ctx) : undefined) }
  registerAwrTools(ctx, { awr: scripted(), bindings: bindingsOf({}) })
  assert.deepEqual(registered.map((entry) => entry.definition.name), [STATUS_TOOL, RUN_TOOL])
  assert.ok(registered.every((entry) => typeof entry.options.when === 'function'))
  dispose()
  assert.deepEqual(disposed, [STATUS_TOOL, RUN_TOOL])
})

test('registration works without inject, and does nothing without the tools service', () => {
  const registered = []
  registerAwrTools({ tools: { register: (d) => registered.push(d.name) } }, { awr: scripted(), bindings: bindingsOf({}) })
  assert.deepEqual(registered, [STATUS_TOOL, RUN_TOOL])
  assert.doesNotThrow(() => registerAwrTools({}, { awr: scripted(), bindings: bindingsOf({}) }))
})

// --- the real awr -------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const lab = join(here, '..', '.local', 'awr-lab', 'bin', 'awr')
const real = existsSync(lab) ? test : test.skip

real('against the real awr: two projects, each conversation sees only its own, and help comes back as text', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-awr-tools-state-'))
  const roots = [mkdtempSync(join(tmpdir(), 'dsh-awr-tools-a-')), mkdtempSync(join(tmpdir(), 'dsh-awr-tools-b-'))]
  t.after(() => {
    rmSync(state, { recursive: true, force: true })
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })
  const env = { ...process.env, AWR_LOCAL_HOME: state, AWR_LOCAL_WEB: '0', PATH: `${dirname(lab)}:${process.env.PATH}` }
  const awr = createAwr({ env })
  const bindings = {}
  for (const [index, root] of roots.entries()) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    execFileSync(lab, ['--project', root, '--json', 'init', '--goal', `Project ${'AB'[index]} for the tools`, '--accept'], { env })
    bindings[`conv-${'ab'[index]}`] = { projectRoot: root, ...(await bindConversation(awr, { projectRoot: root, conversationId: `conv-${'ab'[index]}` })) }
  }
  const { status, run, when } = createAwrTools({ awr, bindings: { get: (id) => (bindings[id] ? Promise.resolve(bindings[id]) : undefined) } })
  const [a, b] = ['conv-a', 'conv-b'].map((id) => ({ agent: agentOf(id) }))
  assert.equal(await when(a), true)

  const seenA = await status.execute({}, a)
  const seenB = await status.execute({}, b)
  assert.notEqual(seenA.project.id, seenB.project.id)
  assert.equal(seenA.project.root, roots[0])
  assert.equal(seenB.project.root, roots[1])
  assert.equal(seenA.session.id, bindings['conv-a'].sessionId)
  assert.match(seenA.project.id, /^[0-9A-Z]{26}$/, 'the identity awr itself reports')

  // Through the awr tool: the same status, from the same project only.
  const full = await run.execute({ args: ['status'] }, b)
  assert.equal(full.project_id, seenB.project.id)
  await assert.rejects(run.execute({ args: ['status', '--project', roots[0]] }, b), /is set by the tool/)
  const shown = await run.execute({ args: ['work', 'show', 'INTAKE-001'] }, a)
  assert.ok(JSON.stringify(shown).includes('INTAKE-001'))

  // Help is text, and does not make awr look broken for the next call.
  const help = await run.execute({ args: ['work', '--help'] }, a)
  assert.match(help.output, /Usage: awr work/)
  assert.equal((await status.execute({}, a)).project.id, seenA.project.id)

  // A refused command word never reaches awr.
  await assert.rejects(run.execute({ args: ['runtime', 'restore'] }, a), /not run by the plugin/)
  // A real awr error comes back with its code.
  await assert.rejects(run.execute({ args: ['work', 'show', 'NO-SUCH-WORK'] }, a), /NotFound|not found/i)
})

real('a fake awr that prints text for a command the model chose does not stop the project', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-awr-tools-fake-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(
    join(dir, 'awr'),
    `#!/bin/sh\ncase "$*" in\n  *"runtime binding"*) printf '%s' '{"program":{"version":"0.7.0"},"schema_version":14,"read_only":true,"version":1}';;\n  *"--help"*) printf 'Usage: awr thing\\n';;\n  *) printf '%s' '{"ok":true}';;\nesac\n`,
  )
  chmodSync(join(dir, 'awr'), 0o755)
  const root = mkdtempSync(join(tmpdir(), 'dsh-awr-tools-fakeproj-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const awr = createAwr({ env: { PATH: dir } })
  const { run } = createAwrTools({ awr, bindings: bindingsOf({ c1: bindingOf({ projectRoot: root }) }) })
  assert.deepEqual(await run.execute({ args: ['thing', '--help'] }, { agent: agentOf('c1') }), { output: 'Usage: awr thing' })
  assert.deepEqual(await run.execute({ args: ['thing'] }, { agent: agentOf('c1') }), { ok: true })
  assert.equal(awr.stoppedError(root), undefined)
})
