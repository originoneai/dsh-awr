// The progress page beside Chat and Trajectory (DSH-062): the whole project in plain words and pictures, read from the
// file the host writes, with nothing put in the conversation.
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProgress } from '../lib/progress-view.js'
import { progressPath } from '../lib/progress.js'
import { loadClient, settle, textOf } from '../test-support/client-harness.js'

const managed = () => ({ projectRoot: '/work/portal', state: 'initialized', steps: [], stop: null, receipt: null })
const offer = () => ({ projectRoot: '/work/portal', state: 'not_initialized', steps: [], stop: null, receipt: null })
const item = (key, title, status, extra = {}) => ({ key, title, status, ready: extra.ready === true, blocker: extra.blocker ?? null, active_claims: extra.claimed ? [{}] : [], archived: false, next_action: extra.next ?? null, source_ref: { locator: 'file:///work/portal/docs/work-ledger.yaml', pointer: `/work_items/${key}` } })
const snapshot = () => ({
  version: 1,
  project_revision: 12,
  basis: { source_refresh_performed: false },
  work_graph: {
    nodes: [
      item('A-1', 'Design the data model', 'completed'),
      item('A-2', 'Build the upload endpoint', 'in_progress', { claimed: true, next: 'Add chunked uploads' }),
      item('A-3', 'Index the documents', 'planned'),
      item('A-4', 'Set who can see what', 'planned', { blocker: 'The owner has to decide about interns' }),
      item('B-1', 'Write the user guide', 'planned', { ready: true }),
      item('B-2', 'Launch checklist', 'planned'),
      item('B-3', 'Set up the test environment', 'completed'),
    ],
    edges: [
      { from: 'A-2', to: 'A-1', required: true },
      { from: 'A-3', to: 'A-2', required: true },
      { from: 'A-4', to: 'A-2', required: true },
      { from: 'B-2', to: 'B-1', required: true },
      { from: 'B-2', to: 'A-3', required: true },
    ],
    cycle: [],
    graph_valid: true,
  },
  nav: {
    project: { name: 'Portal', id: 'P1' },
    mainline_graph: { nodes: [{ work_key: 'A-2', outcomes: ['A PDF can be uploaded', 'A failed upload can be retried'], explainable_waits: [] }, { work_key: 'A-3', outcomes: [], explainable_waits: [{ reason: 'dependency' }] }] },
  },
  goals: { hits: [{ external_key: 'g1', title: 'Everyone can find a document', status: 'active' }, { external_key: 'g2', title: 'Search answers in a second', status: 'candidate' }] },
  sessions: { sessions: [] },
})
const progress = () => buildProgress(snapshot())
const page = async (options = {}) => {
  const client = loadClient({ view: managed, progress, ...options })
  const ui = await client.page()
  return { client, ui }
}
const cards = (ui) => ui.all((node) => node.props['data-key'] !== undefined)
const keys = (ui) => cards(ui).map((node) => node.props['data-key'])
const mode = async (ui, name) => {
  await ui.click(`awr-mode-${name}`)
  await settle()
}

test('a page opened on data written a moment ago asks the host nothing and shows the project', async () => {
  const { client, ui } = await page()
  assert.deepEqual(client.calls, [], 'no command, so nothing in the conversation')
  const text = ui.text()
  assert.match(text, /Project progress/)
  assert.match(text, /Portal · Goal: Everyone can find a document and 1 more/)
  assert.match(textOf(ui.byTestId('awr-gauge')), /2\/ 7 done.*29%/)
  assert.match(textOf(ui.byTestId('awr-updated')), /^Updated \d\d:\d\d$/)
  assert.ok(client.reads.some((read) => read.path === progressPath('conv-1', '/Users/test')), 'the file the host writes is the one that is read')
})

test('the gauge has one part for each state that occurs, and the legend counts them', async () => {
  const { ui } = await page()
  const parts = ui.all((node) => node.props['data-part']).map((node) => [node.props['data-part'], node.props.style.flex])
  assert.deepEqual(parts, [['done', '2 0 0'], ['active', '1 0 0'], ['blocked', '1 0 0'], ['waiting', '1 0 0'], ['ready', '1 0 0'], ['planned', '1 0 0']])
  const legend = Object.fromEntries(ui.all((node) => node.props['data-legend']).map((node) => [node.props['data-legend'], textOf(node)]))
  assert.deepEqual(legend, { active: 'In progress1', blocked: 'Blocked1', waiting: 'Waiting1', ready: 'Ready1', planned: 'Not started1', done: 'Done2' })
})

test('what needs the person is listed above the work: what is stuck with its reason, and goals nobody confirmed', async () => {
  const { ui } = await page()
  const needs = textOf(ui.byTestId('awr-page-needs'))
  assert.match(needs, /Needs you2/)
  assert.match(needs, /Set who can see what.*The owner has to decide about interns/)
  assert.match(needs, /Search answers in a second.*This goal is not confirmed yet/)
})

test('while AWR cannot start work in an incomplete project, nothing is called ready and the page says what is missing', async () => {
  const incomplete = { organization: { ready: false, gaps: 8 }, in_progress: [], ready: [], blocked: [] }
  const { ui } = await page({ work: () => incomplete })
  const legend = Object.fromEntries(ui.all((node) => node.props['data-legend']).map((node) => [node.props['data-legend'], textOf(node)]))
  assert.deepEqual(legend, { active: 'In progress1', blocked: 'Blocked1', waiting: 'Waiting1', planned: 'Not started2', done: 'Done2' }, 'what the graph called ready is not started')
  assert.equal(ui.find((node) => node.props['data-key'] === 'B-1').props['data-state'], 'planned')
  const needs = textOf(ui.byTestId('awr-page-needs'))
  assert.match(needs, /Needs you3/)
  assert.match(needs, /The project is not complete yet.*Details are missing \(8\); work cannot start until they are filled in/, 'the first thing, before the work that is stuck')
  assert.ok(needs.indexOf('The project is not complete yet') < needs.indexOf('Set who can see what'))
  // A project that is complete, or one whose state is not known yet, shows the graph as it is.
  for (const work of [() => ({ organization: { ready: true, gaps: 0 }, in_progress: [], ready: [], blocked: [] }), () => undefined]) {
    const other = await page({ work })
    assert.match(textOf(other.ui.byTestId('awr-gauge')), /Ready1/)
    assert.ok(!textOf(other.ui.byTestId('awr-page-needs')).includes('not complete'))
  }
})

test('by mainline: each with how far it is, the work that is left as cards, and the finished work folded', async () => {
  const { ui } = await page()
  const lanes = ui.all((node) => node.props['data-lane']).map((node) => node.props['data-lane'])
  assert.deepEqual(lanes, ['A', 'B'])
  assert.match(textOf(ui.find((node) => node.props['data-lane'] === 'A')), /A1 \/ 4/)
  assert.deepEqual(keys(ui), ['A-2', 'A-4', 'A-3', 'B-1', 'B-2'], 'what moves first, then what is stuck, then the rest; finished work is not drawn')
  const done = ui.find((node) => node.props['data-done-toggle'] === 'A')
  assert.match(textOf(done), /1 done/)
  await ui.click(done)
  assert.ok(keys(ui).includes('A-1'), 'the finished work of that mainline is shown on request')
  assert.ok(!keys(ui).includes('B-3'), 'and only of that one')
})

test('the default view names no identifier: keys and source files are folded inside a card\'s details', async () => {
  const { ui } = await page()
  for (const hidden of ['A-2', 'A-4', 'B-1', 'work-ledger.yaml', 'revision']) assert.ok(!ui.text().includes(hidden), `${hidden} is not shown by default`)
  await ui.click(cards(ui).find((node) => node.props['data-key'] === 'A-2'))
  const detail = ui.byTestId('awr-detail')
  const text = textOf(detail)
  assert.match(text, /In progress· A conversation is working on it/)
  assert.match(text, /Build the upload endpoint/)
  assert.match(text, /NextAdd chunked uploads/)
  assert.match(text, /Done whenA PDF can be uploadedA failed upload can be retried/)
  assert.match(text, /Depends onDesign the data model/)
  assert.match(text, /UnlocksIndex the documentsSet who can see what/)
  assert.ok(!text.includes('A-2') && !text.includes('work-ledger.yaml'), 'the identifiers stay folded')
  await ui.click(ui.find((node) => node.type === 'button' && textOf(node) === 'Technical details'))
  assert.match(textOf(ui.byTestId('awr-detail')), /Work keyA-2.*Recorded inwork-ledger\.yaml \/work_items\/A-2/)
})

test('the details follow a link to another piece of work, and Escape or Close puts them away', async () => {
  const { client, ui } = await page()
  await ui.click(cards(ui).find((node) => node.props['data-key'] === 'A-4'))
  assert.match(textOf(ui.byTestId('awr-detail')), /Blocked byThe owner has to decide about interns/)
  await ui.click(ui.find((node) => node.type === 'button' && textOf(node) === 'Build the upload endpoint' && node.props.className === 'awr-link'))
  assert.match(textOf(ui.byTestId('awr-detail')), /Add chunked uploads/, 'the dependency is now the one shown')
  await client.press('Escape')
  assert.equal(ui.byTestId('awr-detail'), undefined)
  await ui.click(cards(ui)[0])
  await ui.click(ui.find((node) => node.props['aria-label'] === 'Close'))
  assert.equal(ui.byTestId('awr-detail'), undefined)
})

test('the three views are tabs: one stop in the Tab order, and the arrow keys, Home and End move between them', async () => {
  const { ui } = await page()
  const tab = (name) => ui.byId(`awr-mode-${name}`).props
  const state = () => ['lines', 'graph', 'lanes'].map((name) => [tab(name)['aria-selected'], tab(name).tabIndex])
  assert.deepEqual(state(), [[true, 0], [false, -1], [false, -1]], 'only the open view is a stop of the Tab key')
  assert.equal(await ui.keyDown('awr-mode-lines', 'ArrowRight'), true, 'the key is taken, so the page does not scroll')
  assert.ok(ui.byTestId('awr-view-graph'))
  assert.deepEqual(state(), [[false, -1], [true, 0], [false, -1]])
  await ui.keyDown('awr-mode-graph', 'ArrowRight')
  assert.ok(ui.byTestId('awr-view-lanes'))
  await ui.keyDown('awr-mode-lanes', 'ArrowRight')
  assert.ok(ui.byTestId('awr-view-lines'), 'after the last view comes the first')
  await ui.keyDown('awr-mode-lines', 'ArrowLeft')
  assert.ok(ui.byTestId('awr-view-lanes'), 'before the first view comes the last')
  await ui.keyDown('awr-mode-lanes', 'Home')
  assert.ok(ui.byTestId('awr-view-lines'))
  await ui.keyDown('awr-mode-lines', 'End')
  assert.ok(ui.byTestId('awr-view-lanes'))
  assert.equal(await ui.keyDown('awr-mode-lanes', 'Tab'), false, 'any other key is left to the browser')
  assert.ok(ui.byTestId('awr-view-lanes'))
})

test('the dependency view places what is left in layers and draws a line for each dependency between shown work', async () => {
  const { ui } = await page()
  await mode(ui, 'graph')
  const placed = Object.fromEntries(cards(ui).filter((node) => node.props.style?.position === 'absolute').map((node) => [node.props['data-key'], node.props.style.left]))
  assert.deepEqual(Object.keys(placed).sort(), ['A-2', 'A-3', 'A-4', 'B-1', 'B-2'], 'all five are part of a chain')
  assert.equal(placed['A-2'], 0, 'what depends on nothing shown is the first column')
  assert.ok(placed['A-3'] > placed['A-2'] && placed['B-2'] > placed['A-3'], 'a dependent is to the right of what it depends on')
  const edges = ui.all((node) => node.props['data-edge']).map((node) => node.props['data-edge']).sort()
  assert.deepEqual(edges, ['A-2>A-3', 'A-2>A-4', 'A-3>B-2', 'B-1>B-2'], 'the line to the finished A-1 is not drawn while finished work is folded')
  await ui.click('awr-show-done')
  await settle()
  assert.ok(ui.all((node) => node.props['data-edge']).some((node) => node.props['data-edge'] === 'A-1>A-2'), 'finished work brings its lines with it')
  assert.match(textOf(ui.byTestId('awr-view-graph')), /Work with no dependencies1/, 'B-3 has none and is listed apart')
})

test('pointing at a card picks out its chain: the rest is dimmed, the lines of the chain are drawn stronger', async () => {
  const { ui } = await page()
  await mode(ui, 'graph')
  const card = (key) => cards(ui).find((node) => node.props['data-key'] === key)
  card('A-4').props.onMouseEnter()
  await settle()
  assert.equal(card('A-4').props['data-dim'], undefined)
  assert.equal(card('A-2').props['data-dim'], undefined, 'what it depends on is part of the chain')
  assert.equal(card('B-1').props['data-dim'], 'true', 'unrelated work is dimmed')
  const edge = (id) => ui.find((node) => node.props['data-edge'] === id)
  assert.equal(edge('A-2>A-4').props['data-hot'], 'true')
  assert.equal(edge('B-1>B-2').props['data-dim'], 'true')
  card('A-4').props.onMouseLeave()
  await settle()
  assert.equal(card('B-1').props['data-dim'], undefined)
})

test('the lanes view puts the mainlines side by side, each in dependency order, with the lines between them', async () => {
  const { ui } = await page()
  await mode(ui, 'lanes')
  const heads = ui.all((node) => node.props['data-lane-head']).map((node) => [node.props['data-lane-head'], textOf(node)])
  assert.deepEqual(heads, [['A', 'A1 / 4'], ['B', 'B1 / 3']])
  const place = Object.fromEntries(cards(ui).map((node) => [node.props['data-key'], [node.props.style.left, node.props.style.top]]))
  assert.equal(place['A-2'][0], place['A-3'][0], 'one column for a mainline')
  assert.ok(place['B-1'][0] > place['A-2'][0])
  assert.ok(place['A-3'][1] > place['A-2'][1], 'a dependent is below what it depends on')
  const cross = ui.find((node) => node.props['data-edge'] === 'A-3>B-2')
  assert.equal(cross.props['data-soft'], 'true', 'a line between mainlines is drawn differently')
})

test('the legend and the search narrow the work down, and say so when nothing matches', async () => {
  const { ui } = await page()
  await ui.click(ui.find((node) => node.props['data-legend'] === 'blocked'))
  assert.deepEqual(keys(ui), ['A-4'])
  await ui.click(ui.find((node) => node.props['data-legend'] === 'done'))
  assert.deepEqual(keys(ui).sort(), ['A-1', 'B-3'], 'asking for finished work shows it without the switch')
  await ui.click(ui.find((node) => node.props['data-legend'] === 'done'))
  ui.byId('awr-search').props.onChange({ target: { value: '  UPLOAD ' } })
  await settle()
  assert.deepEqual(keys(ui), ['A-2'], 'by title, whatever the case')
  ui.byId('awr-search').props.onChange({ target: { value: 'b-1' } })
  await settle()
  assert.deepEqual(keys(ui), ['B-1'], 'the key finds it too, without being shown')
  ui.byId('awr-search').props.onChange({ target: { value: 'nothing like this' } })
  await settle()
  assert.match(ui.text(), /No work matches/)
})

test('data that is missing, older than a minute or written by another version makes the host write it', async () => {
  for (const files of ['none', 'stale']) {
    const { client, ui } = await page({ files })
    assert.ok(client.calls.includes('/awr progress --ui en'), files)
    assert.ok(ui.byTestId('awr-gauge'), `${files}: and then the page shows it`)
  }
  const old = loadClient({ view: managed, progress })
  old.files.set(old.progressFile, JSON.stringify({ ok: true, updatedAt: old.clock.now, nodes: [], counts: {}, laneCount: 1 }))
  const ui = await old.page()
  assert.deepEqual(old.calls, ['/awr progress --ui en'], 'a view of another shape is taken for no view')
  assert.ok(ui.byTestId('awr-gauge'))
})

test('Refresh asks the host once; Sync has AWR read the project\'s files first', async () => {
  const { client, ui } = await page()
  await ui.click('awr-page-refresh')
  await ui.click('awr-page-sync')
  assert.deepEqual(client.calls, ['/awr progress --ui en', '/awr progress refresh --ui en'])
})

test('the page reads the file every 5 s without a command, and asks the host once a minute', async () => {
  const { client, ui } = await page()
  assert.ok(client.timers().includes(5000))
  let current = progress()
  const changed = loadClient({ view: managed, progress: () => current })
  const live = await changed.page()
  current = { ...current, counts: { ...current.counts, done: 5 } }
  changed.host.publishProgress()
  await changed.fire(5000)
  assert.match(textOf(live.byTestId('awr-gauge')), /^5\/ 7 done/, 'what the host wrote is shown')
  assert.deepEqual(changed.calls, [], 'and no command was run for it')
  for (let round = 0; round < 12; round += 1) await client.fire(5000)
  assert.deepEqual(client.calls, [], 'a minute of reading, and no command')
  await client.fire(5000)
  assert.deepEqual(client.calls, ['/awr progress --ui en'], 'then the host is asked once')
  for (let round = 0; round < 5; round += 1) await client.fire(5000)
  assert.equal(client.calls.length, 1, 'and not again until another minute has passed')
  assert.ok(ui.byTestId('awr-gauge'))
})

test('a project AWR does not manage gets the offer on the page too, and no progress is asked for', async () => {
  let current = offer()
  const client = loadClient({ view: () => current, progress, files: 'none', answer: (line) => { if (line.startsWith('/awr takeover')) current = { ...offer(), state: 'running', steps: [{ name: 'preflight', status: 'running' }] }; return 'ok' } })
  const ui = await client.page()
  assert.match(textOf(ui.byTestId('awr-offer')), /Let AWR keep track of this project/)
  assert.deepEqual(client.calls, ['/awr panel --ui en'], 'the state of the project is asked for; its progress is not, while there is none to show')
  await ui.click('awr-takeover-start')
  assert.deepEqual(client.calls, ['/awr panel --ui en', '/awr takeover --ui en'])
  assert.ok(ui.byTestId('awr-running'), 'the page follows the takeover')
  current = managed()
  client.host.publish()
  await client.fire(2500)
  await settle(6)
  assert.ok(ui.byTestId('awr-gauge'), 'and shows the project once AWR manages it')
})

test('an awr that is too old, a failure and a project with no work are each said plainly', async () => {
  const old = await page({ progress: () => ({ ok: false, reason: 'unsupported', updatedAt: 1 }) })
  assert.match(old.ui.text(), /awr needs an update.*too old to draw the progress/)
  const failed = await page({ progress: () => ({ ok: false, reason: 'failed', message: 'the database is locked', updatedAt: 1 }) })
  assert.match(failed.ui.text(), /The progress could not be read just now/)
  assert.ok(!failed.ui.text().includes('database is locked'), 'the raw message is folded')
  await failed.ui.click(failed.ui.find((node) => node.type === 'button' && textOf(node) === 'Try again'))
  assert.ok(failed.client.calls.includes('/awr progress --ui en'))
  const empty = await page({ progress: () => buildProgress({ ...snapshot(), work_graph: { nodes: [], edges: [], cycle: [], graph_valid: true } }) })
  assert.match(empty.ui.text(), /No work is recorded yet/)
})

test('an awr too old for the page offers to install the bundled one, which draws the page (DSH-067)', async () => {
  let ready = false
  const { client, ui } = await page({
    progress: () => (ready
      ? progress()
      : { ok: false, reason: 'unsupported', updatedAt: 1, installer: { state: 'none', target: 'darwin-arm64', check: { checkedAt: 1, latest: '0.7.0', asset: 'x', available: true } } }),
    answer: (line) => {
      if (line.startsWith('/awr runtime')) { ready = true; return 'Installed awr 0.7.0 and bound this project to it.' }
      return 'ok'
    },
  })
  assert.match(ui.text(), /too old to draw the progress/)
  assert.equal(textOf(ui.byTestId('awr-page-runtime-install')), 'Install awr 0.7.0 to draw the progress')
  await ui.click('awr-page-runtime-install')
  await settle(4)
  assert.ok(client.calls.includes('/awr runtime install --use --ui en'), 'the bundled awr is installed and bound')
  assert.ok(client.calls.includes('/awr progress --ui en'), 'and the page reads again')
  assert.ok(ui.byTestId('awr-gauge'), 'and draws the project with the new awr')
})

test('an awr too old for the page, with the bundled one already installed, offers to use it', async () => {
  const { ui } = await page({
    progress: () => ({ ok: false, reason: 'unsupported', updatedAt: 1, installer: { state: 'installed', version: '0.7.0', cli: '/state/runtime/awr-0.7.0-darwin-arm64/bin/awr' } }),
  })
  assert.equal(textOf(ui.byTestId('awr-page-runtime-install')), 'Use the bundled awr 0.7.0')
})

test('the zoom of the graph views steps between 30% and 150%, and Fit sizes it to the window', async () => {
  const { ui } = await page()
  assert.equal(ui.byTestId('awr-zoom'), undefined, 'the mainline view has no zoom')
  await mode(ui, 'graph')
  assert.equal(textOf(ui.byTestId('awr-zoom')), '100%')
  await ui.click(ui.find((node) => node.props['aria-label'] === 'Zoom out'))
  assert.equal(textOf(ui.byTestId('awr-zoom')), '90%')
  for (let round = 0; round < 10; round += 1) {
    const button = ui.find((node) => node.props['aria-label'] === 'Zoom in')
    if (button.props.disabled) break
    await ui.click(button)
  }
  assert.equal(textOf(ui.byTestId('awr-zoom')), '150%')
  await ui.click(ui.find((node) => node.props['aria-label'] === 'Fit to window'))
  assert.equal(textOf(ui.byTestId('awr-zoom')), '100%', 'the graph is 720 wide and the window 900: it fits as it is')
})

test('in Chinese the page is Chinese, and the commands ask the host for Chinese', async () => {
  const { client, ui } = await page({ language: 'zh', files: 'none' })
  assert.deepEqual(client.calls.filter((line) => line.startsWith('/awr progress')), ['/awr progress --ui zh'])
  assert.match(ui.text(), /项目进展/)
  assert.match(ui.text(), /需要你处理/)
  assert.match(ui.text(), /主线.*依赖.*泳道/)
  assert.equal(client.slots['conversation.view'].options.label(), '进展')
})

test('a file that says there was nothing to draw is not taken for the answer once AWR manages the project', async () => {
  let current = { ok: false, reason: 'not_managed', updatedAt: 1 }
  const client = loadClient({ view: managed, progress: () => current })
  current = progress()
  const ui = await client.page()
  assert.deepEqual(client.calls, ['/awr progress --ui en'], 'the host is asked, although the file was written a moment ago')
  assert.ok(ui.byTestId('awr-gauge'))
})

test('the header light and the page show the same project: what one reads, the other shows', async () => {
  let current = offer()
  const client = loadClient({ view: () => current, progress })
  const chip = await client.chip()
  const light = () => chip.find((node) => node.props['data-light'] !== undefined).props['data-light']
  assert.equal(light(), 'ready')
  current = { ...offer(), state: 'running', steps: [{ name: 'preflight', status: 'running' }] }
  client.host.publish()
  const ui = await client.page()
  assert.ok(ui.byTestId('awr-running'))
  assert.equal(light(), 'active', 'the light follows what the page read, without a read of its own')
  current = managed()
  client.host.publish()
  await client.fire(2500)
  assert.equal(light(), 'good')
})
