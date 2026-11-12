// The project's progress for the page in DeepSeek Harness (DSH-062), made from `awr overview snapshot`.
//
// AWR's own Project Progress Overview shows a project as a node graph, a mainline graph and swimlanes. This file turns the
// snapshot it reads (`work_graph`, `nav.mainline_graph`, `goals`, `sessions`) into what the page draws: nodes with a state a
// person understands (done, being worked on, ready to start, blocked, waiting, planned), the dependencies between them, the
// mainlines (the groups AWR's overview makes from the prefix of the work keys: DSH-012 belongs to DSH), the counts, and
// what needs the person's attention. Nothing here is invented: a node is as AWR reports it, and what AWR does not report
// is left out.
//
// The page shows business words first. Identifiers, revisions and source locations are kept apart in `tech`, for the
// "technical details" a person opens on purpose.

/** The shape of the view. The page takes a file of another shape for no file and asks the host to write it again. */
export const PROGRESS_SCHEMA = 1

/** The state of a work item as a person would name it. */
export const STATES = ['active', 'blocked', 'ready', 'waiting', 'planned', 'done', 'cancelled']

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
const list = (value) => (Array.isArray(value) ? value : [])

/** The state of one node: AWR's own facts, in the order a person would look at them. */
export function stateOf(node, mainline) {
  if (node.archived || node.status === 'cancelled' || node.status === 'closed_without_completion') return 'cancelled'
  if (node.status === 'completed') return 'done'
  if (text(node.blocker ?? mainline?.blocker)) return 'blocked'
  if (node.status === 'in_progress' || list(node.active_claims).length > 0) return 'active'
  if (node.ready === true) return 'ready'
  if (list(mainline?.explainable_waits).length > 0) return 'waiting'
  return 'planned'
}

/** A key AWR generated (`WORK-5fba…`, `md-01da…`) says nothing about a mainline; a key a person wrote (`DSH-058`) does. */
const GENERATED_KEY = /^[A-Za-z]+-[0-9a-f]{12,}$/
const LEADING_ID = /^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\s*[:：]/
/** The mainline lanes smaller than this are shown together as "other". */
const SMALL_LANE = 3
export const OTHER_LANE = '~other'

/**
 * The mainline of a work item: the prefix of its key (`AWR-TF-014` → `AWR-TF`). A generated key has no prefix of its own,
 * so the identifier its title starts with is used when there is one (`DSH-058: Claim…` → `DSH`).
 */
export function mainlineOf(key, title) {
  const named = GENERATED_KEY.test(String(key)) ? LEADING_ID.exec(String(title ?? ''))?.[1] : String(key)
  if (!named || !named.includes('-')) return OTHER_LANE
  return named.slice(0, named.lastIndexOf('-'))
}

/** A key AWR made up for work that came from a Markdown item, wherever it turns up inside a sentence. */
const GENERATED_IN_TEXT = /\b[A-Za-z]+-[0-9a-f]{12,}\b/g
/** What AWR writes for work with no acceptance criteria of its own: the work's key and its title, again. */
const PLACEHOLDER_OUTCOME = /^accepted completion of (\S+) [—–-] /

/**
 * What a piece of work is done when, for a person. AWR words work without criteria as "accepted completion of <key> —
 * <title>"; for work that came from a Markdown item the key is a generated hash. That is no criterion (the card already
 * says the title), so it is left out, and the drawer shows no "done when" at all. A criterion somebody wrote is kept as it
 * is, only a generated key inside it is taken out.
 */
export function outcomesOf(outcomes, key) {
  const shown = []
  for (const outcome of list(outcomes)) {
    const given = String(outcome)
    if (PLACEHOLDER_OUTCOME.exec(given)?.[1] === key) continue
    const kept = text(given.replace(GENERATED_IN_TEXT, '').replace(/\s{2,}/g, ' '))
    if (kept) shown.push(kept)
  }
  return shown
}

/** The file a node comes from, without the directory: `work-ledger.yaml`. */
const sourceName = (ref) => {
  const locator = text(ref?.locator)
  return locator ? decodeURIComponent(locator.split('/').pop() ?? locator) : undefined
}

/**
 * The layer of each node: 0 for a node that depends on nothing, one more than its deepest dependency otherwise. A cycle
 * (AWR reports it, and the page says so) does not loop: a node already being measured counts as layer 0.
 */
export function layers(keys, dependsOn) {
  const memo = new Map()
  const visiting = new Set()
  const depth = (key) => {
    if (memo.has(key)) return memo.get(key)
    if (visiting.has(key)) return 0
    visiting.add(key)
    let deepest = -1
    for (const dependency of dependsOn.get(key) ?? []) deepest = Math.max(deepest, depth(dependency))
    visiting.delete(key)
    memo.set(key, deepest + 1)
    return deepest + 1
  }
  for (const key of keys) depth(key)
  return memo
}

/**
 * @param {object} snapshot the answer of `awr overview snapshot --json`
 * @param {{ now?: number }} [options]
 */
export function buildProgress(snapshot, { now = Date.now() } = {}) {
  const graph = snapshot?.work_graph
  if (!graph || !Array.isArray(graph.nodes)) return { ok: false, reason: 'no_graph', updatedAt: now }
  const mainline = new Map(list(snapshot?.nav?.mainline_graph?.nodes).map((node) => [node.work_key, node]))
  const edges = list(graph.edges).filter((edge) => edge?.from && edge?.to)
  const dependsOn = new Map()
  const unlocks = new Map()
  for (const { from, to } of edges) {
    dependsOn.set(from, [...(dependsOn.get(from) ?? []), to])
    unlocks.set(to, [...(unlocks.get(to) ?? []), from])
  }
  // Mainlines with only an item or two would each take a lane of their own; they are shown together.
  const sizes = new Map()
  for (const node of graph.nodes) {
    const lane = mainlineOf(node.key, node.title)
    sizes.set(lane, (sizes.get(lane) ?? 0) + 1)
  }
  const laneOf = (node) => {
    const lane = mainlineOf(node.key, node.title)
    return lane !== OTHER_LANE && sizes.get(lane) >= SMALL_LANE ? lane : OTHER_LANE
  }
  const nodes = graph.nodes.map((node) => {
    const line = mainline.get(node.key)
    const state = stateOf(node, line)
    const outcomes = outcomesOf(line?.outcomes, node.key)
    return {
      key: node.key,
      title: text(node.title) ?? node.key,
      state,
      lane: laneOf(node),
      ...(text(node.next_action ?? line?.next_action) ? { next: text(node.next_action ?? line?.next_action) } : {}),
      ...(text(node.blocker ?? line?.blocker) ? { blocker: text(node.blocker ?? line?.blocker) } : {}),
      ...(outcomes.length ? { outcomes } : {}),
      ...(list(node.active_claims).length ? { claimed: true } : {}),
      ...(Number.isFinite(node.last_event_at) ? { changedAt: node.last_event_at } : {}),
      tech: { key: node.key, ...(sourceName(node.source_ref) ? { source: sourceName(node.source_ref) } : {}), ...(node.source_ref?.pointer ? { where: node.source_ref.pointer } : {}) },
    }
  })
  const known = new Set(nodes.map((node) => node.key))
  const kept = edges.filter(({ from, to }) => known.has(from) && known.has(to))
  const layerOf = layers(nodes.map((node) => node.key), dependsOn)
  for (const node of nodes) {
    node.layer = layerOf.get(node.key) ?? 0
    node.dependsOn = [...new Set(dependsOn.get(node.key) ?? [])].filter((key) => known.has(key))
    node.unlocks = [...new Set(unlocks.get(node.key) ?? [])].filter((key) => known.has(key))
  }
  const live = nodes.filter((node) => node.state !== 'cancelled')
  const count = (state) => live.filter((node) => node.state === state).length
  // The mainlines in the order their first item appears, "other" last, each with how much of it is done.
  const lanes = []
  for (const node of live) {
    let lane = lanes.find((item) => item.id === node.lane)
    if (!lane) lanes.push((lane = { id: node.lane, total: 0, done: 0 }))
    lane.total += 1
    if (node.state === 'done') lane.done += 1
  }
  lanes.sort((a, b) => (a.id === OTHER_LANE) - (b.id === OTHER_LANE))
  const goals = list(snapshot?.goals?.hits).map((goal) => ({ title: text(goal.title) ?? goal.external_key, status: goal.status ?? 'unknown' }))
  const activeSessions = list(snapshot?.sessions?.sessions).filter((session) => session?.status === 'active').length
  return {
    ok: true,
    schema: PROGRESS_SCHEMA,
    updatedAt: now,
    project: text(snapshot?.nav?.project?.name) ?? text(snapshot?.nav?.project?.external_key) ?? '',
    goals,
    counts: {
      total: live.length,
      done: count('done'),
      active: count('active'),
      ready: count('ready'),
      blocked: count('blocked'),
      waiting: count('waiting'),
      planned: count('planned'),
      sessions: activeSessions,
    },
    lanes,
    nodes,
    edges: kept.map(({ from, to, required }) => ({ from, to, required: required !== false })),
    hasCycle: list(graph.cycle).length > 0,
    // What a person has to look at: work AWR says is stuck, and goals nobody has confirmed yet.
    attention: [
      ...live.filter((node) => node.state === 'blocked').map((node) => ({ kind: 'blocked', key: node.key, title: node.title, detail: node.blocker })),
      ...goals.filter((goal) => goal.status === 'candidate' || goal.status === 'draft').map((goal) => ({ kind: 'goal', title: goal.title })),
    ],
    tech: {
      revision: snapshot?.project_revision ?? null,
      ...(snapshot?.version != null ? { snapshotVersion: snapshot.version } : {}),
      sourceRefreshed: snapshot?.basis?.source_refresh_performed === true,
      graphValid: graph.graph_valid !== false,
      ...(snapshot?.nav?.project?.id ? { projectId: snapshot.nav.project.id } : {}),
    },
  }
}
