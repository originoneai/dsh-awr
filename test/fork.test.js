// Finding the parent of a DSH fork by the history it inherited (DSH-016), against a stand-in for DSH's session query.
import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_CANDIDATES, describeFork, findForkParent, inheritedLength } from '../lib/fork.js'

const event = (seq, time, tag = 'a') => ({ type: 'x/event', seq, time, data: { n: seq, tag } })
/** Events 0..count-1, one second apart from `start`. */
const history = (start, count, tag) => Array.from({ length: count }, (_, i) => event(i, start + i * 1000, tag))

/**
 * What `ctx.sessionQuery` offers, with the two calls the lookup uses. A session is
 * `{ id, cwd, createdAt, events, inherited? }`; a fork's events begin with the parent's.
 */
function queryOf(sessions, { failing = [] } = {}) {
  const open = new Set()
  const reads = []
  return {
    reads,
    open,
    async listSessions() {
      return [...sessions].sort((a, b) => b.createdAt - a.createdAt).map((s) => ({ header: { id: s.id, cwd: s.cwd, createdAt: s.createdAt, isSeeded: (s.inherited ?? 0) > 0 }, live: true, persisted: true }))
    },
    async observeSession(id) {
      reads.push(id)
      if (failing.includes(id)) throw new Error(`cannot read ${id}`)
      const s = sessions.find((candidate) => candidate.id === id)
      if (!s) throw new Error(`no ${id}`)
      open.add(id)
      return { events: s.events, inheritedEventCount: s.inherited ?? 0, [Symbol.dispose]: () => open.delete(id) }
    },
  }
}
/** The `agent.session` of a fork as the plugin sees it. */
const sessionOf = (s) => ({ id: s.id, header: { id: s.id, cwd: s.cwd, createdAt: s.createdAt, isSeeded: (s.inherited ?? 0) > 0 }, inheritedEventCount: s.inherited ?? 0 })
/** A fork of `parent` cut after event `cut` (inclusive), plus the seed marker the host adds. */
const forkOf = (id, parent, cut, createdAt) => ({ id, cwd: parent.cwd, createdAt, inherited: cut + 1, events: [...parent.events.slice(0, cut + 1), { type: 'session/end-seed', seq: cut + 1, time: parent.events[cut].time, data: { inherited: true } }] })

const A = { id: 'A', cwd: '/p', createdAt: 1_000, events: history(1_002, 20, 'a') }

test('only a seeded session with an inherited prefix and no recorded parent is a fork', () => {
  const header = (extra) => ({ id: 'x', isSeeded: false, ...extra })
  assert.equal(inheritedLength({ header: header(), inheritedEventCount: 0 }), undefined, 'a new conversation')
  assert.equal(inheritedLength({ header: header({ isSeeded: true }), inheritedEventCount: 0 }), undefined, 'seeded but nothing inherited')
  assert.equal(inheritedLength({ header: header({ isSeeded: true, parentSession: 'P' }), inheritedEventCount: 5 }), undefined, 'a subagent names its parent')
  assert.equal(inheritedLength({ header: header({ isSeeded: false }), inheritedEventCount: 5 }), undefined)
  assert.equal(inheritedLength({ header: header({ isSeeded: true }), inheritedEventCount: 11 }), 11)
  assert.equal(inheritedLength(undefined), undefined)
  assert.equal(inheritedLength({}), undefined)
})

test('the parent is the other session whose own history is the inherited prefix', async () => {
  const noise = { id: 'N', cwd: '/p', createdAt: 5_000, events: history(5_002, 30, 'noise') }
  const elsewhere = { id: 'E', cwd: '/other', createdAt: 1_001, events: history(1_002, 20, 'a') }
  const child = forkOf('C', A, 9, 90_000)
  const query = queryOf([A, noise, elsewhere, child])
  const found = await findForkParent(query, sessionOf(child))
  assert.deepEqual(found, { conversationId: 'A', inherited: 10, examined: 2 })
  assert.equal(query.open.size, 0, 'every read is released')
  assert.ok(!query.reads.includes('E'), 'another working directory is not read')
})

test('a session that is not a fork reads nothing', async () => {
  const query = queryOf([A])
  assert.equal(await findForkParent(query, sessionOf(A)), undefined)
  assert.deepEqual(query.reads, [])
})

test('the same times and different data do not match', async () => {
  const impostor = { id: 'I', cwd: '/p', createdAt: 1_001, events: history(1_002, 20, 'other') }
  const child = forkOf('C', A, 9, 90_000)
  const query = queryOf([impostor, child])
  assert.equal(await findForkParent(query, sessionOf(child)), undefined)
  // and a parent that is shorter than the prefix cannot hold it
  const short = { ...A, events: A.events.slice(0, 5) }
  assert.equal(await findForkParent(queryOf([short, child]), sessionOf(child)), undefined)
})

test('a fork of a fork: inside the inherited part the owner is named, beyond it the fork itself', async () => {
  const B = forkOf('B', A, 9, 20_000)
  // B went on after the fork: its own events, then it was forked again.
  B.events = [...B.events, ...Array.from({ length: 6 }, (_, i) => event(B.events.length + i, 21_000 + i * 1000, 'b'))]
  const inside = forkOf('C1', B, 4, 30_000)
  const beyond = forkOf('C2', B, B.events.length - 1, 31_000)
  const query = queryOf([A, B, inside, beyond])
  assert.equal((await findForkParent(query, sessionOf(inside)))?.conversationId, 'A', 'those events are A\'s own; B only inherited them')
  assert.equal((await findForkParent(query, sessionOf(beyond)))?.conversationId, 'B')
})

test('a parent older than the newest sessions is still found through the session its prefix begins in', async () => {
  const newer = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => ({ id: `n${i}`, cwd: '/p', createdAt: 10_000 + i, events: history(10_002 + i, 5, `n${i}`) }))
  const child = forkOf('C', A, 9, 90_000)
  const query = queryOf([A, ...newer, child])
  const found = await findForkParent(query, sessionOf(child))
  assert.equal(found?.conversationId, 'A')
  assert.equal(found.examined, MAX_CANDIDATES + 1)
  assert.ok(query.reads.length <= MAX_CANDIDATES + 2, 'a bounded number of reads')
})

test('two sessions holding the same prefix as their own are ambiguous, so no parent is named', async () => {
  const twin = { id: 'T', cwd: '/p', createdAt: 1_001, events: structuredClone(A.events) }
  const child = forkOf('C', A, 9, 90_000)
  assert.equal(await findForkParent(queryOf([A, twin, child]), sessionOf(child)), undefined)
})

test('a read that fails skips that candidate; a failing listing is the caller\'s to handle', async () => {
  const child = forkOf('C', A, 9, 90_000)
  const other = { id: 'O', cwd: '/p', createdAt: 2_000, events: history(2_002, 12, 'o') }
  assert.equal((await findForkParent(queryOf([A, other, child], { failing: ['O'] }), sessionOf(child)))?.conversationId, 'A')
  const broken = queryOf([A, child])
  broken.listSessions = async () => { throw new Error('listing failed') }
  await assert.rejects(findForkParent(broken, sessionOf(child)), /listing failed/)
})

test('each outcome of a fork binding is described, and anything else is not', () => {
  const base = { parentConversation: 'A', parentSession: 'S1' }
  assert.match(describeFork({ ...base, mode: 'continued' }), /fork of DSH conversation A.*S1 had ended.*continues it/)
  assert.match(describeFork({ ...base, mode: 'parent_active' }), /S1 is still active.*own AWR session.*left as it is/)
  assert.match(describeFork({ ...base, mode: 'continuation_failed', reason: 'boom' }), /failed \(boom\).*own AWR session/)
  assert.match(describeFork({ parentConversation: 'A', mode: 'parent_unbound' }), /never bound to AWR/)
  assert.match(describeFork({ parentConversation: 'A', mode: 'lookup_failed', reason: 'x' }), /Reading that conversation's AWR binding failed \(x\)/)
  assert.equal(describeFork(undefined), undefined)
  assert.equal(describeFork({ parentConversation: 'A', mode: 'unknown' }), undefined)
})
