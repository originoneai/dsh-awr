// Binding logic against a scripted awr (what it would run) and, when the lab build is present,
// against the real thing on a disposable project.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAwr } from '../lib/awr-runtime.js'
import { bindConversation, chooseWork, externalId } from '../lib/binding.js'

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
