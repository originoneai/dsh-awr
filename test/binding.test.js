// Binding logic against a scripted awr (what it would run) and, when the lab build is present,
// against the real thing on a disposable project.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AwrError, createAwr } from '../lib/awr-runtime.js'
import { bindConversation, chooseWork, externalId, latestBinding, workClaimedBy } from '../lib/binding.js'

/** A scripted runner: `handlers` map the first two command words to a function of the full args. */
function scripted(handlers) {
  const calls = []
  return {
    calls,
    async run(root, args) {
      calls.push(args)
      const handler = handlers[args.slice(0, 2).join(' ')]
      if (!handler) throw new Error(`unexpected command: ${args.join(' ')}`)
      return handler(args)
    },
  }
}
const flag = (args, name) => args[args.indexOf(name) + 1]

test('external ids carry the conversation and a generation', () => {
  assert.equal(externalId('session-1'), 'dsh:session-1')
  assert.equal(externalId('session-1', 2), 'dsh:session-1#2')
  assert.throws(() => externalId(''), TypeError)
})

test('work choice prefers unclaimed in-progress, then ready, then blocked work, and skips claimed work', () => {
  assert.deepEqual(chooseWork({ current: [{ key: 'A', claims: [{}] }, { key: 'B', claims: [] }], ready: [{ key: 'R' }] }), { key: 'B', why: 'in_progress' })
  assert.deepEqual(chooseWork({ current: [], ready: [{ key: 'R', claims: [] }] }), { key: 'R', why: 'ready' })
  assert.deepEqual(chooseWork({ current: [{ key: 'A', claims: [{}] }], ready: [{ key: 'R' }] }), { key: 'R', why: 'ready' })
  assert.deepEqual(chooseWork({ current: [], ready: [], blocked: [{ key: 'I-1' }] }), { key: 'I-1', why: 'blocked' })
  assert.equal(chooseWork({ current: [], ready: [], blocked: [{ key: 'I-1', claims: [{}] }] }), undefined)
  assert.equal(chooseWork({ current: [], ready: [] }), undefined)
  assert.equal(chooseWork({}), undefined)
})

test('a new conversation is bound with client generic, the model, and no claim', async () => {
  const awr = scripted({
    'client show': () => ({ binding: null }),
    status: () => ({ current: [], ready: [{ key: 'W-1', claims: [] }] }),
    'client bind': () => ({ binding: { session_id: 'S1' } }),
  })
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'c1', model: 'deepseek-flash' })
  assert.deepEqual(result, { outcome: 'created', sessionId: 'S1', externalSession: 'dsh:c1', work: { key: 'W-1', why: 'ready' } })
  const bind = awr.calls.find((c) => c[1] === 'bind')
  assert.equal(flag(bind, '--client'), 'generic')
  assert.equal(flag(bind, '--external-session'), 'dsh:c1')
  assert.equal(flag(bind, '--work'), 'W-1')
  assert.equal(flag(bind, '--model'), 'deepseek-flash')
  assert.ok(!bind.includes('--from-session') && !bind.includes('--claim') && !bind.includes('--session'))
  assert.ok(!awr.calls.some((c) => c[0] === 'session' && c[1] === 'start'), 'binding must not start or claim a session')
})

test('a resumed conversation reuses its active session and calls nothing that writes', async () => {
  const awr = scripted({
    'client show': () => ({ binding: { session_id: 'S1' } }),
    'session show': () => ({ session: { status: 'active' } }),
  })
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'c1' })
  assert.deepEqual(result, { outcome: 'existing', sessionId: 'S1', externalSession: 'dsh:c1' })
  assert.ok(awr.calls.every((c) => c[1] === 'show'))
})

test('after the session ended, the conversation continues under the next generation from the ended session', async () => {
  const ended = new Set(['S1', 'S2'])
  const known = { 'dsh:c1': 'S1', 'dsh:c1#2': 'S2' }
  const awr = scripted({
    'client show': (args) => ({ binding: known[flag(args, '--external-session')] ? { session_id: known[flag(args, '--external-session')] } : null }),
    'session show': (args) => ({ session: { status: ended.has(args[2]) ? 'interrupted' : 'active' } }),
    status: () => ({ current: [{ key: 'W-9', claims: [] }], ready: [] }),
    'client bind': (args) => {
      assert.equal(flag(args, '--external-session'), 'dsh:c1#3')
      assert.equal(flag(args, '--from-session'), 'S2')
      return { binding: { session_id: 'S3' } }
    },
  })
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'c1' })
  assert.deepEqual(result, { outcome: 'created', sessionId: 'S3', externalSession: 'dsh:c1#3', work: { key: 'W-9', why: 'in_progress' }, successorOf: 'S2' })
})

test('a project with no work at all is skipped, not bound', async () => {
  const awr = scripted({ 'client show': () => ({ binding: null }), status: () => ({ current: [], ready: [] }) })
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'c1' })
  assert.equal(result.outcome, 'skipped')
  assert.ok(!awr.calls.some((c) => c[1] === 'bind'))
})

test('an explicit work key skips the status lookup', async () => {
  const awr = scripted({ 'client show': () => ({ binding: null }), 'client bind': () => ({ binding: { session_id: 'S1' } }) })
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'c1', workKey: 'X-1' })
  assert.equal(result.work.key, 'X-1')
  assert.ok(!awr.calls.some((c) => c[0] === 'status'))
})

// --- forks (DSH-016) ---------------------------------------------------------------------------

/** A scripted awr that knows these bindings (`external id -> session id`) and session statuses. */
function forkWorld({ bindings, statuses, failFrom = false }) {
  return scripted({
    'client show': (args) => ({ binding: bindings[flag(args, '--external-session')] ? { session_id: bindings[flag(args, '--external-session')] } : null }),
    'session show': (args) => ({ session: { status: statuses[args[2]] ?? 'active' } }),
    status: () => ({ current: [{ key: 'W-1', claims: [] }], ready: [] }),
    'client bind': (args) => {
      if (failFrom && args.includes('--from-session')) throw new AwrError('failed', 'nope', { code: 'InvalidInput', awrMessage: 'nope' })
      return { binding: { session_id: 'FORK' } }
    },
  })
}
const parentOf = (id) => async () => ({ conversationId: id })

test('a fork of a conversation whose AWR session has ended continues that session', async () => {
  const awr = forkWorld({ bindings: { 'dsh:parent': 'P1' }, statuses: { P1: 'interrupted' } })
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'child', forkOf: parentOf('parent') })
  assert.deepEqual(result, { outcome: 'created', sessionId: 'FORK', externalSession: 'dsh:child', work: { key: 'W-1', why: 'in_progress' }, successorOf: 'P1', fork: { parentConversation: 'parent', parentSession: 'P1', mode: 'continued' } })
  const bind = awr.calls.find((c) => c[1] === 'bind')
  assert.equal(flag(bind, '--from-session'), 'P1')
  assert.equal(flag(bind, '--external-session'), 'dsh:child')
  assert.ok(!bind.includes('--claim') && !bind.includes('--session'))
})

test('a fork of a conversation that is still going gets its own session and the parent\'s is not touched', async () => {
  const awr = forkWorld({ bindings: { 'dsh:parent': 'P1' }, statuses: { P1: 'active' } })
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'child', forkOf: parentOf('parent') })
  assert.equal(result.outcome, 'created')
  assert.deepEqual(result.fork, { parentConversation: 'parent', parentSession: 'P1', mode: 'parent_active' })
  assert.equal(result.successorOf, undefined)
  const bind = awr.calls.find((c) => c[1] === 'bind')
  assert.ok(!bind.includes('--from-session'), '--from-session would interrupt the parent session and close its claims')
  assert.ok(!bind.includes('--session'), 'nor is the parent\'s session shared')
})

test('the newest generation of the parent is the one that counts', async () => {
  const awr = forkWorld({ bindings: { 'dsh:parent': 'P1', 'dsh:parent#2': 'P2' }, statuses: { P1: 'interrupted', P2: 'active' } })
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'child', forkOf: parentOf('parent') })
  assert.deepEqual(result.fork, { parentConversation: 'parent', parentSession: 'P2', mode: 'parent_active' })
  assert.deepEqual(await latestBinding(awr, '/p', 'parent'), { externalSession: 'dsh:parent#2', sessionId: 'P2', status: 'active' })
  assert.equal(await latestBinding(awr, '/p', 'nobody'), undefined)
})

test('a fork binds to the work its live parent has claimed, which a plain choice would skip', async () => {
  const claimed = scripted({
    'client show': (args) => ({ binding: args.includes('dsh:parent') ? { session_id: 'P1' } : null }),
    'session show': () => ({ session: { status: 'active' } }),
    status: () => ({ current: [{ key: 'W-1', claims: [{ agent: 'x', session: 'P1' }] }], ready: [] }),
    'client bind': () => ({ binding: { session_id: 'FORK' } }),
  })
  const result = await bindConversation(claimed, { projectRoot: '/p', conversationId: 'child', forkOf: parentOf('parent') })
  assert.equal(result.outcome, 'created')
  assert.deepEqual(result.work, { key: 'W-1', why: 'parent_claim' })
  assert.equal(flag(claimed.calls.find((c) => c[1] === 'bind'), '--work'), 'W-1')
  // someone else's claim is not the parent's work
  assert.equal(workClaimedBy({ current: [{ key: 'W-1', claims: [{ session: 'S9' }] }] }, 'P1'), undefined)
  assert.equal(workClaimedBy({ blocked: [{ key: 'W-7', claims: [{ session: 'P1' }] }] }, 'P1'), 'W-7')
  assert.equal(workClaimedBy(undefined, 'P1'), undefined)
  // an explicit work key still wins
  const explicit = await bindConversation(claimed, { projectRoot: '/p', conversationId: 'child2', forkOf: parentOf('parent'), workKey: 'X-1' })
  assert.deepEqual(explicit.work, { key: 'X-1', why: 'requested' })
})

test('a fork whose parent was never bound is bound as a new conversation', async () => {
  const awr = forkWorld({ bindings: {}, statuses: {} })
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'child', forkOf: parentOf('parent') })
  assert.equal(result.outcome, 'created')
  assert.equal(result.sessionId, 'FORK')
  assert.deepEqual(result.fork, { parentConversation: 'parent', mode: 'parent_unbound' })
  assert.ok(!awr.calls.find((c) => c[1] === 'bind').includes('--from-session'))
})

test('no parent found, a resolver that throws, or no resolver all bind a new conversation exactly as before', async () => {
  for (const forkOf of [async () => undefined, async () => { throw new Error('lookup failed') }, undefined]) {
    const awr = forkWorld({ bindings: { 'dsh:parent': 'P1' }, statuses: { P1: 'interrupted' } })
    const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'child', forkOf })
    assert.deepEqual(result, { outcome: 'created', sessionId: 'FORK', externalSession: 'dsh:child', work: { key: 'W-1', why: 'in_progress' } })
    assert.ok(!awr.calls.some((c) => c[0] === 'session'), 'the parent is not even looked at')
  }
})

test('when awr refuses the continuation the fork is still bound, with its own session and the reason', async () => {
  const awr = forkWorld({ bindings: { 'dsh:parent': 'P1' }, statuses: { P1: 'interrupted' }, failFrom: true })
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'child', forkOf: parentOf('parent') })
  assert.equal(result.outcome, 'created')
  assert.equal(result.fork.mode, 'continuation_failed')
  assert.equal(result.fork.parentSession, 'P1')
  assert.match(result.fork.reason, /nope/)
  assert.equal(result.successorOf, undefined)
  assert.equal(awr.calls.filter((c) => c[1] === 'bind').length, 2, 'the continuation, then the plain bind')
})

test('an unreadable parent binding does not fail the fork\'s own binding', async () => {
  const awr = forkWorld({ bindings: {}, statuses: {} })
  const run = awr.run.bind(awr)
  awr.run = async (root, args) => {
    if (args[0] === 'client' && args[1] === 'show' && args.includes('dsh:parent')) throw new AwrError('failed', 'disk', { code: 'Storage', awrMessage: 'disk' })
    return run(root, args)
  }
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'child', forkOf: parentOf('parent') })
  assert.equal(result.outcome, 'created')
  assert.equal(result.fork.mode, 'lookup_failed')
})

test('a fork whose own session ended continues that session, not its parent\'s', async () => {
  const awr = forkWorld({ bindings: { 'dsh:parent': 'P1', 'dsh:child': 'C1' }, statuses: { P1: 'interrupted', C1: 'interrupted' } })
  let asked = false
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'child', forkOf: async () => { asked = true; return { conversationId: 'parent' } } })
  assert.equal(asked, false, 'the parent matters for a new fork only')
  assert.equal(result.externalSession, 'dsh:child#2')
  assert.equal(result.successorOf, 'C1')
  assert.equal(result.fork, undefined)
  assert.equal(flag(awr.calls.find((c) => c[1] === 'bind'), '--from-session'), 'C1')
})

test('a conversation that is already bound is not looked into for a parent', async () => {
  const awr = forkWorld({ bindings: { 'dsh:child': 'S9' }, statuses: { S9: 'active' } })
  let asked = false
  const result = await bindConversation(awr, { projectRoot: '/p', conversationId: 'child', forkOf: async () => { asked = true; return { conversationId: 'parent' } } })
  assert.equal(result.outcome, 'existing')
  assert.equal(asked, false)
})

// --- the real awr, when the lab build is there -------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const lab = join(here, '..', '.local', 'awr-lab', 'bin', 'awr')
const real = existsSync(lab) ? test : test.skip

real('against the real awr: bind, resume, and continue after the session ended, never claiming', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-awr-bind-state-'))
  const root = mkdtempSync(join(tmpdir(), 'dsh-awr-bind-proj-'))
  t.after(() => {
    rmSync(state, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  const env = { ...process.env, AWR_LOCAL_HOME: state, AWR_LOCAL_WEB: '0', PATH: `${dirname(lab)}:${process.env.PATH}` }
  const cli = (...args) => JSON.parse(execFileSync(lab, ['--project', root, '--json', ...args], { env, encoding: 'utf8' }))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  cli('init', '--goal', 'Check the DSH binding against a real awr', '--accept')
  const awr = createAwr({ env })

  const first = await bindConversation(awr, { projectRoot: root, conversationId: 'conv-1', model: 'deepseek-flash' })
  assert.equal(first.outcome, 'created')
  assert.equal(first.externalSession, 'dsh:conv-1')
  const session = cli('session', 'show', first.sessionId)
  assert.equal((session.session ?? session).status, 'active')
  assert.deepEqual(session.claims ?? [], [], 'binding must not take a claim')

  const resumed = await bindConversation(awr, { projectRoot: root, conversationId: 'conv-1' })
  assert.deepEqual([resumed.outcome, resumed.sessionId], ['existing', first.sessionId])
  assert.equal(cli('session', 'list', '--active').sessions.length, 1, 'resuming must not add a session')

  const revision = cli('status').project_revision
  cli('session', 'end', '--session', first.sessionId, '--outcome', 'interrupted', '--expected-revision', String(revision))
  const next = await bindConversation(awr, { projectRoot: root, conversationId: 'conv-1' })
  assert.equal(next.outcome, 'created')
  assert.equal(next.externalSession, 'dsh:conv-1#2')
  assert.equal(next.successorOf, first.sessionId)
  assert.notEqual(next.sessionId, first.sessionId)
})

real("against the real awr: binding next to another session's claim leaves that claim alone", async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-awr-bind-state-'))
  const root = mkdtempSync(join(tmpdir(), 'dsh-awr-bind-proj-'))
  t.after(() => {
    rmSync(state, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  const env = { ...process.env, AWR_LOCAL_HOME: state, AWR_LOCAL_WEB: '0', PATH: `${dirname(lab)}:${process.env.PATH}` }
  const cli = (...args) => JSON.parse(execFileSync(lab, ['--project', root, '--json', ...args], { env, encoding: 'utf8' }))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  cli('init', '--goal', 'Check binding beside another session claim', '--accept')
  const owner = cli('session', 'start', '--work', 'INTAKE-001', '--agent', 'someone-else', '--provider', 'test', '--model', 'test', '--claim', '--ttl-ms', '600000', '--expected-revision', String(cli('status').project_revision))
  const ownerId = owner.session.id
  const before = cli('session', 'show', ownerId).claims

  const awr = createAwr({ env })
  // chooseWork skips claimed work; an explicit key shows that even then nothing is taken over.
  assert.equal((await bindConversation(awr, { projectRoot: root, conversationId: 'beside-1' })).outcome, 'skipped')
  const bound = await bindConversation(awr, { projectRoot: root, conversationId: 'beside-1', workKey: 'INTAKE-001' })
  assert.equal(bound.outcome, 'created')
  assert.notEqual(bound.sessionId, ownerId)
  assert.deepEqual(cli('session', 'show', bound.sessionId).claims ?? [], [], 'the bound session holds no claim')
  const after = cli('session', 'show', ownerId).claims
  assert.deepEqual(after.map((c) => [c.id, c.status]), before.map((c) => [c.id, c.status]), 'the other session keeps its claim')
  assert.equal(after[0].status, 'active')
})

real('against the real awr: a fork continues an ended parent session, and leaves a live parent session and its claim alone', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-awr-fork-state-'))
  const root = mkdtempSync(join(tmpdir(), 'dsh-awr-fork-proj-'))
  t.after(() => {
    rmSync(state, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  const env = { ...process.env, AWR_LOCAL_HOME: state, AWR_LOCAL_WEB: '0', PATH: `${dirname(lab)}:${process.env.PATH}` }
  const cli = (...args) => JSON.parse(execFileSync(lab, ['--project', root, '--json', ...args], { env, encoding: 'utf8' }))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  cli('init', '--goal', 'Check forked conversations against a real awr', '--accept')
  const awr = createAwr({ env })
  const rev = () => String(cli('status').project_revision)

  // A live parent with a claim on its session.
  const parent = await bindConversation(awr, { projectRoot: root, conversationId: 'parent-live' })
  assert.equal(parent.outcome, 'created')
  cli('work', 'claim', parent.work.key, '--session', parent.sessionId, '--expected-revision', rev())
  const claimBefore = cli('session', 'show', parent.sessionId).claims.map((c) => [c.id, c.status])
  assert.deepEqual(claimBefore.map((c) => c[1]), ['active'])

  const live = await bindConversation(awr, { projectRoot: root, conversationId: 'fork-of-live', forkOf: parentOf('parent-live') })
  assert.equal(live.outcome, 'created')
  assert.equal(live.fork.mode, 'parent_active')
  assert.notEqual(live.sessionId, parent.sessionId)
  const shownParent = cli('session', 'show', parent.sessionId)
  assert.equal(shownParent.session.status, 'active', 'the live parent session stays active')
  assert.deepEqual(shownParent.claims.map((c) => [c.id, c.status]), claimBefore, 'and keeps its claim')
  assert.equal(shownParent.resumed_successor, null)
  assert.deepEqual(cli('session', 'show', live.sessionId).claims ?? [], [], 'the fork takes no claim')

  // A parent whose session ended: the fork continues it, and session show on the parent names the successor.
  const ended = await bindConversation(awr, { projectRoot: root, conversationId: 'parent-ended', workKey: 'INTAKE-001' })
  cli('session', 'end', '--session', ended.sessionId, '--outcome', 'interrupted', '--expected-revision', rev())
  const continued = await bindConversation(awr, { projectRoot: root, conversationId: 'fork-of-ended', forkOf: parentOf('parent-ended'), workKey: 'INTAKE-001' })
  assert.equal(continued.outcome, 'created')
  assert.deepEqual(continued.fork, { parentConversation: 'parent-ended', parentSession: ended.sessionId, mode: 'continued' })
  assert.equal(continued.successorOf, ended.sessionId)
  assert.equal(cli('session', 'show', ended.sessionId).resumed_successor.id, continued.sessionId)
  assert.equal(cli('session', 'show', continued.sessionId).session.status, 'active')
  assert.deepEqual(cli('session', 'show', continued.sessionId).claims ?? [], [], 'a continuation carries no claim')
  // A parent that was never bound: the fork is an ordinary new conversation.
  const orphan = await bindConversation(awr, { projectRoot: root, conversationId: 'fork-of-unbound', forkOf: parentOf('never-bound'), workKey: 'INTAKE-001' })
  assert.equal(orphan.outcome, 'created')
  assert.deepEqual(orphan.fork, { parentConversation: 'never-bound', mode: 'parent_unbound' })
  assert.equal(orphan.successorOf, undefined)
  assert.equal(cli('session', 'show', orphan.sessionId).session.status, 'active')
  // The fork is bound for its own id from now on: a resumed fork reuses it and asks nobody.
  assert.equal((await bindConversation(awr, { projectRoot: root, conversationId: 'fork-of-ended', forkOf: async () => { throw new Error('must not be asked') } })).outcome, 'existing')
})
