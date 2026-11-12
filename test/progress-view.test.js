// The project's progress for the page (DSH-062): AWR's snapshot turned into nodes a person understands.
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProgress, layers, mainlineOf, OTHER_LANE, outcomesOf, stateOf } from '../lib/progress-view.js'

const node = (key, patch = {}) => ({ key, title: `Work ${key}`, status: 'planned', ready: false, blocker: null, active_claims: [], archived: false, next_action: null, source_ref: { locator: 'file:///p/.awr/intake/work-ledger.yaml', pointer: `/work_items/${key}` }, ...patch })
const edge = (from, to, extra = {}) => ({ from, to, required: true, ...extra })
const snapshot = (nodes, edges = [], extra = {}) => ({
  version: 1,
  project_revision: 42,
  basis: { source_refresh_performed: false },
  work_graph: { nodes, edges, cycle: [], graph_valid: true },
  nav: { project: { name: 'demo', id: 'P1' }, mainline_graph: { nodes: [] } },
  goals: { hits: [] },
  sessions: { sessions: [] },
  ...extra,
})

test('a node is done, blocked, being worked on, ready, waiting or planned, in the order a person would look at it', () => {
  assert.equal(stateOf(node('a', { status: 'completed', blocker: 'old' })), 'done', 'completed beats a stale blocker text')
  assert.equal(stateOf(node('a', { blocker: 'waiting for the owner', status: 'in_progress' })), 'blocked')
  assert.equal(stateOf(node('a', { status: 'in_progress' })), 'active')
  assert.equal(stateOf(node('a', { active_claims: [{}] })), 'active', 'a claim means somebody works on it')
  assert.equal(stateOf(node('a', { ready: true })), 'ready')
  assert.equal(stateOf(node('a'), { explainable_waits: [{ reason: 'x' }] }), 'waiting')
  assert.equal(stateOf(node('a')), 'planned')
  assert.equal(stateOf(node('a', { archived: true })), 'cancelled')
  assert.equal(stateOf(node('a', { status: 'cancelled' })), 'cancelled')
  assert.equal(stateOf(node('a', { blocker: '   ' })), 'planned', 'a blank blocker is none')
})

test('layers: a node sits one step after its deepest dependency, and a cycle does not loop', () => {
  const dependsOn = new Map([['c', ['b', 'a']], ['b', ['a']]])
  const got = layers(['a', 'b', 'c', 'd'], dependsOn)
  assert.deepEqual([...got], [['a', 0], ['b', 1], ['c', 2], ['d', 0]].sort((x, y) => [...got.keys()].indexOf(x[0]) - [...got.keys()].indexOf(y[0])))
  const cyc = layers(['x', 'y'], new Map([['x', ['y']], ['y', ['x']]]))
  assert.ok(Number.isFinite(cyc.get('x')) && Number.isFinite(cyc.get('y')))
})

test('the view has the counts, the dependencies and what each node unlocks', () => {
  const view = buildProgress(snapshot(
    [node('A', { status: 'completed' }), node('B', { status: 'in_progress', next_action: 'Write the tests' }), node('C', { ready: true }), node('D', { blocker: 'The owner has to decide' }), node('E', { status: 'cancelled' })],
    [edge('B', 'A'), edge('C', 'B'), edge('D', 'B', { required: false })],
    { sessions: { sessions: [{ status: 'active' }, { status: 'ended' }] }, nav: { project: { name: 'demo' }, mainline_graph: { nodes: [] } } },
  ), { now: 1000 })
  assert.equal(view.ok, true)
  assert.equal(view.updatedAt, 1000)
  assert.equal(view.project, 'demo')
  assert.deepEqual(view.counts, { total: 4, done: 1, active: 1, ready: 1, blocked: 1, waiting: 0, planned: 0, sessions: 1 }, 'a cancelled item is not counted')
  const byKey = Object.fromEntries(view.nodes.map((n) => [n.key, n]))
  assert.deepEqual([byKey.A.layer, byKey.B.layer, byKey.C.layer, byKey.D.layer], [0, 1, 2, 2])
  assert.deepEqual(byKey.B.dependsOn, ['A'])
  assert.deepEqual(byKey.A.unlocks, ['B'])
  assert.deepEqual(byKey.B.unlocks.sort(), ['C', 'D'])
  assert.equal(byKey.B.next, 'Write the tests')
  assert.equal(byKey.D.blocker, 'The owner has to decide')
  assert.deepEqual(view.edges.find((e) => e.from === 'D'), { from: 'D', to: 'B', required: false })
})

test('what needs a person: blocked work and goals nobody confirmed', () => {
  const view = buildProgress(snapshot(
    [node('A', { blocker: 'Waiting for the API key' }), node('B', { status: 'completed' })],
    [],
    { goals: { hits: [{ external_key: 'g1', title: 'Search the portal', status: 'candidate' }, { external_key: 'g2', title: 'Ship it', status: 'active' }] } },
  ))
  assert.deepEqual(view.attention, [
    { kind: 'blocked', key: 'A', title: 'Work A', detail: 'Waiting for the API key' },
    { kind: 'goal', title: 'Search the portal' },
  ])
})

test('a mainline is the prefix of the key a person wrote; a generated key takes the identifier its title starts with', () => {
  assert.equal(mainlineOf('DSH-058', 'x'), 'DSH')
  assert.equal(mainlineOf('AWR-TF-014AN', 'x'), 'AWR-TF')
  assert.equal(mainlineOf('WORK-5fbaebd1b940cce21825828254ef68e6', 'DSH-058: Claim, checkpoint and end'), 'DSH')
  assert.equal(mainlineOf('WORK-5fbaebd1b940cce21825828254ef68e6', 'DSH-058：中文冒号也算'), 'DSH')
  assert.equal(mainlineOf('md-01da5526bf2dd4bcdcdb8025c57c2c24fcc89747307b1e6e452e330fc92b8694', 'Search endpoint'), OTHER_LANE, 'a generated key and a plain title name no mainline')
  assert.equal(mainlineOf('SOLO', 'x'), OTHER_LANE, 'a key without a prefix')
  assert.equal(mainlineOf('WORK-12', 'x'), 'WORK', 'a short number is a key a person wrote')
})

test('mainlines are listed in the order they appear with their progress; small ones are shown together, last', () => {
  const view = buildProgress(snapshot([
    node('TF-1', { status: 'completed' }), node('TF-2'), node('TF-3', { status: 'completed' }),
    node('ONE-1'),
    node('OBS-1'), node('OBS-2'), node('OBS-3', { status: 'completed' }),
    node('WORK-5fbaebd1b940cce21825828254ef68e6', { title: 'TF-4: late', status: 'cancelled' }),
    node('TWO-1'), node('TWO-2'),
  ]))
  assert.deepEqual(view.lanes, [
    { id: 'TF', total: 3, done: 2 },
    { id: 'OBS', total: 3, done: 1 },
    { id: OTHER_LANE, total: 3, done: 0 },
  ], 'ONE and TWO are too small for a lane of their own; the cancelled item is not counted')
  const byKey = Object.fromEntries(view.nodes.map((n) => [n.key, n]))
  assert.equal(byKey['TF-2'].lane, 'TF')
  assert.equal(byKey['ONE-1'].lane, OTHER_LANE)
  assert.equal(byKey['WORK-5fbaebd1b940cce21825828254ef68e6'].lane, 'TF', 'four items make TF, with the generated key counted by its title')
})

test('the mainline graph adds the acceptance and the waits to a node', () => {
  const view = buildProgress(snapshot([node('A-1'), node('A-2'), node('A-3')], [], {
    nav: {
      project: { name: 'demo' },
      mainline_graph: {
        nodes: [
          { work_key: 'A-1', outcomes: ['It runs', 'It is documented'], blocker: null, explainable_waits: [] },
          { work_key: 'A-2', outcomes: [], blocker: null, explainable_waits: [{ reason: 'depends' }] },
        ],
      },
    },
  }))
  const byKey = Object.fromEntries(view.nodes.map((n) => [n.key, n]))
  assert.deepEqual(byKey['A-1'].outcomes, ['It runs', 'It is documented'])
  assert.equal(byKey['A-2'].state, 'waiting')
  assert.equal(byKey['A-3'].state, 'planned')
})

test('work without criteria of its own shows no "done when": AWR\'s placeholder names a generated key and repeats the title', () => {
  const hashed = 'md-01da5526bf2dd4bcdcdb8025c57c2c24fcc89747307b1e6e452e330fc92b8694'
  const view = buildProgress(snapshot([node(hashed, { title: 'Search endpoint' }), node('DSH-058', { title: 'Claim from the panel' }), node('A-3', { title: 'Upload' })], [], {
    nav: {
      project: { name: 'demo' },
      mainline_graph: {
        nodes: [
          { work_key: hashed, outcomes: [`accepted completion of ${hashed} — Search endpoint`], explainable_waits: [] },
          { work_key: 'DSH-058', outcomes: ['accepted completion of DSH-058 — Claim from the panel'], explainable_waits: [] },
          { work_key: 'A-3', outcomes: ['accepted completion of SOMETHING-ELSE — Upload', 'A PDF can be uploaded'], explainable_waits: [] },
        ],
      },
    },
  }))
  const byKey = Object.fromEntries(view.nodes.map((n) => [n.key, n]))
  assert.equal('outcomes' in byKey[hashed], false, 'a generated hash is never shown')
  assert.equal('outcomes' in byKey['DSH-058'], false, 'the placeholder of a work that has a readable key says nothing either')
  assert.deepEqual(byKey['A-3'].outcomes, ['accepted completion of SOMETHING-ELSE — Upload', 'A PDF can be uploaded'], 'a sentence that names another key is somebody\'s own and stays')
  assert.ok(!JSON.stringify(view.nodes.map((n) => n.outcomes ?? [])).includes('md-01da'), 'no generated key is left in what the drawer lists')
})

test('a criterion somebody wrote is kept as written, with a generated key taken out of it', () => {
  assert.deepEqual(outcomesOf(['It runs', '  It is documented  '], 'A-1'), ['It runs', 'It is documented'])
  assert.deepEqual(outcomesOf(['Output matches md-0123456789abcdef0123 exactly', 'WORK-5fbaebd1b940cce21825828254ef68e6'], 'A-1'), ['Output matches exactly'], 'a criterion that was only a key is gone')
  assert.deepEqual(outcomesOf(['Ships with DSH-058 and AWR-TF-014'], 'A-1'), ['Ships with DSH-058 and AWR-TF-014'], 'a key a person wrote is not a hash')
  assert.deepEqual(outcomesOf(undefined, 'A-1'), [])
  assert.deepEqual(outcomesOf(['', '   '], 'A-1'), [])
})

test('the engineering facts are kept apart in tech, and the node itself carries business words', () => {
  const view = buildProgress(snapshot([node('A')], []))
  const [only] = view.nodes
  assert.equal(only.title, 'Work A')
  assert.deepEqual(only.tech, { key: 'A', source: 'work-ledger.yaml', where: '/work_items/A' })
  assert.equal(view.tech.revision, 42)
  assert.equal(view.tech.graphValid, true)
  assert.equal(view.tech.projectId, 'P1')
})

test('edges to unknown work are dropped, a cycle is reported, and a snapshot without a graph is not a view', () => {
  const view = buildProgress(snapshot([node('A'), node('B')], [edge('A', 'B'), edge('B', 'A'), edge('A', 'ZZZ')]))
  assert.equal(view.edges.length, 2, 'the edge to ZZZ is dropped')
  const cyclic = buildProgress(snapshot([node('A')], [], { work_graph: { nodes: [node('A')], edges: [], cycle: [['A', 'B']], graph_valid: false } }))
  assert.equal(cyclic.hasCycle, true)
  assert.equal(cyclic.tech.graphValid, false)
  assert.deepEqual(buildProgress({}, { now: 5 }), { ok: false, reason: 'no_graph', updatedAt: 5 })
  assert.deepEqual(buildProgress({ work_graph: {} }, { now: 5 }), { ok: false, reason: 'no_graph', updatedAt: 5 })
})

test('a project with no work at all is a valid, empty view', () => {
  const view = buildProgress(snapshot([], []))
  assert.equal(view.ok, true)
  assert.deepEqual(view.counts, { total: 0, done: 0, active: 0, ready: 0, blocked: 0, waiting: 0, planned: 0, sessions: 0 })
  assert.deepEqual(view.attention, [])
})
