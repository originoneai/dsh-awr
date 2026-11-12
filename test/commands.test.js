// The /awr command: what it runs for each subcommand, and what it refuses to do.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AwrError, createAwr } from '../lib/awr-runtime.js'
import { bindConversation } from '../lib/binding.js'
import { createAwrCommand, formatStatus } from '../lib/commands.js'
import { registerAwrCommand, watchConversations } from '../lib/conversation.js'
import { createEvidenceCandidates } from '../lib/evidence-candidates.js'

const bound = { projectRoot: '/p', sessionId: 'S1', work: { key: 'W-1', why: 'ready' } }
const agent = { session: { id: 'conv-1' } }
const bindingsOf = (binding) => ({ get: (id) => (id === 'conv-1' && binding ? Promise.resolve(binding) : undefined) })
/** A scripted runner that records what was run. */
function scripted(handlers) {
  const calls = []
  return {
    calls,
    async run(root, args) {
      calls.push(args)
      const handler = handlers[args[0]] ?? handlers[args.slice(0, 2).join(' ')]
      if (!handler) throw new Error(`unexpected command: ${args.join(' ')}`)
      return handler(args)
    },
  }
}
const flag = (args, name) => args[args.indexOf(name) + 1]
const status = (revision) => ({ project_id: 'P1', project_revision: revision, current: [], ready: [{ key: 'W-1' }], blocked: [] })
const run = (awr, binding, rawInput) => createAwrCommand({ awr, bindings: bindingsOf(binding) })({ agent, rawInput })

test('with no subcommand, or "status", the command shows the project status and the binding', async () => {
  for (const input of ['', ' ', 'status']) {
    const awr = scripted({ status: () => ({ ...status(7), current: [{ key: 'W-1', next_action: 'Draft it' }] }) })
    const result = await run(awr, bound, input)
    assert.equal(result.kind, 'success')
    assert.match(result.text, /revision 7/)
    assert.match(result.text, /In progress: W-1, next: Draft it/)
    assert.match(result.text, /bound to AWR session S1 \(work W-1\)/)
    assert.deepEqual(awr.calls, [['status']], 'status writes nothing')
  }
})

test('outside an AWR project, or with an unknown subcommand, nothing is run', async () => {
  const awr = scripted({})
  assert.equal((await run(awr, undefined, 'status')).kind, 'error')
  const unknown = await run(awr, bound, 'frobnicate')
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /Unknown subcommand "frobnicate"/)
  assert.equal((await run(awr, bound, 'help')).kind, 'success')
  assert.equal(awr.calls.length, 0)
})

test('/awr evidence lists the suggested evidence, dismisses it on request, and never runs awr', async () => {
  const evidence = createEvidenceCandidates({ bindings: bindingsOf(bound) })
  evidence.observe({ name: 'bash', agent, arguments: { command: 'npm test' } }, { content: [{ type: 'text', text: 'ok' }] })
  const awr = scripted({})
  const command = createAwrCommand({ awr, bindings: bindingsOf(bound), evidence })
  const shown = await command({ agent, rawInput: 'evidence' })
  assert.equal(shown.kind, 'success')
  assert.match(shown.text, /1 evidence candidate\(s\), all with exit 0\. Nothing was registered/)
  assert.match(shown.text, /test run \(npm test\): npm test/)
  const dismissed = await command({ agent, rawInput: 'evidence dismiss' })
  assert.match(dismissed.text, /Dismissed 1 evidence candidate\(s\)\. Nothing was registered\./)
  assert.match((await command({ agent, rawInput: 'evidence' })).text, /^No evidence candidates/)
  assert.match((await command({ agent, rawInput: 'evidence dismiss' })).text, /no evidence candidates to dismiss/)
  const bad = await command({ agent, rawInput: 'evidence register' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /Unknown evidence option "register"/)
  assert.equal(awr.calls.length, 0, 'the suggestions are the plugin\'s own; AWR is not asked and nothing is written')
  // switched off in the profile
  const off = await createAwrCommand({ awr, bindings: bindingsOf(bound) })({ agent, rawInput: 'evidence' })
  assert.equal(off.kind, 'error')
  assert.match(off.text, /turned off/)
  assert.match((await command({ agent, rawInput: 'help' })).text, /\/awr evidence \[dismiss\]/)
})

test('claim sends the current revision, the session and the bound work by default', async () => {
  const awr = scripted({ status: () => status(11), 'work claim': () => ({ project_revision: 12 }) })
  const result = await run(awr, bound, 'claim')
  assert.equal(result.kind, 'success')
  const claim = awr.calls.find((c) => c[1] === 'claim')
  assert.equal(claim[2], 'W-1')
  assert.equal(flag(claim, '--session'), 'S1')
  assert.equal(flag(claim, '--expected-revision'), '11')
  const named = await run(awr, bound, 'claim OTHER-2')
  assert.equal(awr.calls.filter((c) => c[1] === 'claim').at(-1)[2], 'OTHER-2')
  assert.equal(named.kind, 'success')
})

const gapDocument = (extra = {}) => ({
  work_context: { context_hash: 'b'.repeat(64), identity: { work_item_key: 'md-01da' } },
  error: { code: 'ContextIncomplete', details: { incomplete_checkpoint_allowed: true, next_action: 'Save a checkpoint marked incomplete and list each gap as an open loop.' } },
  completeness: {
    complete: false,
    source_fresh: true,
    issues: [{ code: 'acceptance_missing_or_stale', reason: 'Current work needs fresh, nonempty acceptance criteria' }, { code: 'goal_state_incomplete', reason: 'Goal title/status\n must be declared' }],
    evidence_gaps: [{ code: 'no_evidence', reason: 'no evidence is associated with this work' }],
  },
  ...extra,
})
const incomplete = (document) => () => { throw new AwrError('failed', 'ContextIncomplete: context incomplete', { code: 'ContextIncomplete', awrMessage: 'context incomplete: L1 has required gaps', awrDocument: document }) }

test('a checkpoint on a context AWR calls incomplete is saved as AWR says: marked incomplete, each gap an open loop', async () => {
  const awr = scripted({ status: () => status(20), 'context compile': incomplete(gapDocument()), 'session checkpoint': () => ({ checkpoint: { id: 'C9' } }) })
  const result = await run(awr, bound, 'checkpoint Took the project over :: Confirm the goals')
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /Checkpoint saved for AWR session S1 \(C9\), marked incomplete: the context of the work has 3 gap\(s\), kept as open loops\./)
  const saved = awr.calls.find((c) => c[1] === 'checkpoint')
  assert.equal(flag(saved, '--context-hash'), 'b'.repeat(64), 'the hash is the one of the document AWR returned')
  const loops = saved.flatMap((arg, index) => (arg === '--open-loop' ? [saved[index + 1]] : []))
  assert.deepEqual(loops, [
    'acceptance_missing_or_stale: Current work needs fresh, nonempty acceptance criteria',
    'goal_state_incomplete: Goal title/status must be declared',
    'no_evidence: no evidence is associated with this work',
  ])
  // A complete context carries no open loop and says nothing of incompleteness.
  const complete = scripted({ status: () => status(20), 'context compile': () => ({ work_context: { context_hash: 'a'.repeat(64) } }), 'session checkpoint': () => ({ checkpoint: { id: 'C1' } }) })
  const plain = await run(complete, bound, 'checkpoint done :: next')
  assert.ok(!complete.calls.find((c) => c[1] === 'checkpoint').includes('--open-loop'))
  assert.doesNotMatch(plain.text, /incomplete/)
})

test('an incomplete context is not checkpointed when AWR does not allow it, its sources are not current, or it carries no hash', async () => {
  const refusals = {
    'AWR does not allow an incomplete checkpoint': gapDocument({ error: { code: 'ContextIncomplete', details: { incomplete_checkpoint_allowed: false } } }),
    'AWR says nothing of it': gapDocument({ error: undefined }),
    'the sources are stale': gapDocument({ completeness: { complete: false, source_fresh: false, issues: [] } }),
    'the document has no hash': gapDocument({ work_context: { identity: {} } }),
  }
  for (const [why, document] of Object.entries(refusals)) {
    const awr = scripted({ status: () => status(20), 'context compile': incomplete(document), 'session checkpoint': () => ({}) })
    const result = await run(awr, bound, 'checkpoint done :: next')
    assert.equal(result.kind, 'error', why)
    assert.match(result.text, /context incomplete/, why)
    assert.ok(!awr.calls.some((c) => c[1] === 'checkpoint'), `${why}: nothing is saved`)
  }
})

test('a conversation whose binding names no work (a takeover made it) claims the work its session is bound to', async () => {
  const unbound = { projectRoot: '/p', sessionId: 'S1' }
  const awr = scripted({
    status: () => status(11),
    'context compile': () => ({ work_context: { identity: { work_item_key: 'md-01da' } } }),
    'work claim': () => ({ project_revision: 12 }),
  })
  const result = await run(awr, unbound, 'claim')
  assert.equal(result.kind, 'success', result.text)
  const claim = awr.calls.find((c) => c[1] === 'claim')
  assert.equal(claim[2], 'md-01da')
  assert.equal(flag(claim, '--session'), 'S1')
  assert.equal(awr.calls.filter((c) => c[0] === 'context').length, 1, 'the context is compiled once')
  assert.deepEqual(awr.calls.find((c) => c[0] === 'context').slice(0, 3), ['context', 'compile', '--session'])
  // A context AWR calls incomplete still names the work.
  const incomplete = scripted({
    status: () => status(11),
    'context compile': () => { const error = new Error('incomplete'); error.details = { awrDocument: { work_context: { identity: { work_item_key: 'md-02' } } } }; throw error },
    'work claim': () => ({ project_revision: 12 }),
  })
  await run(incomplete, unbound, 'claim')
  assert.equal(incomplete.calls.find((c) => c[1] === 'claim')[2], 'md-02')
  // A session with no work says so, and nothing is claimed.
  const none = scripted({ status: () => status(11), 'context compile': () => ({ work_context: {} }), 'work claim': () => ({}) })
  const refused = await run(none, unbound, 'claim')
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /has no work to claim/)
  assert.ok(!none.calls.some((c) => c[1] === 'claim'))
  // A binding that knows its work does not compile anything.
  const known = scripted({ status: () => status(11), 'work claim': () => ({ project_revision: 12 }) })
  await run(known, bound, 'claim')
  assert.ok(!known.calls.some((c) => c[0] === 'context'))
})

test('checkpoint needs a digest and a next action, and uses a freshly compiled context hash and the current revision', async () => {
  const awr = scripted({
    status: () => status(20),
    'context compile': () => ({ work_context: { context_hash: 'a'.repeat(64) } }),
    'session checkpoint': () => ({ checkpoint: { id: 'C1' } }),
  })
  for (const input of ['checkpoint', 'checkpoint only a digest', 'checkpoint :: only next']) {
    assert.equal((await run(awr, bound, input)).kind, 'error', input)
  }
  assert.ok(!awr.calls.some((c) => c[1] === 'checkpoint'), 'an incomplete checkpoint is not sent')
  const result = await run(awr, bound, 'checkpoint Implemented the parser :: Write its tests')
  assert.equal(result.kind, 'success')
  const saved = awr.calls.find((c) => c[1] === 'checkpoint')
  assert.equal(flag(saved, '--digest'), 'Implemented the parser')
  assert.equal(flag(saved, '--next-action'), 'Write its tests')
  assert.equal(flag(saved, '--context-hash'), 'a'.repeat(64))
  assert.equal(flag(saved, '--expected-revision'), '20')
})

test('a resumed conversation, whose binding carries no work key, can checkpoint: the session knows its work', async () => {
  const awr = scripted({
    status: () => status(20),
    'context compile': () => ({ work_context: { context_hash: 'b'.repeat(64) } }),
    'session checkpoint': () => ({ checkpoint: { id: 'C2' } }),
  })
  const resumed = { projectRoot: '/p', outcome: 'existing', sessionId: 'S1' }
  const result = await run(awr, resumed, 'checkpoint Resumed and read the notes :: Continue')
  assert.equal(result.kind, 'success', result.text)
  const compile = awr.calls.find((c) => c[1] === 'compile')
  assert.equal(flag(compile, '--session'), 'S1')
  assert.ok(!compile.includes('--work'), 'compiled for the session, not for a work key the binding does not have')
  assert.equal(flag(awr.calls.find((c) => c[1] === 'checkpoint'), '--context-hash'), 'b'.repeat(64))
})

test('end validates the outcome, sends the current revision, and says that work is not completed', async () => {
  const awr = scripted({ status: () => status(5), 'session end': () => ({ ok: true }) })
  assert.equal((await run(awr, bound, 'end banana')).kind, 'error')
  assert.ok(!awr.calls.some((c) => c[1] === 'end'))
  const result = await run(awr, bound, 'end interrupted')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /not completed/)
  const end = awr.calls.find((c) => c[1] === 'end')
  assert.equal(flag(end, '--outcome'), 'interrupted')
  assert.equal(flag(end, '--expected-revision'), '5')
  await run(awr, bound, 'end')
  assert.equal(flag(awr.calls.filter((c) => c[1] === 'end').at(-1), '--outcome'), 'ended')
})

test('a revision conflict is reported once and the write is not retried', async () => {
  const conflict = new AwrError('failed', 'RevisionConflict: revision conflict: expected 5, actual 9', { code: 'RevisionConflict', awrMessage: 'revision conflict: expected 5, actual 9' })
  const awr = scripted({ status: () => status(5), 'session end': () => { throw conflict } })
  const result = await run(awr, bound, 'end')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /changed while the command was being prepared/)
  assert.match(result.text, /expected 5, actual 9/)
  assert.equal(awr.calls.filter((c) => c[1] === 'end').length, 1, 'exactly one attempt')
})

test('an awr that stops the plugin is explained, and an unbound conversation cannot write', async () => {
  const missing = new AwrError('missing', 'No awr was found.', { project: '/p' })
  const result = await run({ run: async () => { throw missing } }, bound, 'status')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /AWR is not available/)
  const unbound = { projectRoot: '/p', outcome: 'skipped', reason: 'the project has no work to bind to' }
  const refused = await run(scripted({ status: () => status(1) }), unbound, 'end')
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /no AWR session/)
})

test('formatStatus tells a fork what it is, and says nothing for a conversation that is not one', () => {
  const status = { project_id: 'P', project_revision: 3, current: [], ready: [], blocked: [] }
  const fork = { parentConversation: 'parent-1', parentSession: 'S1', mode: 'parent_active' }
  const text = formatStatus(status, { sessionId: 'S2', work: { key: 'W-1' }, fork }, 'context line')
  assert.match(text, /bound to AWR session S2 \(work W-1\)\nThis conversation is a fork of DSH conversation parent-1, whose AWR session S1 is still active/)
  assert.ok(text.endsWith('context line'), 'the context line stays last')
  assert.doesNotMatch(formatStatus(status, { sessionId: 'S2' }), /fork/)
})

test('formatStatus covers an unbound conversation and a project with only a next action', () => {
  const text = formatStatus({ project_id: 'P', project_revision: 3, next_action: 'Do the thing' }, undefined)
  assert.match(text, /Next: Do the thing/)
  assert.match(text, /not bound/)
})

test('registerAwrCommand mounts /awr once the commands service exists and tolerates profiles without it', () => {
  const registered = []
  const withService = {
    inject: (deps, mount) => {
      assert.deepEqual(deps, ['commands'])
      mount({ commands: { register: (definition) => (registered.push(definition), () => {}) }, effect: (register) => register() })
    },
  }
  registerAwrCommand(withService, { awr: scripted({}), bindings: bindingsOf(undefined) })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'awr')
  assert.match(registered[0].input.hint, /checkpoint/)
  assert.equal(typeof registered[0].handler, 'function')
  assert.doesNotThrow(() => registerAwrCommand({}, { awr: scripted({}), bindings: bindingsOf(undefined) }))
})

test('unloading the command stops the periodic writing of the panel data, and the command is still removed', () => {
  const log = []
  const panel = { stop: () => log.push('panel stopped'), publish: async () => ({}) }
  let disposeEffect
  registerAwrCommand({
    inject: (_deps, mount) => {
      disposeEffect = mount({ commands: { register: () => () => log.push('command removed') }, effect: (register) => register() })
    },
  }, { awr: scripted({}), bindings: bindingsOf(undefined), panel })
  disposeEffect()
  assert.deepEqual(log, ['panel stopped', 'command removed'])
})

// --- the real awr -------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const lab = join(here, '..', '.local', 'awr-lab', 'bin', 'awr')
const real = existsSync(lab) ? test : test.skip

real('against the real awr: status, claim, checkpoint and end change AWR as described', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-awr-cmd-state-'))
  const root = mkdtempSync(join(tmpdir(), 'dsh-awr-cmd-proj-'))
  t.after(() => {
    rmSync(state, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  const env = { ...process.env, AWR_LOCAL_HOME: state, AWR_LOCAL_WEB: '0', PATH: `${dirname(lab)}:${process.env.PATH}` }
  const cli = (...args) => JSON.parse(execFileSync(lab, ['--project', root, '--json', ...args], { env, encoding: 'utf8' }))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  cli('init', '--goal', 'Check the /awr command against a real awr', '--accept')
  const awr = createAwr({ env })
  const binding = { projectRoot: root, ...(await bindConversation(awr, { projectRoot: root, conversationId: 'conv-1' })) }
  assert.equal(binding.outcome, 'created')
  const command = createAwrCommand({ awr, bindings: bindingsOf(binding) })
  const say = async (rawInput) => command({ agent, rawInput })

  const shown = await say('status')
  assert.equal(shown.kind, 'success', shown.text)
  assert.match(shown.text, new RegExp(`bound to AWR session ${binding.sessionId}`))

  const claimed = await say('claim')
  assert.equal(claimed.kind, 'success', claimed.text)
  assert.equal(cli('session', 'show', binding.sessionId).claims.filter((c) => c.status === 'active').length, 1)

  const checkpoint = await say('checkpoint Read the intake context :: Organize the ledger')
  assert.equal(checkpoint.kind, 'success', checkpoint.text)
  const after = cli('session', 'show', binding.sessionId)
  assert.equal(after.checkpoint.next_action, 'Organize the ledger')

  const ended = await say('end interrupted')
  assert.equal(ended.kind, 'success', ended.text)
  assert.equal((cli('session', 'show', binding.sessionId).session ?? {}).status, 'interrupted')
  const again = await say('end')
  assert.equal(again.kind, 'error', 'ending an already ended session is reported, not hidden')
})
