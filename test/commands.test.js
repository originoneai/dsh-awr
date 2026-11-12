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
