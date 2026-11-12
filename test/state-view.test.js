// The AWR state shown in the panel (DSH-051): what it holds, and that it agrees with `awr status`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AwrError, createAwr } from '../lib/awr-runtime.js'
import { bindConversation } from '../lib/binding.js'
import { createAwrCommand } from '../lib/commands.js'
import { buildStateView, formatStateView } from '../lib/state-view.js'

const STATUS = {
  project: 'proj',
  project_id: 'P1',
  project_revision: 40,
  counts: { in_progress: 1, ready: 1, planned: 3 },
  current: [{ key: 'W-1', title: 'Do one', status: 'in_progress', next_action: 'Draft it', claims: [{ agent: 'me', session: 'S1' }, { agent: 'other', session: 'S9' }] }],
  ready: [{ key: 'W-2', title: 'Do two', status: 'planned', next_action: 'Then this', claims: [] }],
  blocked: [{ key: 'W-3', title: 'Do three', status: 'blocked', blocker: 'waiting for the owner', claims: [] }],
  waiting: [{ key: 'W-4', title: 'Do four', status: 'planned', claims: [] }],
  next_action: 'Draft it',
}
const WORKS = {
  'W-1': { id: 'ID-1', external_key: 'W-1', title: 'Do one', status: 'in_progress', next_action: 'Draft it', blocker: null, ready: false, active_claims: [{ session_id: 'S1', expires_at: 5_000_000 }, { session_id: 'S9', expires_at: null }] },
  'W-3': { id: 'ID-3', external_key: 'W-3', title: 'Do three', status: 'blocked', next_action: 'Ask', blocker: 'waiting for the owner', ready: false, active_claims: [] },
}
function scripted({ failWork = false, sessionClaims, compile } = {}) {
  const calls = []
  return {
    calls,
    async run(root, args) {
      calls.push(args.join(' '))
      if (args[0] === 'status') return STATUS
      if (args[0] === 'session') return { session: { id: 'S1', status: 'active', started_at: 1000 }, claims: sessionClaims ?? [{ status: 'active', work_item_id: 'ID-1', acquired_at: 2000, expires_at: 5_000_000 }, { status: 'released', work_item_id: 'ID-3', acquired_at: 1, expires_at: null }] }
      if (args[0] === 'context') {
        if (compile) return compile()
        throw new Error('compile was not expected')
      }
      if (args[0] === 'work') {
        if (failWork) throw new AwrError('failed', 'NotFound: x', { code: 'NotFound' })
        return { work: WORKS[args[2]] }
      }
      throw new Error(`unexpected: ${args.join(' ')}`)
    },
  }
}

test('the view carries the bound work, the claim with its expiry, the blockers, and the lists of awr status', async () => {
  const awr = scripted()
  const view = await buildStateView(awr, { projectRoot: '/p', sessionId: 'S1', work: { key: 'W-1' } })
  assert.deepEqual(view.project, { name: 'proj', id: 'P1', root: '/p', revision: 40 })
  assert.deepEqual(view.counts, STATUS.counts)
  assert.deepEqual(view.session, { id: 'S1', status: 'active', started_at: 1000, ended_at: null })
  assert.deepEqual(view.bound_work, { key: 'W-1', title: 'Do one', status: 'in_progress', next_action: 'Draft it', blocker: null, ready: false })
  assert.deepEqual(view.claims, [{ work: 'W-1', acquired_at: 2000, expires_at: 5_000_000, this_session: true }], 'the claim of this session, with the expiry work show reports')
  assert.deepEqual(view.in_progress[0].claimed_by, [{ agent: 'me', session: 'S1', this_conversation: true }, { agent: 'other', session: 'S9', this_conversation: false }])
  assert.equal(view.blocked[0].blocker, 'waiting for the owner')
  assert.deepEqual([view.in_progress, view.ready, view.blocked, view.waiting].map((l) => l.map((w) => w.key)), [['W-1'], ['W-2'], ['W-3'], ['W-4']])
  assert.equal(view.next_action, 'Draft it')
  assert.ok(!awr.calls.some((c) => c.startsWith('context')), 'a binding that knows its work key does not compile')
})

test('the queues are a sample: the totals are those AWR counts, and an older awr that counts none gets the length of the list', async () => {
  const counted = scripted()
  const original = counted.run.bind(counted)
  counted.run = async (root, args) => (args[0] === 'status' ? { ...STATUS, current_total: 24, ready_count: 23, blocked_count: 39, waiting_count: 32 } : original(root, args))
  const view = await buildStateView(counted, { projectRoot: '/p' })
  assert.deepEqual(view.totals, { active: 24, ready: 23, blocked: 39, waiting: 32 })
  assert.equal(view.ready.length, 1, 'the list is still the sample AWR gave')
  assert.match(formatStateView(view), /24 in progress, 23 ready, 39 blocked, 32 waiting/, 'the typed state says how much there is, not how much was listed')
  const older = await buildStateView(scripted(), { projectRoot: '/p' })
  assert.deepEqual(older.totals, { active: 1, ready: 1, blocked: 1, waiting: 1 })
})

test('whether AWR will start work yet, and why it holds work back, are passed on as awr gave them', async () => {
  const held = scripted()
  const original = held.run.bind(held)
  held.run = async (root, args) => (args[0] === 'status'
    ? { ...STATUS, organization: { business_execution_ready: false, project_gap_total: 8, current_gap_total: 5, state: 'needs_organization' }, blocked: [{ key: 'W-8', title: 'Search', status: 'planned', blocker: null, structural_codes: ['work_structure_incomplete', 'work_goal_missing'] }] }
    : original(root, args))
  const view = await buildStateView(held, { projectRoot: '/p' })
  assert.deepEqual(view.organization, { ready: false, gaps: 8 })
  assert.deepEqual(view.blocked[0].structural, ['work_structure_incomplete', 'work_goal_missing'])
  assert.equal('blocker' in view.blocked[0], false, 'nothing is recorded as the obstacle')
  const ready = scripted()
  const next = ready.run.bind(ready)
  ready.run = async (root, args) => (args[0] === 'status' ? { ...STATUS, organization: { business_execution_ready: true, current_gap_total: 12 } } : next(root, args))
  assert.deepEqual((await buildStateView(ready, { projectRoot: '/p' })).organization, { ready: true, gaps: 12 }, 'without a project total, the gaps that matter now')
  assert.equal('organization' in (await buildStateView(scripted(), { projectRoot: '/p' })), false, 'an awr that says nothing about it is not made to')
})

test('a claim without an expiry says so; a session that holds nothing has no claims; an unbound conversation has only the project', async () => {
  const noExpiry = scripted()
  const original = noExpiry.run.bind(noExpiry)
  noExpiry.run = async (root, args) => (args[0] === 'work' && args[2] === 'W-1' ? { work: { ...WORKS['W-1'], active_claims: [{ session_id: 'S1', expires_at: null }] } } : original(root, args))
  const none = await buildStateView(noExpiry, { projectRoot: '/p', sessionId: 'S1', work: { key: 'W-1' } })
  assert.equal(none.claims[0].expires_at, null)
  assert.match(formatStateView(none), /Claim on W-1: no expiry/)
  const emptyStatus = scripted()
  const originalStatus = emptyStatus.run.bind(emptyStatus)
  emptyStatus.run = async (root, args) => (args[0] === 'status' ? { ...STATUS, current: [{ ...STATUS.current[0], claims: [] }] } : originalStatus(root, args))
  const empty = await buildStateView(emptyStatus, { projectRoot: '/p', sessionId: 'S1', work: { key: 'W-1' } })
  assert.deepEqual(empty.claims, [])
  assert.match(formatStateView(empty), /This session holds no claim/)
  const unbound = await buildStateView(scripted(), { projectRoot: '/p' })
  assert.equal(unbound.session, null)
  assert.equal(unbound.bound_work, null)
  assert.match(formatStateView(unbound), /not bound to an AWR session/)
  assert.match(formatStateView(unbound), /Blocked: W-3: waiting for the owner/)
})

test('when a work item cannot be read the view still has everything else', async () => {
  const view = await buildStateView(scripted({ failWork: true }), { projectRoot: '/p', sessionId: 'S1', work: { key: 'W-1' } })
  assert.equal(view.bound_work.key, 'W-1', 'the key the binding knew')
  assert.equal(view.bound_work.title, null)
  assert.equal(view.claims[0].work, 'W-1')
  assert.equal(view.claims[0].expires_at, null, 'unknown rather than guessed')
  assert.equal(view.in_progress.length, 1)
  assert.match(formatStateView(view), /Claim on W-1/)
})

test('a conversation resumed from an earlier run has no work key in its binding; the compiled context names the work, also when AWR calls it incomplete', async () => {
  const complete = await buildStateView(scripted({ compile: () => ({ work_context: { identity: { work_item_key: 'W-1' } } }) }), { projectRoot: '/p', sessionId: 'S1' })
  assert.equal(complete.bound_work.key, 'W-1')
  const incomplete = await buildStateView(scripted({ compile: () => { throw new AwrError('failed', 'ContextIncomplete: x', { code: 'ContextIncomplete', awrDocument: { work_context: { identity: { work_item_key: 'W-1' } } } }) } }), { projectRoot: '/p', sessionId: 'S1' })
  assert.equal(incomplete.bound_work.key, 'W-1')
  const unknown = await buildStateView(scripted({ compile: () => { throw new AwrError('failed', 'NotFound: x', { code: 'NotFound' }) } }), { projectRoot: '/p', sessionId: 'S1' })
  assert.equal(unknown.bound_work, null)
})

test('/awr state answers in words or as JSON, for a bound conversation only', async () => {
  const awr = scripted()
  const bindings = { get: (id) => (id === 'c1' ? Promise.resolve({ projectRoot: '/p', outcome: 'created', sessionId: 'S1', work: { key: 'W-1' } }) : undefined) }
  const command = createAwrCommand({ awr, bindings })
  const agent = { session: { id: 'c1' } }
  const json = await command({ agent, rawInput: 'state --json' })
  assert.equal(json.kind, 'success')
  assert.equal(JSON.parse(json.text).bound_work.key, 'W-1')
  assert.match((await command({ agent, rawInput: 'state' })).text, /Bound work: W-1 Do one \[in_progress\]; next: Draft it/)
  const outside = await command({ agent: { session: { id: 'nobody' } }, rawInput: 'state --json' })
  assert.equal(outside.kind, 'error')
  assert.match((await command({ agent, rawInput: 'help' })).text, /\/awr state/)
})

// --- the real awr -----------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const lab = join(here, '..', '.local', 'awr-lab', 'bin', 'awr')
const real = existsSync(lab) ? test : test.skip

real('against the real awr: the view agrees with awr status, shows the claim\'s expiry and the blocker', async (t) => {
  const local = mkdtempSync(join(tmpdir(), 'dsh-awr-state-local-'))
  const root = mkdtempSync(join(tmpdir(), 'dsh-awr-state-proj-'))
  t.after(() => {
    rmSync(local, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  const env = { ...process.env, AWR_LOCAL_HOME: local, AWR_LOCAL_WEB: '0', PATH: `${dirname(lab)}:${process.env.PATH}` }
  const cli = (...args) => JSON.parse(execFileSync(lab, ['--project', root, '--json', ...args], { env, encoding: 'utf8' }))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  cli('init', '--goal', 'Show the state in a panel', '--accept')
  const awr = createAwr({ env })
  const binding = { projectRoot: root, ...(await bindConversation(awr, { projectRoot: root, conversationId: 'conv-1' })) }
  assert.equal(binding.outcome, 'created')

  const agreesWithStatus = async (label) => {
    const view = await buildStateView(awr, binding)
    const status = cli('status')
    assert.equal(view.project.revision, status.project_revision, label)
    assert.equal(view.project.name, status.project, label)
    assert.deepEqual(view.counts, status.counts, label)
    for (const [list, source] of [['in_progress', 'current'], ['ready', 'ready'], ['blocked', 'blocked'], ['waiting', 'waiting']]) {
      assert.deepEqual(view[list].map((w) => w.key), (status[source] ?? []).map((w) => w.key), `${label}: ${list}`)
    }
    assert.equal(view.next_action, status.next_action, label)
    return view
  }

  const before = await agreesWithStatus('bound, no claim')
  assert.equal(before.bound_work.key, 'INTAKE-001')
  assert.deepEqual(before.claims, [])
  assert.equal(before.session.id, binding.sessionId)

  const claimed = cli('work', 'claim', 'INTAKE-001', '--session', binding.sessionId, '--ttl-ms', '3600000', '--expected-revision', String(cli('status').project_revision))
  const acquired = claimed.claim.acquired_at
  const withClaim = await agreesWithStatus('claimed')
  assert.equal(withClaim.claims.length, 1)
  assert.equal(withClaim.claims[0].work, 'INTAKE-001')
  assert.equal(withClaim.claims[0].expires_at, acquired + 3_600_000, 'the expiry awr set')
  assert.equal(withClaim.in_progress.concat(withClaim.ready, withClaim.blocked).find((w) => w.key === 'INTAKE-001').claimed_by[0].this_conversation, true)
  assert.match(formatStateView(withClaim), /Claim on INTAKE-001: expires \d{4}-/)

  cli('work', 'progress', 'INTAKE-001', '--session', binding.sessionId, '--reason', 'Started', '--next-action', 'Ask the owner', '--expected-revision', String(cli('status').project_revision))
  cli('work', 'block', 'INTAKE-001', '--session', binding.sessionId, '--reason', 'Waiting for the owner to name the goal', '--blocker', 'Waiting for the owner to name the goal', '--expected-revision', String(cli('status').project_revision))
  const blocked = await agreesWithStatus('blocked')
  assert.equal(blocked.bound_work.blocker, 'Waiting for the owner to name the goal')
  assert.ok(blocked.blocked.some((w) => w.key === 'INTAKE-001' && /owner/.test(w.blocker)))
  assert.match(formatStateView(blocked), /Blocked: INTAKE-001: Waiting for the owner/)

  cli('session', 'end', '--session', binding.sessionId, '--outcome', 'ended', '--expected-revision', String(cli('status').project_revision))
  const ended = await agreesWithStatus('ended')
  assert.equal(ended.session.status, 'ended')
  assert.deepEqual(ended.claims, [], 'released claims are not shown')
})
